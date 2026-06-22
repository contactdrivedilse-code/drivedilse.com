-- Human-readable reason captured at the moment of cancellation, so the
-- customer/admin always see why a refund tier applied even though the
-- hours-to-pickup calculation that produced it changes over time.
alter table public.bookings add column if not exists refund_reason text;
