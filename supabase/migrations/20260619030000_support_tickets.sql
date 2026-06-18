-- Support tickets raised from the website chat widget.
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text,
  message text not null,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

alter table public.support_tickets enable row level security;

-- No public select/update — tickets are submitted via the service-role
-- backed edge function and only readable by the admin panel (service role).
create policy "service role full access" on public.support_tickets
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
