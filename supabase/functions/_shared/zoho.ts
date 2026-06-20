// Zoho Books integration — used to auto-raise an invoice when a trip ends.
// All amounts are treated as already-final (GST + fees baked in); we do not
// touch Zoho's own tax engine, we just list a readable breakdown of line
// items whose sum equals the amount actually collected via Razorpay.

const ACCOUNTS_DOMAIN = Deno.env.get("ZOHO_ACCOUNTS_DOMAIN") || "https://accounts.zoho.in";
const API_DOMAIN       = Deno.env.get("ZOHO_API_DOMAIN")      || "https://www.zohoapis.in";
const ORG_ID           = Deno.env.get("ZOHO_ORG_ID")!;
// Zoho silently applies the contact's default GST tax (e.g. 12%) on top of
// any line item that doesn't specify a tax_id — even though our amounts
// already have GST baked in as a plain line item. Explicitly pinning every
// line item to the org's 0%/exempt tax group ("GST0") prevents that
// double-taxation. Confirmed via live test: without this, a ₹118 invoice
// came out as ₹132.16 (118 × 1.12).
const ZERO_TAX_ID = Deno.env.get("ZOHO_ZERO_TAX_ID")!;

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
  const created = await zohoFetch(`/contacts`, {
    method: "POST",
    body: JSON.stringify({
      contact_name: name || phone || "DriveDilSe Guest",
      contact_persons: email ? [{ email, is_primary_contact: true }] : [],
      phone: phone || undefined,
    }),
  });
  const contact = created.contact as Record<string, unknown>;
  return contact.contact_id as string;
}

export interface ZohoLineItem { name: string; rate: number; }

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
      line_items: lineItems.map((li) => ({ name: li.name, rate: li.rate, quantity: 1, tax_id: ZERO_TAX_ID })),
    }),
  });
  const invoice = created.invoice as Record<string, unknown>;
  return { invoiceId: invoice.invoice_id as string, total: invoice.total as number };
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

// Builds line items whose sum equals `booking.total` exactly, then creates
// the invoice and immediately records a matching payment (since the
// customer already paid via Razorpay at booking/checkout time).
export async function raiseInvoiceForBooking(booking: {
  bookingId: string; carName: string; customer: string; phone: string; email: string;
  base: number; gst: number; deliveryFee: number; couponDiscount: number; total: number;
  days: number; extensions: { hours: number; cost: number }[]; checkedOutAt: string;
}): Promise<{ invoiceId: string }> {
  const contactId = await findOrCreateContact(booking.customer, booking.phone, booking.email);

  const lineItems: ZohoLineItem[] = [
    { name: `${booking.carName} rental — ${booking.days} day(s)`, rate: booking.base },
    { name: "GST @ 18%", rate: booking.gst },
  ];
  if (booking.deliveryFee > 0) lineItems.push({ name: "Doorstep Delivery Fee", rate: booking.deliveryFee });
  if (booking.couponDiscount > 0) lineItems.push({ name: "Coupon Discount", rate: -booking.couponDiscount });
  booking.extensions.forEach((e, i) => {
    lineItems.push({ name: `Extension #${i + 1} (+${e.hours}hr, incl. GST)`, rate: e.cost });
  });

  const { invoiceId } = await createInvoice(contactId, lineItems, booking.bookingId);
  await recordPayment(contactId, invoiceId, booking.total, booking.checkedOutAt);
  return { invoiceId };
}
