-- Stores the Zoho Books invoice ID raised on checkout, so the customer-facing
-- "View Invoice" button can fetch the PDF without re-creating/searching it.
alter table public.bookings add column if not exists zoho_invoice_id text;
