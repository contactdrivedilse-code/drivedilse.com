# DriveDilSe — Project Notes

Internal notes for whoever (human or AI assistant) picks up this repo on a new machine. Source of truth for *why* things are the way they are — the code itself only shows *what*.

## Stack & linked accounts

- **Frontend**: static `index.html` / `admin.html` (panel) / `policy.html`, deployed via Vercel (project `drivedilse-com`, org `contactdrivedilse-8296s-projects`) → https://drivedilse.com
- **Backend**: Supabase project ref `fuesnifgaiivcapppexw` (region ap-northeast-1) — Postgres + Edge Functions (`supabase/functions/*`, Deno/TS) + Storage buckets (`cars` public, `kyc`/`checkin`/`tickets` private-or-mixed, see security section)
- **Legacy/unused**: a Node/Express `backend/` folder (Render deploy) exists from an earlier architecture — the live site no longer uses it, Supabase Edge Functions are the real backend now.
- GitHub: `contactdrivedilse-code/drivedilse.com`, only branch `main`, auto-deploys to Vercel on push. Branch protection: no deletion/force-push, no required reviews (deliberate — solo dev, direct-to-main workflow).
- Repo is **public**. `.env*` (except `.env.example`) is gitignored — never commit real secrets.

## New-machine setup

1. Install: Git, Node.js, `gh` CLI, `npm i -g vercel supabase`
2. `git clone https://github.com/contactdrivedilse-code/drivedilse.com.git`
3. Supabase CLI: **interactive `supabase login` hangs on at least one of this user's Windows machines** — go straight to `supabase login --token <token>` using a token from https://supabase.com/dashboard/account/tokens
4. `supabase link --project-ref fuesnifgaiivcapppexw`
5. `vercel link` (select org `contactdrivedilse-8296s-projects`, project `drivedilse-com`)
6. Don't run `vercel env pull` carelessly — it writes real secrets to a local `.env.vercel.local` file; keep it out of git (already gitignored).

## Security audit history

### 2026-06-18 — initial audit, critical fixes
Frontend talks **only** to Supabase Edge Functions, never the DB/storage directly — Edge Functions hold the service_role key server-side. That architecture is sound. Found and fixed:

1. **RLS was disabled on every `public.*` table** — anon key (necessarily public, it's in page source) could read/write `profiles`, `bookings`, `cars`, `coupons`, `car_pauses` directly via PostgREST. Fixed: `supabase/migrations/20260618000000_enable_rls_security.sql` enables+forces RLS, revokes anon/authenticated grants. Functions unaffected (service_role bypasses RLS).
2. **`kyc` and `checkin` storage buckets were public** — customer Aadhaar/DL/vehicle photos downloadable by anyone with the URL. Fixed: set both private, added `_shared/storage.ts` `signStorageUrl()` to issue 1hr signed URLs from the functions that need them. `cars` bucket stays public (car photos are meant to be public).
3. **`ADMIN_PASSWORD` was `"1234"`.** Rotated via `supabase secrets set`, same for `FLEET_PASSWORD`. New values are in the user's password manager — not in this repo.
4. **OTP bypass accepted `"1234"` for any phone number**, no auth needed → account takeover. Fixed: test-OTP bypass now requires `ALLOW_TEST_OTP=true` (unset in prod) plus an explicit `TEST_OTP` value; no hardcoded default.
5. **Admin/customer auth tokens were leaking into URLs** (`_t`, `_ut` query params) → visible in logs/Referer headers. Fixed: `apiFetch()`/`adminFetch()` now send tokens only via `x-user-token`/`x-admin-token` headers (functions still accept the old query param too, for compat).

**Consequence to know about:** with the OTP test-bypass off, customer login depends on real SMS delivery (FAST2SMS). If SMS breaks, temporary workaround is `supabase secrets set ALLOW_TEST_OTP=true TEST_OTP=<code>`, then unset it again afterward.

### 2026-06-19 — follow-up audit, after the support-ticket/chat-bot feature shipped
1. **Fixed & deployed:** ticket name/message and admin reply text were interpolated *raw* into the Resend transactional email HTML — HTML/script injection via the unauthenticated `/support/tickets` endpoint, landing in both the admin's and the customer's inbox. Fixed with an `escapeHtml()` helper in `supabase/functions/_shared/email.ts`, applied everywhere user-controlled text hits an email template.
2. **Fixed & deployed:** no file-type/size validation on uploaded images (ticket-reply attachments, car photos) — now restricted to JPEG/PNG/WEBP, 5MB max.
3. **Fixed & deployed:** no length caps on ticket fields — added (name ≤100, message ≤2000, email ≤200) to block trivial spam/payload abuse on the public endpoint.
4. **Fixed & deployed (2026-06-19):** the anon key could **upload** arbitrary files directly to *every* storage bucket via the Storage REST API, confirmed live with curl — including the **private** `kyc` and `checkin` buckets (the Aadhaar/DL/check-in photo buckets). Reads/lists on those buckets were still correctly blocked; only writes were the hole. Root cause: a permissive INSERT policy on `storage.objects`/`storage.buckets` that predated the 2026-06-18 RLS migration (which only touched `public.*` tables, not the `storage` schema). Fixed by `supabase/migrations/20260619050000_lock_storage_objects.sql` — drops existing storage.objects/buckets policies, recreates them service_role-only. Re-verified live: anon upload to `kyc`/`tickets` now returns 400; public reads from `cars` still work.

### 2026-06-19 (later) — OTP login bug ("invalid or expired OTP" with the correct code)
Root cause: `POST /auth/profile` saved the customer's email exactly as typed (no lowercase/trim), but `/auth/send-otp` and `/auth/verify-otp` looked up profiles by an exact-match lowercased email. Once a profile's email got saved with different casing (autocapitalize, KYC form, etc.), OTP login for that customer could never match again — always "Invalid or expired OTP", even with the right code. Fixed: email is now normalized to lowercase on every write in `auth/index.ts`, and OTP lookups use case-insensitive `ilike` matching as well (so already-mismatched rows recover too). Added a one-time migration (`20260619060000_normalize_profile_emails.sql`) to lowercase any already-broken rows immediately. Also added missing error-checking on the profile insert/update calls in the OTP flow, which previously failed silently (a DB write failure would still report "OTP sent" to the user with nothing actually stored).

## Open items / things to revisit
- Apply migration `20260619050000_lock_storage_objects.sql` (see above).
- Consider 2FA on GitHub/Vercel/Supabase accounts (account-level, not code-level — not yet confirmed done).
- `gh-pages` branch exists on the remote — confirm it's not an unintentional second deploy target before assuming push-to-main is the only live path.
