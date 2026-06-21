-- Customer reviews left after a completed trip, shown on that car's detail
-- page and in the homepage reviews marquee. One review per booking.
create table if not exists public.car_reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id text not null references public.bookings(id) on delete cascade,
  car_id text not null references public.cars(id) on delete cascade,
  user_id text not null references public.profiles(id) on delete cascade,
  customer_name text not null default '',
  rating int not null check (rating >= 1 and rating <= 5),
  review_text text not null default '',
  created_at timestamptz not null default now(),
  unique (booking_id)
);

create index if not exists car_reviews_car_id_idx on public.car_reviews(car_id);
create index if not exists car_reviews_created_at_idx on public.car_reviews(created_at desc);

-- All real access goes through Edge Functions using the service_role key,
-- same lockdown pattern as every other table in this project.
alter table public.car_reviews enable row level security;
revoke all on public.car_reviews from anon, authenticated;

drop policy if exists "service role full access car_reviews" on public.car_reviews;
create policy "service role full access car_reviews" on public.car_reviews
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
