// Thin wrapper around the Resend API, shared by every function that sends transactional email.
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) { console.log(`[EMAIL] ${to} → ${subject}`); return; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "DriveDilSe <info@drivedilse.com>", to: [to], subject, html }),
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
}): Promise<void> {
  const fmt = (iso: string) => new Date(iso).toLocaleString("en-IN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
  });
  const html = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
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
  await sendEmail(opts.to, `Booking Confirmed — ${opts.bookingId} | DriveDilSe`, html);
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
