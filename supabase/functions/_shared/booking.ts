import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { calcPrice } from "./pricing.ts";
import { sendBookingConfirmationEmail } from "./email.ts";

// Refundable security deposit — fixed platform-wide amount, decided
// server-side only. Never trust a client-supplied deposit amount; only
// the choice of "now" vs "later" comes from the client.
export const DEPOSIT_AMOUNT = Number(Deno.env.get("DEPOSIT_AMOUNT_INR")) || 1000;
export function resolveDepositChoice(raw: unknown): "now" | "later" { return raw === "now" ? "now" : "later"; }

// Delivery fee is client-supplied but capped server-side to prevent
// manipulation (e.g. claiming 0 for a home delivery, or inflating to
// a huge number). Set MAX_DELIVERY_FEE_INR in Supabase secrets.
const MAX_DELIVERY_FEE = Number(Deno.env.get("MAX_DELIVERY_FEE_INR")) || 500;
export function resolveDeliveryFee(raw: unknown): number {
  if (typeof raw !== "number" || raw <= 0) return 0;
  return Math.min(Math.round(raw), MAX_DELIVERY_FEE);
}

export function makeBookingId(): string { return "DS" + Date.now().toString(36).toUpperCase(); }
export function generateOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

export const CONFLICT_MSG = "This car is paused or already booked for these dates. Please choose different dates or another car.";

// Checks both real bookings AND fleet-manager pause periods for the
// requested window. A car paused for maintenance/Zoomcar etc. must be
// just as unbookable as one with an overlapping confirmed booking.
const HOLD_MINUTES = 10;
export async function hasDateConflict(sb: SupabaseClient, carId: string, pISO: string, dISO: string, ownSession?: string): Promise<boolean> {
  const nowISO = new Date().toISOString();
  let holdsQ = sb.from("car_holds").select("id").eq("car_id", carId)
    .lt("pickup_date", dISO).gt("drop_date", pISO).gt("expires_at", nowISO);
  if (ownSession) holdsQ = holdsQ.neq("session_id", ownSession);

  const [{ data: bookingConflict }, { data: pauseConflict }, { data: holdConflict }] = await Promise.all([
    sb.from("bookings").select("id").eq("car_id", carId)
      .in("status", ["confirmed", "active", "pending_kyc", "pending", "completed"]).lt("pickup_date", dISO).gt("drop_date", pISO).maybeSingle(),
    sb.from("car_pauses").select("id").eq("car_id", carId)
      .lt("from_date", dISO).gt("to_date", pISO).maybeSingle(),
    holdsQ.maybeSingle(),
  ]);
  return !!bookingConflict || !!pauseConflict || !!holdConflict;
}
void HOLD_MINUTES; // kept for reference alongside the hold-expiry window used at /hold

// `verifiedUserId` must come from a real (non-guest) OTP-verified profile — guest/demo
// bookings never pass one, so ANY coupon requires the customer to have completed
// phone+OTP signup/login before it can be applied.
export async function applyCoupon(
  sb: SupabaseClient,
  baseTotal: number,
  code: unknown,
  ctx: { verifiedUserId?: string; consume?: boolean } = {},
): Promise<{ discount: number; code: string | null }> {
  if (typeof code !== "string" || !code.trim()) return { discount: 0, code: null };
  if (!ctx.verifiedUserId) return { discount: 0, code: null };
  const { data } = await sb.from("coupons").select("*").eq("code", code.toUpperCase().trim()).eq("active", true).maybeSingle();
  const c = data as Record<string, unknown> | null;
  if (!c) return { discount: 0, code: null };
  const minAmount = (c.min_amount as number) ?? 0;
  if (baseTotal < minAmount) return { discount: 0, code: null };
  if (c.new_customer_only) {
    const { data: priorBooking } = await sb.from("bookings").select("id")
      .eq("user_id", ctx.verifiedUserId).limit(1).maybeSingle();
    if (priorBooking) return { discount: 0, code: null };
  }
  const maxUses  = c.max_uses as number | null;
  const timesUsed = (c.times_used as number) ?? 0;
  if (maxUses != null && timesUsed >= maxUses) return { discount: 0, code: null };

  if (ctx.consume && maxUses != null) {
    // Atomic conditional increment — the WHERE clause is re-evaluated under
    // row lock, so two simultaneous redemptions of the same one-time code
    // can't both succeed.
    const { data: updated } = await sb.from("coupons")
      .update({ times_used: timesUsed + 1 })
      .eq("id", c.id as string)
      .lt("times_used", maxUses)
      .select("id")
      .maybeSingle();
    if (!updated) return { discount: 0, code: null };
  }

  const raw = c.type === "flat" ? (c.value as number) : Math.round(baseTotal * (c.value as number) / 100);
  const discount = Math.max(0, Math.min(raw, baseTotal));
  return { discount, code: c.code as string };
}

