-- Performance indexes for common admin and customer query patterns.

-- Bookings: most queries filter by status and sort by created_at / pickup_date
CREATE INDEX IF NOT EXISTS idx_bookings_status          ON public.bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_created_desc    ON public.bookings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_pickup_date     ON public.bookings(pickup_date);
CREATE INDEX IF NOT EXISTS idx_bookings_car_id          ON public.bookings(car_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user_id         ON public.bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_phone           ON public.bookings(phone);

-- Conflict checks: car_id + date range + status
CREATE INDEX IF NOT EXISTS idx_bookings_conflict ON public.bookings(car_id, pickup_date, drop_date) WHERE status NOT IN ('cancelled','no_show');

-- Car holds: expires_at used in WHERE
CREATE INDEX IF NOT EXISTS idx_car_holds_expires ON public.car_holds(expires_at);
CREATE INDEX IF NOT EXISTS idx_car_holds_car_id  ON public.car_holds(car_id);

-- Profiles: email and phone lookups
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(lower(email));
CREATE INDEX IF NOT EXISTS idx_profiles_phone ON public.profiles(phone);

-- Extensions: booking_id foreign key
CREATE INDEX IF NOT EXISTS idx_extensions_booking_id ON public.extensions(booking_id);

-- Car reviews: booking_id and car_id
CREATE INDEX IF NOT EXISTS idx_car_reviews_booking_id ON public.car_reviews(booking_id);
CREATE INDEX IF NOT EXISTS idx_car_reviews_car_id     ON public.car_reviews(car_id);

-- Employee reviews: employee_id + reviewer_ip for rate limiting
CREATE INDEX IF NOT EXISTS idx_emp_reviews_employee_id ON public.employee_reviews(employee_id, created_at DESC);
