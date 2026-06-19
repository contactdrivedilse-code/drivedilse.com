-- SECURITY: storage.objects allowed anon/authenticated to INSERT (upload)
-- into every bucket, including private ones (kyc, checkin) — confirmed live
-- by an unauthenticated curl upload succeeding against kyc/checkin/tickets.
-- All real uploads go through Edge Functions using the service_role key,
-- which bypasses RLS entirely, so the public anon-write policies served no
-- legitimate purpose and only let anyone fill storage with arbitrary files
-- (storage-cost abuse, private-bucket pollution, public-bucket hosting of
-- attacker-controlled content under our domain).
--
-- Drop every existing policy on storage.objects and storage.buckets, then
-- recreate as service_role-only for writes. Public buckets (cars, tickets)
-- still serve GET via the dashboard "public" flag, which is enforced by
-- Storage's own bucket.public check and does not depend on these policies.

do $$
declare
  pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'
  loop
    execute format('drop policy if exists %I on storage.objects', pol.policyname);
  end loop;
  for pol in select policyname from pg_policies where schemaname = 'storage' and tablename = 'buckets'
  loop
    execute format('drop policy if exists %I on storage.buckets', pol.policyname);
  end loop;
end $$;

-- storage.objects/buckets are owned by supabase_storage_admin; RLS is
-- already enabled by Supabase on these tables, so we only manage policies.

create policy "service role full access objects" on storage.objects
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create policy "service role full access buckets" on storage.buckets
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

revoke all on storage.objects from anon, authenticated;
revoke all on storage.buckets from anon, authenticated;
