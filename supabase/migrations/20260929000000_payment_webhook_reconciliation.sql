-- Backs the Razorpay payment.captured webhook: if the customer's browser
-- tab is killed/reloaded during a UPI app redirect, the client-side
-- verify call never happens and the booking is never created even though
-- Razorpay already captured the money. The webhook reconstructs the
-- booking from what /order or /guest-order stashed here at order-creation
-- time, independent of whether the browser ever came back.

CREATE TABLE IF NOT EXISTS public.pending_orders (
  razorpay_order_id text        PRIMARY KEY,
  user_id           text        NOT NULL,
  car_id            text        NOT NULL,
  pickup_date       timestamptz NOT NULL,
  drop_date         timestamptz NOT NULL,
  pickup_location   text,
  drop_location     text,
  delivery_fee      integer     NOT NULL DEFAULT 0,
  coupon_code       text,
  deposit_choice    text        NOT NULL DEFAULT 'later',
  session_id        text,
  consumed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pending_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON public.pending_orders
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Abandoned checkouts (customer never pays) shouldn't accumulate forever.
CREATE OR REPLACE FUNCTION public.cleanup_pending_orders() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.pending_orders WHERE created_at < now() - interval '3 days';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER pending_orders_cleanup
  AFTER INSERT ON public.pending_orders
  FOR EACH STATEMENT EXECUTE FUNCTION public.cleanup_pending_orders();

-- Lets the client-side /verify path and the webhook race safely: whichever
-- inserts the booking first wins, the other hits a unique_violation on this
-- index and just returns the existing booking instead of double-booking.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_razorpay_order_id_uniq
  ON public.bookings (razorpay_order_id) WHERE razorpay_order_id IS NOT NULL;
