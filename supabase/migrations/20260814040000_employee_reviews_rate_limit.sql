ALTER TABLE public.employee_reviews ADD COLUMN IF NOT EXISTS reviewer_ip text;
ALTER TABLE public.employee_reviews ADD CONSTRAINT comment_length CHECK (char_length(comment) <= 500);
CREATE INDEX IF NOT EXISTS idx_emp_reviews_ip_employee ON public.employee_reviews(employee_id, reviewer_ip, created_at);
