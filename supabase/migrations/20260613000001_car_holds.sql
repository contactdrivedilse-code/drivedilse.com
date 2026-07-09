create table if not exists car_holds (
  id uuid primary key default gen_random_uuid(),
  car_id text not null,
  pickup_date timestamptz not null,
  drop_date timestamptz not null,
  session_id text not null,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

create index if not exists car_holds_lookup on car_holds (car_id, expires_at);
