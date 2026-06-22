-- Tracks the outcome of automatic cancellation refunds (see bookings/index.ts
-- PUT /:id/cancel), so the admin panel and customer can see exactly what was
-- refunded, at what tier, and via which Razorpay refund.
alter table public.bookings
  add column if not exists refund_amount numeric,
  add column if not exists refund_pct numeric,
  add column if not exists razorpay_refund_id text,
  add column if not exists refund_status text;
