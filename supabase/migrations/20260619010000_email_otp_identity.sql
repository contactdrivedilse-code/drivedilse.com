-- OTP verification now happens by email (sent from info@drivedilse.com via
-- Resend) instead of SMS to phone. Phone remains on the profile as a contact
-- field only. Make email the unique lookup key for OTP send/verify.
alter table public.profiles add column if not exists email text;
alter table public.profiles alter column phone drop not null;

-- Existing rows have '' rather than null for unset emails; normalize so the
-- partial unique index below doesn't choke on duplicate empty strings.
update public.profiles set email = null where email = '';

create unique index if not exists profiles_email_unique_idx
  on public.profiles (lower(email))
  where email is not null;
