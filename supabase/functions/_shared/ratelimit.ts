import { SupabaseClient } from "npm:@supabase/supabase-js@2";

/**
 * Check if an IP has exceeded the rate limit for an endpoint.
 * Returns true if the request is allowed, false if it should be blocked.
 *
 * @param sb         Service-role Supabase client
 * @param req        Incoming Request (reads CF-Connecting-IP / X-Forwarded-For)
 * @param endpoint   Short identifier, e.g. "otp", "payment-order"
 * @param maxReqs    Max requests allowed in the window
 * @param windowSec  Window size in seconds
 */
export async function checkRateLimit(
  sb: SupabaseClient,
  req: Request,
  endpoint: string,
  maxReqs: number,
  windowSec: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const ip = getIp(req);
  if (!ip) return { allowed: true, remaining: maxReqs }; // can't determine IP — allow

  const windowStart = floorToWindow(windowSec);

  try {
    // Upsert: increment count or create new row for this (ip, endpoint, window).
    const { data, error } = await sb.rpc("upsert_rate_limit", {
      p_ip: ip,
      p_endpoint: endpoint,
      p_window_start: windowStart,
      p_max: maxReqs,
    });
    if (error) {
      console.error("[ratelimit] rpc error:", error.message);
      return { allowed: true, remaining: maxReqs }; // fail open — don't block legit users on DB error
    }
    const count = (data as number) ?? 1;
    return { allowed: count <= maxReqs, remaining: Math.max(0, maxReqs - count) };
  } catch (e) {
    console.error("[ratelimit] error:", (e as Error).message);
    return { allowed: true, remaining: maxReqs };
  }
}

function getIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    ""
  );
}

function floorToWindow(windowSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const floored = now - (now % windowSec);
  return new Date(floored * 1000).toISOString();
}
