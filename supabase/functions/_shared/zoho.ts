// Zoho Books integration — used to auto-raise an invoice when a trip ends.
// The main "Booking Fee" line carries the real GST18 tax group (CGST 9% +
// SGST 9%), so Zoho's own tax columns show the actual 18% breakdown. Every
// other line (delivery fee, coupon discount, extensions) is pinned to the
// org's 0% tax group, since those amounts either aren't taxed by us or
// already have their own GST baked into the figure — without pinning them
// to 0%, Zoho silently applies the contact's default tax on top of them too
// (confirmed live: a ₹118 charge came out as ₹132.16 before this was fixed).

const ACCOUNTS_DOMAIN = Deno.env.get("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.in";
const API_DOMAIN       = Deno.env.get("ZOHO_API_DOMAIN")      || "https://www.zohoapis.in";
const ORG_ID           = Deno.env.get("ZOHO_ORG_ID")!;
const ZERO_TAX_ID  = Deno.env.get("ZOHO_ZERO_TAX_ID")!;
const GST18_TAX_ID = Deno.env.get("ZOHO_GST18_TAX_ID")!;

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${ACCOUNTS_DOMAIN}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: Deno.env.get("ZOHO_CLIENT_ID")!,
      client_secret: Deno.env.get("ZOHO_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("ZOHO_REFRESH_TOKEN")!,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("Zoho auth failed: " + JSON.stringify(data));
  return data.access_token as string;
}

async function zohoFetch(path: string, opts: RequestInit = {}): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API_DOMAIN}/books/v3${path}${sep}organization_id=${ORG_ID}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      "Authorization": `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) throw new Error("Zoho API error: " + JSON.stringify(data));
  return data;
}

export async function findOrCreateContact(name: string, phone: string, email: string): Promise<string> {
  if (phone) {
    const search = await zohoFetch(`/contacts?phone=${encodeURIComponent(phone)}`);
    const contacts = search.contacts as Record<string, unknown>[] | undefined;
    if (contacts && contacts.length) return contacts[0].contact_id as string;
  }
  // Zoho requires contact_name to be unique across the whole org. Two
  // different customers can share a first name (confirmed live: creating
  // a second "abhay" with a different phone failed outright), so the
  // phone number is always appended to guarantee uniqueness.
  const baseName = name || "DriveDilSe Guest";
  const uniqueName = phone ? `${baseName} (${phone})` : baseName;
  const created = await zohoFetch(`/contacts`, {
    method: "POST",
    body: JSON.stringify({
      contact_name: uniqueName,
      contact_persons: email ? [{ email, is_primary_contact: true }] : [],
      phone: phone || undefined,
    }),
  });
  const contact = created.contact as Record<string, unknown>;
  return contact.contact_id as string;
}

export interface ZohoLineItem { name: string; rate: number; taxed?: boolean; }

// SAC code for car rental/leasing services — set explicitly on every line so
// it doesn't depend on Zoho's name-based auto-matching (confirmed live: the
// "Booking Fee" line picked it up automatically, but the extension line
// right next to it on the same invoice came out blank).
const RENTAL_SAC = "997329";

export async function createInvoice(
  contactId: string,
  lineItems: ZohoLineItem[],
  referenceNumber: string,
): Promise<{ invoiceId: string; total: number }> {
  const created = await zohoFetch(`/invoices`, {
    method: "POST",
    body: JSON.stringify({
      customer_id: contactId,
      reference_number: referenceNumber,
      line_items: lineItems.map((li) => ({
        name: li.name, rate: li.rate, quantity: 1, hsn_or_sac: RENTAL_SAC,
        tax_id: li.taxed ? GST18_TAX_ID : ZERO_TAX_ID,
      })),
    }),
  });
  const invoice = created.invoice as Record<string, unknown>;
  return { invoiceId: invoice.invoice_id as string, total: invoice.total as number };
}

export async function fetchInvoicePdf(invoiceId: string): Promise<ArrayBuffer> {
  const token = await getAccessToken();
  const url = `${API_DOMAIN}/books/v3/invoices/${invoiceId}?organization_id=${ORG_ID}&accept=pdf`;
  const res = await fetch(url, { headers: { "Authorization": `Zoho-oauthtoken ${token}` } });
  if (!res.ok) throw new Error("Zoho PDF fetch failed: " + (await res.text()));
  return await res.arrayBuffer();
}

export async function recordPayment(
  contactId: string,
  invoiceId: string,
  amount: number,
  paidAtIso: string,
): Promise<void> {
  await zohoFetch(`/customerpayments`, {
    method: "POST",
    body: JSON.stringify({
      customer_id: contactId,
      payment_mode: "Razorpay",
      amount,
      date: paidAtIso.slice(0, 10),
      invoices: [{ invoice_id: invoiceId, amount_applied: amount }],
    }),
  });
}

// Zoho's GST18 tax group is CGST 9% + SGST 9%, each rounded to paise
// independently — so naive rate*1.18 doesn't always land on the exact
// target total (confirmed live: rate=1 produced 1.18, but rate=0.85, the
// mathematically "correct" pre-tax value for a ₹1.00 target, produced
// ₹1.01 because 0.85*0.09 rounds to 0.08 on each side, not 0.075 split
// evenly). This solves for the rate that actually lands on target after
// Zoho's real rounding behaviour, searching a small window around the
// naive estimate.
function solveTaxedRate(targetTotal: number): number {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const totalFor = (rate: number) => {
    const half = round2(rate * 0.09);
    return round2(rate + half * 2);
  };
  const estimate = round2(targetTotal / 1.18);
  for (let steps = 0; steps <= 10; steps++) {
    for (const sign of [1, -1]) {
      if (steps === 0 && sign === -1) continue;
      const candidate = round2(estimate + sign * steps * 0.01);
      if (totalFor(candidate) === targetTotal) return candidate;
    }
  }
  return estimate; // fallback: closest we found, off by at most a paisa or two
}

// Builds line items whose sum equals `booking.total` exactly, then creates
// the invoice and immediately records a matching payment (since the
// customer already paid via Razorpay at booking/checkout time).
export async function raiseInvoiceForBooking(booking: {
  bookingId: string; carName: string; customer: string; phone: string; email: string;
  base: number; gst: number; deliveryFee: number; couponDiscount: number; total: number;
  days: number; extensions: { hours: number; cost: number }[]; checkedOutAt: string;
}): Promise<{ invoiceId: string; total: number }> {
  const contactId = await findOrCreateContact(booking.customer, booking.phone, booking.email);

  // Every chargeable line (booking fee, delivery fee, each extension) is
  // taxed at the real GST18 rate. Each one's pre-tax rate is individually
  // back-solved so its post-tax amount lands exactly on what that
  // component actually contributed to booking.total — e.g. an extension
  // line still shows its real cost after tax, not cost-plus-extra-tax.
  // Using one consistent tax group throughout also avoids ever mixing
  // different tax groups on one invoice (the original cause of duplicate
  // CGST/SGST rows in the tax summary).
  const lineItems: ZohoLineItem[] = [
    { name: "Booking Fee", rate: solveTaxedRate(booking.base + booking.gst), taxed: true },
  ];
  if (booking.deliveryFee > 0) {
    lineItems.push({ name: "Doorstep Delivery Fee", rate: solveTaxedRate(booking.deliveryFee), taxed: true });
  }
  if (booking.couponDiscount > 0) lineItems.push({ name: "Coupon Discount", rate: -booking.couponDiscount });
  booking.extensions.forEach((e, i) => {
    lineItems.push({ name: `Extension #${i + 1} (+${e.hours}hr)`, rate: solveTaxedRate(e.cost), taxed: true });
  });

  const { invoiceId, total } = await createInvoice(contactId, lineItems, booking.bookingId);
  await recordPayment(contactId, invoiceId, booking.total, booking.checkedOutAt);
  return { invoiceId, total };
}
