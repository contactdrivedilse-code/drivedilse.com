-- Real refundable-deposit tracking. Previously the "Pay Now / Pay Later"
-- choice on the booking form was purely cosmetic — the deposit amount got
-- silently folded into the delivery-fee charge with no record of it ever
-- being collected, and "Pay Later" meant the deposit was simply never
-- asked for again. This makes the deposit a real, trackable obligation
-- that gates check-in (see bookings/index.ts POST /:id/checkin/verify).
alter table public.bookings
  add column if not exists deposit_amount numeric not null default 0,
  add column if not exists deposit_choice text,
  add column if not exists deposit_paid boolean not null default false,
  add column if not exists deposit_paid_at timestamptz,
  add column if not exists deposit_razorpay_order_id text,
  add column if not exists deposit_razorpay_payment_id text,
  add column if not exists deposit_refund_status text,
  add column if not exists deposit_refund_id text;
