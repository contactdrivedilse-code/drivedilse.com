-- Lets a coupon be hidden from the public "Offers" list while still being
-- applicable if a customer types in the exact code. Existing/general
-- coupons stay visible by default; the 1000 one-time customer-specific
-- codes (max_uses = 1) are exclusive and switched to hidden explicitly.
alter table public.coupons add column if not exists is_public boolean not null default true;

update public.coupons set is_public = false where max_uses = 1;
