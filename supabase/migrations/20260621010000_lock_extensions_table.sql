-- SECURITY: public.extensions had row-level security DISABLED, and the
-- anon/authenticated roles held full INSERT/SELECT/UPDATE/DELETE/TRUNCATE
-- grants on it (Supabase's default for newly created tables). This table
-- stores Razorpay payment fields (razorpay_order_id, razorpay_payment_id,
-- razorpay_signature) per booking extension — anyone with the public anon
-- key (embedded in the frontend) could read every customer's extension
-- payment records directly via the PostgREST REST API, or insert/modify/
-- delete rows, completely bypassing the bookings Edge Function.
--
-- All real access goes through the bookings Edge Function using the
-- service_role key, which bypasses RLS entirely — so, matching the same
-- lockdown already applied to storage.objects/buckets and every other
-- table in this project, anon/authenticated get no direct access at all.

alter table public.extensions enable row level security;

revoke all on public.extensions from anon, authenticated;

drop policy if exists "service role full access extensions" on public.extensions;
create policy "service role full access extensions" on public.extensions
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
