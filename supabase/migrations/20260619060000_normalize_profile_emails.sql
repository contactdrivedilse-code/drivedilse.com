-- Bug fix: POST /profile previously saved the email exactly as typed (no
-- lowercase/trim), while OTP send/verify look up profiles by lowercased
-- email. Any profile whose email got saved with different casing could
-- never match again, so OTP login would always say "Invalid or expired
-- OTP" even with the correct code. The function code now normalizes on
-- write and looks up case-insensitively; this is a one-time cleanup of
-- rows already affected, so case-sensitive lookups elsewhere also work.
update public.profiles set email = lower(email) where email is not null and email <> lower(email);
