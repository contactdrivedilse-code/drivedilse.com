import { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Matches a stored Supabase public object URL:
//   https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<path>
const PUBLIC_RE = /\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/;

/**
 * Convert a stored public storage URL into a short-lived signed URL so that
 * private buckets (kyc, checkin) remain viewable in the admin panel and by the
 * owning customer, without exposing the objects to the public.
 *
 * - Non-storage URLs (or empty values) are returned unchanged.
 * - createSignedUrl works on public buckets too, so this is safe to deploy
 *   BEFORE flipping the buckets to private (zero downtime).
 */
export async function signStorageUrl(
  sb: SupabaseClient,
  url: string | null | undefined,
  expirySec = 60 * 60,
): Promise<string> {
  if (!url) return "";
  const m = url.match(PUBLIC_RE);
  if (!m) return url;
  const bucket = m[1];
  const path = decodeURIComponent(m[2].split("?")[0]);
  try {
    const { data } = await sb.storage.from(bucket).createSignedUrl(path, expirySec);
    return data?.signedUrl ?? "";
  } catch {
    return "";
  }
}
