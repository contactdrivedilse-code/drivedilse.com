const ALLOWED_ORIGINS = new Set(["https://drivedilse.com", "https://www.drivedilse.com"]);

export const corsHeaders = {
  "Access-Control-Allow-Origin": "https://drivedilse.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-token, x-admin-token",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Vary": "Origin",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Preflight echoes back the request's Origin if it is in the allow-list, so
// browsers from drivedilse.com (and www subdomain) both get approval.
export function preflight(req?: Request): Response {
  const origin = req?.headers.get("origin") ?? "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://drivedilse.com";
  return new Response("ok", {
    headers: { ...corsHeaders, "Access-Control-Allow-Origin": allowOrigin },
  });
}
