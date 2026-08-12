ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS checkout_km integer;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS checkout_fuel_photo text;
