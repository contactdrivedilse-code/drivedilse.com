async function hmacHex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// The signature Razorpay's client-side checkout hands back after a payment:
// HMAC-SHA256("orderId|paymentId") using the account's key secret.
export async function computeOrderPaymentSignature(orderId: string, paymentId: string, keySecret: string): Promise<string> {
  return hmacHex(`${orderId}|${paymentId}`, keySecret);
}

// The signature Razorpay sends in the x-razorpay-signature header on every
// webhook delivery: HMAC-SHA256 of the raw request body using the separate
// webhook secret configured in the Razorpay Dashboard (Settings → Webhooks).
export async function verifyWebhookSignature(rawBody: string, signature: string | null, webhookSecret: string): Promise<boolean> {
  if (!signature) return false;
  return (await hmacHex(rawBody, webhookSecret)) === signature;
}
