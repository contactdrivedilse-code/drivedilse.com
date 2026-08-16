-- SECURITY: Make car-docs bucket private and store storage paths (not public URLs).
--
-- Previously the car-docs bucket was public, meaning anyone who could guess or
-- enumerate the storage path (e.g. <carId>/rc.pdf) could download RC, insurance,
-- PUC, and fitness certificates without any authentication.
--
-- Fix:
--   1. Flip the bucket to private (public = false).
--   2. The admin upload function will now store the storage path instead of a
--      public URL. The fleet /car-docs endpoint signs on read (1-hour expiry).
--   3. Migrate any existing stored public URLs to bare storage paths so the
--      signing logic can still handle them.

-- Make bucket private
UPDATE storage.buckets SET public = false WHERE id = 'car-docs';

-- Migrate existing public URLs to bare storage paths.
-- Pattern: https://<ref>.supabase.co/storage/v1/object/public/car-docs/<path>
-- We strip everything up to and including /public/car-docs/ leaving just <path>.
UPDATE public.cars
SET
  rc_doc_url        = regexp_replace(rc_doc_url,        '.*/car-docs/', ''),
  insurance_doc_url = regexp_replace(insurance_doc_url, '.*/car-docs/', ''),
  puc_doc_url       = regexp_replace(puc_doc_url,       '.*/car-docs/', ''),
  fitness_doc_url   = regexp_replace(fitness_doc_url,   '.*/car-docs/', '')
WHERE
  rc_doc_url        LIKE '%/storage/v1/object/public/car-docs/%'
  OR insurance_doc_url LIKE '%/storage/v1/object/public/car-docs/%'
  OR puc_doc_url       LIKE '%/storage/v1/object/public/car-docs/%'
  OR fitness_doc_url   LIKE '%/storage/v1/object/public/car-docs/%';
