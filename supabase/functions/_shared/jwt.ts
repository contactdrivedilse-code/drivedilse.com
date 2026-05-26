import { create, verify as djwtVerify, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

async function makeKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  expirySeconds: number,
): Promise<string> {
  const key = await makeKey(secret);
  return create(
    { alg: "HS256", typ: "JWT" },
    { ...payload, exp: getNumericDate(expirySeconds) },
    key,
  );
}

export async function verifyJwt(
  token: string,
  secret: string,
): Promise<Record<string, unknown>> {
  const key = await makeKey(secret);
  return djwtVerify(token, key) as Promise<Record<string, unknown>>;
}

export function getBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}
