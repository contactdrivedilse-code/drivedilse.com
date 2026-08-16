-- Atomic upsert for rate limiting: increments count and returns new count.
-- Called from the ratelimit.ts shared utility in edge functions.
-- Returns the new count after incrementing (caller compares against max).

CREATE OR REPLACE FUNCTION public.upsert_rate_limit(
  p_ip           text,
  p_endpoint     text,
  p_window_start timestamptz,
  p_max          integer
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.rate_limits (ip, endpoint, window_start, count)
  VALUES (p_ip, p_endpoint, p_window_start, 1)
  ON CONFLICT (ip, endpoint, window_start)
  DO UPDATE SET count = rate_limits.count + 1
  RETURNING count INTO v_count;

  RETURN v_count;
END;
$$;

-- Only callable by the service role (edge functions use service_role client).
REVOKE ALL ON FUNCTION public.upsert_rate_limit FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_rate_limit TO service_role;
