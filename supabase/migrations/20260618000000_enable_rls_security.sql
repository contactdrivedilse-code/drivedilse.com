-- ============================================================
-- SECURITY: Enable Row Level Security on all public tables.
--
-- Context: the frontend talks ONLY to Edge Functions, which use
-- the service_role key (and therefore bypass RLS). No browser
-- code ever queries these tables directly. Before this migration
-- RLS was disabled, so the public anon key could read (and likely
-- write) profiles, bookings, cars, coupons and car_pauses via the
-- auto-exposed PostgREST API.
--
-- Enabling RLS with NO policies makes the default-deny: anon and
-- authenticated roles get zero rows, while service_role (Edge
-- Functions) continues to work unchanged.
-- ============================================================

ALTER TABLE IF EXISTS public.profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.profiles   FORCE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS public.bookings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.bookings   FORCE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS public.cars       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.cars       FORCE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS public.coupons    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.coupons    FORCE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS public.car_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.car_pauses FORCE ROW LEVEL SECURITY;

-- Defense in depth: explicitly remove direct table privileges from
-- the public API roles. Edge Functions use service_role, unaffected.
REVOKE ALL ON public.profiles   FROM anon, authenticated;
REVOKE ALL ON public.bookings   FROM anon, authenticated;
REVOKE ALL ON public.cars       FROM anon, authenticated;
REVOKE ALL ON public.coupons    FROM anon, authenticated;
REVOKE ALL ON public.car_pauses FROM anon, authenticated;
