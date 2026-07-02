// Owner addresses that receive a copy of every booking confirmation.
const OWNER_EMAILS = ["pavanmarkad180@gmail.com", "contact.drivedilse@gmail.com"];

// Thin wrapper around the Resend API, shared by every function that sends transactional email.
export async function sendEmail(to: string | string[], subject: string, html: string): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const recipients = Array.isArray(to) ? to : [to];
  if (!apiKey) { console.log(`[EMAIL] ${recipients.join(", ")} → ${subject}`); return; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "DriveDilSe <info@drivedilse.com>", to: recipients, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to send email (${res.status}): ${body}`);
  }
}

export const SUPPORT_INBOX = "info@drivedilse.com";

// Fired the instant a booking actually becomes "confirmed" — either right
// at checkout (KYC already verified) or later when admin approves KYC for
// a pending_kyc booking. Always called best-effort/non-blocking by callers.
export async function sendBookingConfirmationEmail(opts: {
  to: string; customerName: string; bookingId: string; carName: string;
  pickupDate: string; dropDate: string; pickupLocation: string; total: number;
  customerPhone?: string;
}): Promise<void> {
  const fmt = (iso: string) => new Date(iso).toLocaleString("en-IN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
  });

  // ── Customer email ────────────────────────────────────────────────────────
  const customerHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
    <h2 style="color:#161616">DriveDilSe</h2>
    <p>Hi ${escapeHtml(opts.customerName || "there")}, your booking is confirmed! 🎉</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
      <tr><td style="color:#888;padding:4px 0">Booking ID</td><td style="text-align:right;font-weight:700">${escapeHtml(opts.bookingId)}</td></tr>
      <tr><td style="color:#888;padding:4px 0">Car</td><td style="text-align:right;font-weight:700">${escapeHtml(opts.carName)}</td></tr>
      <tr><td style="color:#888;padding:4px 0">Pickup</td><td style="text-align:right">${fmt(opts.pickupDate)}</td></tr>
      <tr><td style="color:#888;padding:4px 0">Drop</td><td style="text-align:right">${fmt(opts.dropDate)}</td></tr>
      <tr><td style="color:#888;padding:4px 0">Location</td><td style="text-align:right">${escapeHtml(opts.pickupLocation)}</td></tr>
      <tr><td style="color:#888;padding:4px 0;border-top:1px solid #eee">Total Paid</td><td style="text-align:right;font-weight:800;border-top:1px solid #eee">₹${Number(opts.total).toLocaleString("en-IN")}</td></tr>
    </table>
    <p style="color:#666;font-size:13px">Check-in opens 30 minutes before pickup from the My Trips page on drivedilse.com. See you soon!</p>
  </div>`;
  await sendEmail(opts.to, `Booking Confirmed — ${opts.bookingId} | DriveDilSe`, customerHtml);

  // ── Owner notification (both owner addresses in one email) ────────────────
  const ownerHtml = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto">
    <h2 style="color:#161616;margin-bottom:4px">New Booking Confirmed 🚗</h2>
    <p style="color:#555;font-size:13px;margin-top:0">DriveDilSe — ${new Date().toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Kolkata"})}</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
      <tr style="background:#f5f5f5"><td style="padding:8px 10px;font-weight:700;color:#333">Booking ID</td><td style="padding:8px 10px;font-weight:800;color:#d4a000">${escapeHtml(opts.bookingId)}</td></tr>
      <tr><td style="padding:8px 10px;color:#555">Customer</td><td style="padding:8px 10px;font-weight:600">${escapeHtml(opts.customerName || "—")}</td></tr>
      ${opts.customerPhone ? `<tr style="background:#f5f5f5"><td style="padding:8px 10px;color:#555">Phone</td><td style="padding:8px 10px;font-weight:600">${escapeHtml(opts.customerPhone)}</td></tr>` : ""}
      <tr${opts.customerPhone ? "" : ' style="background:#f5f5f5"'}><td style="padding:8px 10px;color:#555">Car</td><td style="padding:8px 10px;font-weight:600">${escapeHtml(opts.carName)}</td></tr>
      <tr style="background:#f5f5f5"><td style="padding:8px 10px;color:#555">Pickup</td><td style="padding:8px 10px">${fmt(opts.pickupDate)}</td></tr>
      <tr><td style="padding:8px 10px;color:#555">Drop</td><td style="padding:8px 10px">${fmt(opts.dropDate)}</td></tr>
      <tr style="background:#f5f5f5"><td style="padding:8px 10px;color:#555">Location</td><td style="padding:8px 10px">${escapeHtml(opts.pickupLocation)}</td></tr>
      <tr style="border-top:2px solid #f5c518"><td style="padding:10px;font-weight:700">Total Paid</td><td style="padding:10px;font-weight:900;font-size:16px;color:#161616">₹${Number(opts.total).toLocaleString("en-IN")}</td></tr>
    </table>
    <p style="color:#888;font-size:12px">This is an automated alert from drivedilse.com</p>
  </div>`;
  await sendEmail(OWNER_EMAILS, `[New Booking] ${opts.bookingId} — ${escapeHtml(opts.customerName || "Guest")} | DriveDilSe`, ownerHtml);
}

// Escape user-supplied text before interpolating into email HTML —
// ticket name/message/reply text all originate from public, unauthenticated input.
export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
