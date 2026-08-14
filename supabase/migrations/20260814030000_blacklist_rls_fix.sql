-- Drop the open-access policy and replace with deny-all for anon/authenticated roles.
-- Edge functions use the service role key and bypass RLS entirely, so they still work.
DROP POLICY IF EXISTS "Admin full access" ON public.blacklist;

-- No SELECT/INSERT/UPDATE/DELETE allowed for anon or authenticated JWT users directly.
-- All access goes through the edge function (service role).
