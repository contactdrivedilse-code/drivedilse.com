-- ============================================================
-- SMART PRICING: competitor price scraping + admin-approved
-- pricing suggestions.
--
-- Context: a scheduled scraper (GitHub Actions) writes rows into
-- competitor_prices, then derives pricing_suggestions by comparing
-- the competitor average per car category against cars.price_per_day.
-- Suggestions are NOT auto-applied -- an admin reviews and approves
-- them in the panel (see supabase/functions/admin/index.ts), since
-- scraped data is fragile (site redesigns, bot detection, city
-- mismatches) and should never silently move live prices.
--
-- Both tables are service_role-only, matching the RLS posture set
-- in 20260618000000_enable_rls_security.sql: RLS enabled with no
-- policies for anon/authenticated, Edge Functions (service_role)
-- bypass RLS and are the only writers/readers.
-- ============================================================

create table if not exists public.competitor_prices (
  id           uuid primary key default gen_random_uuid(),
  competitor   text not null,
  category     text not null,
  city         text not null,
  price_per_day int not null,
  scraped_at   timestamptz not null default now()
);

create index if not exists competitor_prices_category_scraped_idx
  on public.competitor_prices (category, scraped_at desc);

create table if not exists public.pricing_suggestions (
  id              uuid primary key default gen_random_uuid(),
  category        text not null,
  current_price   int not null,
  competitor_avg  int not null,
  suggested_price int not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'applied', 'dismissed')),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create index if not exists pricing_suggestions_status_idx
  on public.pricing_suggestions (status, created_at desc);

alter table public.competitor_prices   enable row level security;
alter table public.competitor_prices   force row level security;

alter table public.pricing_suggestions enable row level security;
alter table public.pricing_suggestions force row level security;

revoke all on public.competitor_prices   from anon, authenticated;
revoke all on public.pricing_suggestions from anon, authenticated;
