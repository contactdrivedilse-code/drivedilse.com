-- Rate limiting table for edge function IP-based throttling.
-- Each row tracks request count for a (ip, endpoint) pair within a time window.
-- Old windows are cleaned up by the edge function itself (no cron needed).

CREATE TABLE IF NOT EXISTS public.rate_limits (
  id           bigserial PRIMARY KEY,
  ip           text        NOT NULL,
  endpoint     text        NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer     NOT NULL DEFAULT 1,
  UNIQUE (ip, endpoint, window_start)
);

-- Only the service role (edge functions) touches this table.
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.rate_limits
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Fast lookup by ip + endpoint + window
CREATE INDEX IF NOT EXISTS rate_limits_lookup ON public.rate_limits (ip, endpoint, window_start);

-- Auto-delete rows older than 1 day to keep the table small
CREATE OR REPLACE FUNCTION public.cleanup_rate_limits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.rate_limits WHERE window_start < now() - interval '1 day';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER rate_limits_cleanup
  AFTER INSERT ON public.rate_limits
  FOR EACH STATEMENT EXECUTE FUNCTION public.cleanup_rate_limits();
