-- Admin replies (with optional image) and resolution timestamps for support tickets.
alter table public.support_tickets add column if not exists reply_message text;
alter table public.support_tickets add column if not exists reply_image_url text;
alter table public.support_tickets add column if not exists replied_at timestamptz;
alter table public.support_tickets add column if not exists resolved_at timestamptz;

insert into storage.buckets (id, name, public)
values ('tickets', 'tickets', true)
on conflict (id) do nothing;
