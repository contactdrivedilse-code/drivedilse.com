-- ============================================================
-- DriveDilSe — Supabase PostgreSQL Schema
-- Run this entire file in Supabase → SQL Editor → Run
-- ============================================================

create extension if not exists "pgcrypto";

-- Profiles (users)
create table if not exists profiles (
  id text primary key,
  phone text unique not null,
  name text default '',
  dob text default '',
  email text default '',
  aadhaar_url text default '',
  dl_url text default '',
  aadhaar_uploaded boolean default false,
  dl_verified boolean default false,
  kyc_status text default 'pending',
  otp text default '',
  otp_expiry timestamptz,
  phone_verified boolean default false,
  created_at timestamptz default now()
);

-- Cars
create table if not exists cars (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  category text not null,
  fuel text default 'Petrol',
  seats int default 5,
  transmission text default 'Manual',
  price_per_day int not null,
  deposit int default 0,
  features text[] default '{}',
  image text default '',
  active boolean default true,
  created_at timestamptz default now()
);

-- Car availability pauses
create table if not exists car_pauses (
  id text primary key default gen_random_uuid()::text,
  car_id text references cars(id) on delete cascade,
  from_date timestamptz not null,
  to_date timestamptz not null,
  note text default ''
);

-- Bookings
create table if not exists bookings (
  id text primary key default gen_random_uuid()::text,
  booking_id text unique not null,
  car_id text references cars(id),
  car_name text default '',
  user_id text references profiles(id),
  customer text default '',
  phone text default '',
  pickup_date timestamptz not null,
  pickup_location text default 'Pune',
  drop_date timestamptz not null,
  drop_location text default 'Pune',
  days int not null,
  price_per_day int not null,
  total int not null,
  deposit int default 0,
  discount int default 0,
  razorpay_order_id text default '',
  razorpay_payment_id text default '',
  razorpay_signature text default '',
  payment_status text default 'pending',
  paid_at timestamptz,
  checkin_front text default '',
  checkin_rear text default '',
  checkin_passenger_side text default '',
  checkin_driver_side text default '',
  checkin_photos_at timestamptz,
  checkin_otp text default '',
  checkin_otp_verified boolean default false,
  checked_in_at timestamptz,
  checkout_otp text default '',
  checkout_otp_verified boolean default false,
  checked_out_at timestamptz,
  status text default 'pending',
  cancelled_at timestamptz,
  notes text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Booking extensions
create table if not exists extensions (
  id text primary key default gen_random_uuid()::text,
  booking_id text references bookings(id) on delete cascade,
  hours int,
  cost int,
  razorpay_order_id text default '',
  razorpay_payment_id text default '',
  razorpay_signature text default '',
  extended_at timestamptz default now()
);

-- Disable RLS (backend uses service role key, bypasses RLS)
alter table profiles disable row level security;
alter table cars disable row level security;
alter table car_pauses disable row level security;
alter table bookings disable row level security;
alter table extensions disable row level security;
