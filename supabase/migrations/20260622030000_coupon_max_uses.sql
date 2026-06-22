-- Lets a coupon row enforce a redemption limit. max_uses = null means
-- unlimited (existing promo codes like WELCOME10 keep working exactly as
-- before). times_used is incremented atomically (see applyCoupon in
-- payment/index.ts) only when a booking is actually confirmed, never on
-- a price preview, so two people racing the same one-time code can't
-- both win it.
alter table public.coupons
  add column if not exists max_uses integer,
  add column if not exists times_used integer not null default 0;