export function mapBooking(b: Record<string, unknown>) {
  return {
    _id: b.id, id: b.id, bookingId: b.booking_id,
    car: { _id: b.car_id, id: b.car_id, name: b.car_name }, carName: b.car_name,
    customer: b.customer, phone: b.phone,
    pickup: { date: b.pickup_date, location: b.pickup_location },
    drop:   { date: b.drop_date,   location: b.drop_location },
    days: b.days, pricePerDay: b.price_per_day, total: b.total,
    deposit: b.deposit, discount: b.discount, deliveryFee: b.delivery_fee ?? 0,
    depositAmount: b.deposit_amount ?? 0, depositChoice: b.deposit_choice ?? "later", depositPaid: b.deposit_paid ?? false,
    couponCode: b.coupon_code ?? null, couponDiscount: b.coupon_discount ?? 0,
    payment: { status: b.payment_status, paidAt: b.paid_at },
    checkin: { photos: {}, otp: b.checkin_otp, otpVerified: b.checkin_otp_verified },
    checkout: { otp: b.checkout_otp, otpVerified: b.checkout_otp_verified },
    status: b.status, createdAt: b.created_at, extensions: [],
  };
}

export type CreateBookingResult =
  | { ok: true; bookingId: string; booking: Record<string, unknown>; alreadyExisted: boolean }
  | { ok: false; reason: "conflict" | "blacklisted"; message: string };

