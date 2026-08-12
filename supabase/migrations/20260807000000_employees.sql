-- Employees table for staff verification system
CREATE TABLE IF NOT EXISTS public.employees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL,
  department    text,
  photo_url     text,
  joined_date   date,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Employee reviews submitted via public verification page
CREATE TABLE IF NOT EXISTS public.employee_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  rating        smallint NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment       text NOT NULL,
  reviewer_name text NOT NULL DEFAULT 'Anonymous',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Storage bucket for employee photos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('employees', 'employees', true, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- RLS: employees table is public-readable, admin-writable (via service role in edge function)
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read employees" ON public.employees FOR SELECT USING (true);

-- RLS: reviews are public-readable and public-insertable
ALTER TABLE public.employee_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read reviews" ON public.employee_reviews FOR SELECT USING (true);
CREATE POLICY "public insert reviews" ON public.employee_reviews FOR INSERT WITH CHECK (true);

-- Also add checkin_km and checkin_fuel_photo if not already present
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS checkin_km integer;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS checkin_fuel_photo text;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS amount_collected numeric;
