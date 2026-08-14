import { json, preflight } from "../_shared/cors.ts";

const SYSTEM = `You are a helpful assistant for DriveDilSe, a premium self-drive car rental platform in Pune, India.

Key facts:
- Self-drive only (no driver), cars available 24/7
- Located in Pune, Maharashtra
- Minimum booking: 6 hours
- Pricing is GST-inclusive, no hidden charges
- Damage deductible: â‚¹2,000 (only if new damage occurs)
- Doorstep delivery and pickup available
- Booking steps: Pick dates â†’ Choose car â†’ Pay online â†’ Upload Aadhaar + DL â†’ Get Check-In OTP at handover
- Contact: contact.drivedilse@gmail.com | WhatsApp: +91 99999 99999
- Discount tiers: 5% off (2-3 days), 8% (4-5 days), 10% (6-7 days), 15% (up to 14 days), 20% (up to 21 days), 25% (longer)
- Cars available: Hatchbacks, SUVs, MPVs â€” all well-maintained
- Cancellation and extensions supported from the profile page

Keep answers short, friendly, and helpful. If unsure, suggest contacting on WhatsApp.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);

  try {
    const { messages } = await req.json();
    if (!messages || !Array.isArray(messages)) return json({ error: "Invalid request" }, 400);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "AI not configured" }, 500);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: SYSTEM,
        messages: messages.slice(-10),
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "AI error");
    return json({ reply: data.content[0].text });
  } catch (e) {
    console.error("[500]", (e as Error).message);
    return json({ error: "Internal server error" }, 500);
  }
});

