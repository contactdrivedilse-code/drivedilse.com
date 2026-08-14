CREATE TABLE IF NOT EXISTS public.blacklist (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL UNIQUE,
  reason        text,
  blacklisted_at timestamptz NOT NULL DEFAULT now(),
  blacklisted_by text DEFAULT 'admin'
);

ALTER TABLE public.blacklist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access" ON public.blacklist
  FOR ALL USING (true) WITH CHECK (true);
