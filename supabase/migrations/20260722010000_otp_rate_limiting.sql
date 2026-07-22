-- OTP brute-force / flood protection.
-- otp_attempts: counts consecutive failed verify-otp attempts.
--   Reset to 0 on success or when a new OTP is issued.
-- otp_attempts_locked_until: set 15 minutes into the future after 5 failures.
--   While set, verify-otp is rejected immediately without checking the code.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS otp_attempts          int          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS otp_attempts_locked_until timestamptz;
