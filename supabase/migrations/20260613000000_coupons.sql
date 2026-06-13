create table if not exists coupons (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  title text not null,
  description text default '',
  type text not null default 'percent',
  value numeric not null default 0,
  min_amount numeric default 0,
  active boolean default true,
  created_at timestamptz default now()
);

alter table bookings add column if not exists coupon_code text;
alter table bookings add column if not exists coupon_discount numeric default 0;
