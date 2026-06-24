-- Post-trip deposit settlement workflow. After checkout, the fleet
-- manager has a window to record any deductions (damage, late return /
-- unbilled extension, FASTag dues, fuel shortfall) against the
-- refundable deposit. That produces a suggested refund amount which
-- admin reviews and either confirms or adjusts before actually
-- triggering the Razorpay refund (see admin/index.ts).
alter table public.bookings
  add column if not exists settlement_filled_at timestamptz,
  add column if not exists settlement_late_hours numeric,
  add column if not exists settlement_damage_amount numeric not null default 0,
  add column if not exists settlement_fastag_amount numeric not null default 0,
  add column if not exists settlement_fuel_amount numeric not null default 0,
  add column if not exists settlement_extension_amount numeric not null default 0,
  add column if not exists settlement_notes text,
  add column if not exists settlement_suggested_refund numeric,
  add column if not exists deposit_refund_amount numeric;
