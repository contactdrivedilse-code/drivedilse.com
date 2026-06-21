-- Blog posts for SEO content. Published posts get rendered as real static
-- HTML pages and committed to the repo (see _shared/github.ts), so this
-- table is really just the admin-facing source of truth + draft storage.
create table if not exists public.blog_posts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  excerpt text not null default '',
  content text not null default '',
  meta_description text not null default '',
  author text not null default 'DriveDilSe Team',
  status text not null default 'draft' check (status in ('draft','published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists blog_posts_status_idx on public.blog_posts(status);
create index if not exists blog_posts_published_at_idx on public.blog_posts(published_at desc);

alter table public.blog_posts enable row level security;
revoke all on public.blog_posts from anon, authenticated;

drop policy if exists "service role full access blog_posts" on public.blog_posts;
create policy "service role full access blog_posts" on public.blog_posts
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
