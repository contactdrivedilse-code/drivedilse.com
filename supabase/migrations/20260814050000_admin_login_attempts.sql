CREATE TABLE IF NOT EXISTS public.admin_login_attempts (
  key text PRIMARY KEY,
  count int NOT NULL DEFAULT 0,
  locked_until timestamptz
);
-- No RLS needed — only accessed via service role in edge functions.