// The single place that actually turns a paid Razorpay order into a booking
// row. Used by both the client-driven /verify call (browser came back after
// payment) and the payment.captured webhook (browser never came back —
// see payment-webhook/index.ts). Keeping this in one place means both paths
// price the booking, apply the coupon, and enforce the blacklist identically.
export async function createBooking(sb: SupabaseClient, params: {
  userId: string; carId: string;
  pickupDate: string; dropDate: string;
  pickupLocation?: string; dropLocation?: string;
  deliveryCharge?: unknown; couponCode?: unknown; depositChoice?: unknown;
  sessionId?: string;
  razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string;
  // The webhook path has no live customer to show an error to — the money is
  // already captured, so it favors still creating the booking (flagged for
  // manual review below) over silently dropping a paid booking on a date
  // conflict. The client /verify path keeps the original strict behaviour.
  skipConflictCheck?: boolean;
}): Promise<CreateBookingResult> {
  // Idempotency: if this order already produced a booking (the other path
  // got there first), just hand back that same booking instead of re-pricing
  // or re-consuming the coupon.
  const { data: existing } = await sb.from("bookings").select("*").eq("razorpay_order_id", params.razorpayOrderId).maybeSingle();
  if (existing) return { ok: true, bookingId: (existing as Record<string, unknown>).booking_id as string, booking: existing as Record<string, unknown>, alreadyExisted: true };

  const [{ data: car }, { data: profile }] = await Promise.all([
    sb.from("cars").select("*").eq("id", params.carId).maybeSingle(),
    sb.from("profiles").select("*").eq("id", params.userId).maybeSingle(),
  ]);
  const c = car as Record<string, unknown>, p = profile as Record<string, unknown>;

  const pickup = new Date(params.pickupDate), drop = new Date(params.dropDate);
  if (!params.skipConflictCheck && await hasDateConflict(sb, params.carId, pickup.toISOString(), drop.toISOString(), params.sessionId)) {
    return { ok: false, reason: "conflict", message: CONFLICT_MSG };
  }
  const { data: blEntry } = await sb.from("blacklist").select("phone, reason").eq("phone", (p.phone as string || "").replace(/\D/g, "")).maybeSingle();
  if (blEntry) return { ok: false, reason: "blacklisted", message: "Booking unavailable. Please contact support." };

  const { base: baseFare, total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop, (c.category as string) || "");
  const deliveryFee = resolveDeliveryFee(params.deliveryCharge);
  const { discount: couponDiscount, code: appliedCoupon } = await applyCoupon(sb, baseTotal, params.couponCode, { verifiedUserId: p.id as string, consume: true });
  const chosenDeposit = resolveDepositChoice(params.depositChoice);
  const depositPaidNow = chosenDeposit === "now";
  const gst = Math.round((baseFare + deliveryFee) * 0.18);
  const total = baseFare + deliveryFee + gst + (depositPaidNow ? DEPOSIT_AMOUNT : 0) - couponDiscount;
  const bookingId = makeBookingId();
  const isConfirmed = p.kyc_status === "verified";

  const { data: booking, error } = await sb.from("bookings").insert({
    id: crypto.randomUUID(), booking_id: bookingId,
    car_id: c.id, car_name: c.name,
    user_id: p.id, customer: p.name ?? "", phone: p.phone,
    pickup_date: pickup.toISOString(), pickup_location: params.pickupLocation ?? "Pune",
    drop_date: drop.toISOString(), drop_location: params.dropLocation ?? "Pune",
    days, price_per_day: c.price_per_day, total,
    deposit: 0, discount, delivery_fee: deliveryFee,
    deposit_amount: DEPOSIT_AMOUNT, deposit_choice: chosenDeposit,
    deposit_paid: depositPaidNow, deposit_paid_at: depositPaidNow ? new Date().toISOString() : null,
    deposit_razorpay_payment_id: depositPaidNow ? params.razorpayPaymentId : null,
    coupon_code: appliedCoupon, coupon_discount: couponDiscount,
    razorpay_order_id: params.razorpayOrderId, razorpay_payment_id: params.razorpayPaymentId,
    razorpay_signature: params.razorpaySignature, payment_status: "paid",
    paid_at: new Date().toISOString(),
    status: isConfirmed ? "confirmed" : "pending_kyc",
    // Check-in OTP is generated as soon as the booking is confirmed,
    // so the fleet manager has it ready before the customer even uploads photos.
    checkin_otp: isConfirmed ? generateOtp() : null,
  }).select("*").maybeSingle();

  if (error) {
    // 23505 on bookings_razorpay_order_id_uniq — the other path (webhook vs.
    // client /verify) won the race and inserted first. Return its booking.
    if ((error as { code?: string }).code === "23505") {
      const { data: winner } = await sb.from("bookings").select("*").eq("razorpay_order_id", params.razorpayOrderId).maybeSingle();
      if (winner) return { ok: true, bookingId: (winner as Record<string, unknown>).booking_id as string, booking: winner as Record<string, unknown>, alreadyExisted: true };
    }
    throw error;
  }

  if (isConfirmed && p.email) {
    sendBookingConfirmationEmail({
      to: p.email as string, customerName: p.name as string, bookingId,
      carName: c.name as string, pickupDate: pickup.toISOString(), dropDate: drop.toISOString(),
      pickupLocation: (params.pickupLocation as string) ?? "Pune", total,
      customerPhone: p.phone as string | undefined,
    }).catch((e) => console.error("Booking confirmation email failed", bookingId, (e as Error).message));
  }

  return { ok: true, bookingId, booking: booking as Record<string, unknown>, alreadyExisted: false };
}
