-- Support manually-entered bookings (e.g. cars also rented out via Zoomcar)
-- and a daily pickup/drop-off checklist in the admin/fleet panel.
alter table public.bookings add column if not exists source text default 'website';
alter table public.bookings add column if not exists pickup_done boolean default false;
alter table public.bookings add column if not exists drop_done boolean default false;
