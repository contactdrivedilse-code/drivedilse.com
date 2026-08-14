ALTER TABLE public.cars ADD COLUMN IF NOT EXISTS car_number       text;
ALTER TABLE public.cars ADD COLUMN IF NOT EXISTS rc_expiry        date;
ALTER TABLE public.cars ADD COLUMN IF NOT EXISTS insurance_expiry date;
ALTER TABLE public.cars ADD COLUMN IF NOT EXISTS puc_expiry       date;
ALTER TABLE public.cars ADD COLUMN IF NOT EXISTS fitness_expiry   date;
