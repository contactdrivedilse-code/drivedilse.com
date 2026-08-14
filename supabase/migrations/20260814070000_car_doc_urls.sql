-- Document file URLs per car (RC, Insurance, PUC, Fitness Certificate)
ALTER TABLE public.cars
  ADD COLUMN IF NOT EXISTS rc_doc_url        text,
  ADD COLUMN IF NOT EXISTS insurance_doc_url text,
  ADD COLUMN IF NOT EXISTS puc_doc_url       text,
  ADD COLUMN IF NOT EXISTS fitness_doc_url   text;
