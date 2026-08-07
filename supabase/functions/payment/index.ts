import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { signJwt, verifyJwt, getBearer, getUserToken } from "../_shared/jwt.ts";
import { sendBookingConfirmationEmail } from "../_shared/email.ts";
// Zoho Books invoice generation removed

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function makeBookingId(): string { return "DS" + Date.now().toString(36).toUpperCase(); }
function generateOtp(): string { return String(Math.floor(100000 + Math.random() * 900000)); }

// Refundable security deposit — fixed platform-wide amount, decided
// server-side only. Never trust a client-supplied deposit amount; only
// the choice of "now" vs "later" comes from the client.
const DEPOSIT_AMOUNT = Number(Deno.env.get("DEPOSIT_AMOUNT_INR")) || 1000;
function resolveDepositChoice(raw: unknown): "now" | "later" { return raw === "now" ? "now" : "later"; }

// Checks both real bookings AND fleet-manager pause periods for the
// requested window. A car paused for maintenance/Zoomcar etc. must be
// just as unbookable as one with an overlapping confirmed booking —
// this was previously only checked at the /fleet/available listing
// step, not at actual booking creation, so a paused car could still be
// booked through it (e.g. via the homepage carousel, which deliberately
// keeps unavailable cars visible/clickable).
const HOLD_MINUTES = 10;

async function hasDateConflict(carId: string, pISO: string, dISO: string, ownSession?: string): Promise<boolean> {
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
const CONFLICT_MSG = "This car is paused or already booked for these dates. Please choose different dates or another car.";

// Marginal bracket rates (₹/hr, excl GST) — must stay in sync with CAT_BRACKETS in index.html.
// Brackets: [0-12hr, 12-24hr, 24-168hr, 168hr+]
const CAT_BRACKETS: Record<string, number[]> = {
  compact: [ 96, 60, 39, 48],
  premium: [105, 65, 43, 54],
  MPV:     [130, 81, 45, 64],
  SUV:     [156, 97, 54, 73],
};
const HATCH_PPD_SPLIT = 1580;
const BRACKET_CUTS = [0, 12, 24, 168, Infinity];

function getCatBrackets(category: string, pricePerDay: number): number[] {
  const cat = (category || "").toLowerCase();
  if (cat === "mpv") return CAT_BRACKETS.MPV;
  if (cat === "compact suv" || cat === "suv") return CAT_BRACKETS.SUV;
  if (cat === "premium hatchback" || cat === "sedan") return CAT_BRACKETS.premium;
  if (cat === "compact hatchback") return CAT_BRACKETS.compact;
  return pricePerDay < HATCH_PPD_SPLIT ? CAT_BRACKETS.compact : CAT_BRACKETS.premium;
}

function getMarginalBase(rates: number[], fromHr: number, toHr: number): number {
  let cost = 0;
  for (let i = 0; i < rates.length; i++) {
    const s = Math.max(fromHr, BRACKET_CUTS[i]);
    const e = Math.min(toHr, BRACKET_CUTS[i + 1]);
    if (e > s) cost += (e - s) * rates[i];
  }
  return cost;
}

// Indian national / public holidays — update annually.
// Dates that are also weekends get the HIGHER of the two rates (holiday wins if >= weekend).
const HOLIDAYS = new Set([
  // 2026
  "2026-01-01","2026-01-14","2026-01-26",
  "2026-03-23","2026-03-30","2026-04-02","2026-04-03","2026-04-06","2026-04-14",
  "2026-05-01","2026-05-23",
  "2026-06-07","2026-07-27",
  "2026-08-15","2026-08-19",
  "2026-09-04","2026-09-18",
  "2026-10-02","2026-10-21",
  "2026-11-08","2026-11-26",
  "2026-12-25",
  // 2027
  "2027-01-01","2027-01-14","2027-01-26",
  "2027-03-12","2027-03-19","2027-03-31","2027-04-14","2027-04-26",
  "2027-05-01","2027-05-13",
  "2027-06-27",
  "2027-08-15","2027-08-28",
  "2027-09-24",
  "2027-10-02","2027-10-10","2027-10-28",
  "2027-11-18",
  "2027-12-25",
]);

function getDayType(dateStr: string): "holiday" | "weekend" | "weekday" {
  if (HOLIDAYS.has(dateStr)) return "holiday";
  const dow = new Date(dateStr + "T00:00:00Z").getUTCDay();
  if (dow === 0 || dow === 6) return "weekend";
  return "weekday";
}

function getDayMultiplier(type: "holiday" | "weekend" | "weekday"): number {
  if (type === "holiday") return 1.10;
  if (type === "weekend") return 1.20;
  return 1.0;
}

// Converts a UTC ms timestamp to an IST calendar date string "YYYY-MM-DD".
function toISTDate(ms: number): string {
  const ist = new Date(ms + 5.5 * 3600000);
  return ist.toISOString().slice(0, 10);
}

function calcPrice(pricePerDay: number, pickup: Date, drop: Date, category = "") {
  const hours = (drop.getTime() - pickup.getTime()) / 3600000;
  if (hours <= 0) return { base: 0, gst: 0, total: 0, discount: 0, days: 0 };

  const rates = getCatBrackets(category, pricePerDay);
  let rawBase = 0, elapsed = 0, cur = pickup.getTime();
  while (cur < drop.getTime()) {
    const chunkEnd = Math.min(cur + 24 * 3600000, drop.getTime());
    const chunkHrs = (chunkEnd - cur) / 3600000;
    const mult     = getDayMultiplier(getDayType(toISTDate(cur)));
    rawBase += getMarginalBase(rates, elapsed, elapsed + chunkHrs) * mult;
    elapsed += chunkHrs;
    cur = chunkEnd;
  }
  const base  = Math.round(rawBase);
  const gst   = Math.round(base * 0.18);
  const total = base + gst;
  const days  = Math.max(1, Math.ceil(hours / 24));
  return { base, gst, total, discount: 0, days };
}

// `verifiedUserId` must come from a real (non-guest) OTP-verified JWT — guest/demo bookings never pass one,
// so ANY coupon now requires the customer to complete phone+OTP signup/login before it can be applied.
async function applyCoupon(
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

async function getUser(req: Request) {
  const token = getUserToken(req);
  if (!token) return null;
  try {
    return await verifyJwt(token, Deno.env.get("JWT_SECRET")!) as { id: string; phone: string };
  } catch { return null; }
}

async function razorpayCreate(body: Record<string, unknown>) {
  const auth = btoa(`${Deno.env.get("RAZORPAY_KEY_ID")}:${Deno.env.get("RAZORPAY_KEY_SECRET")}`);
  const res  = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function verifyRazorpay(orderId: string, paymentId: string, signature: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(Deno.env.get("RAZORPAY_KEY_SECRET")!),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(`${orderId}|${paymentId}`));
  const expected = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}

function mapBooking(b: Record<string, unknown>) {
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const url  = new URL(req.url);
  const path = url.pathname.replace("/payment", "") || "/";

  const MAX_REGULAR_HOURS = 14 * 24; // 336 hrs — 15+ days must use Monthly Lease
  const durationError = (p: string, d: string) =>
    (new Date(d).getTime() - new Date(p).getTime()) / 3600000 >= MAX_REGULAR_HOURS
      ? json({ error: "Regular bookings are limited to 14 days. Please use Monthly Lease for longer durations." }, 400)
      : null;

  try {
    // POST /hold — temporarily reserves a car for the customer's session.
    // The car_holds table has UNIQUE(car_id) so only ONE hold can exist per
    // car at a time. The atomic INSERT is what prevents the race condition —
    // two concurrent requests that both clear the way and then INSERT will
    // have only one succeed; the other gets a unique-violation (23505) → 409.
    if (req.method === "POST" && path === "/hold") {
      const { carId, pickupDate, dropDate, sessionId } = await req.json();
      if (!carId || !pickupDate || !dropDate || !sessionId)
        return json({ error: "carId, pickupDate, dropDate, sessionId required" }, 400);

      const pISO    = new Date(pickupDate).toISOString();
      const dISO    = new Date(dropDate).toISOString();
      const nowISO  = new Date().toISOString();
      const expires = new Date(Date.now() + HOLD_MINUTES * 60000).toISOString();

      // Block regular bookings ≥ 15 days — must use Monthly Lease
      const holdHrs = (new Date(dISO).getTime() - new Date(pISO).getTime()) / 3600000;
      if (holdHrs >= 15 * 24)
        return json({ error: "Regular bookings are limited to 14 days. Please use Monthly Lease for longer durations." }, 400);

      // Block if there's a real booking or pause conflict (not holds — handled below)
      const [{ data: bookingConflict }, { data: pauseConflict }] = await Promise.all([
        sb.from("bookings").select("id").eq("car_id", carId)
          .in("status", ["confirmed", "active", "pending_kyc", "pending", "completed"])
          .lt("pickup_date", dISO).gt("drop_date", pISO).maybeSingle(),
        sb.from("car_pauses").select("id").eq("car_id", carId)
          .lt("from_date", dISO).gt("to_date", pISO).maybeSingle(),
      ]);
      if (bookingConflict || pauseConflict) return json({ error: CONFLICT_MSG }, 400);

      // Remove our own previous hold + any expired holds for this car,
      // then attempt the atomic insert. The UNIQUE(car_id) constraint
      // means exactly one of any concurrent inserts will succeed.
      await Promise.all([
        sb.from("car_holds").delete().eq("car_id", carId).eq("session_id", sessionId),
        sb.from("car_holds").delete().eq("car_id", carId).lt("expires_at", nowISO),
      ]);

      const { data: hold, error } = await sb.from("car_holds").insert({
        id: crypto.randomUUID(), car_id: carId,
        pickup_date: pISO, drop_date: dISO,
        session_id: sessionId, expires_at: expires,
      }).select("id, expires_at").maybeSingle();

      if (error) {
        // 23505 = unique_violation — another customer grabbed this car first
        if (error.code === "23505")
          return json({ error: "This car is currently on hold by another customer. Please check back in a few minutes." }, 409);
        throw error;
      }

      return json({ holdId: (hold as Record<string, unknown>).id, expiresAt: expires, minutesLeft: HOLD_MINUTES });
    }

    // DELETE /hold — release a hold when customer navigates away or books successfully
    if (req.method === "DELETE" && path === "/hold") {
      const { carId, sessionId } = await req.json();
      if (carId && sessionId)
        await sb.from("car_holds").delete().eq("car_id", carId).eq("session_id", sessionId);
      return json({ success: true });
    }

    // POST /guest-order
    if (req.method === "POST" && path === "/guest-order") {
      const { phone, name, carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: gdc, couponCode, depositChoice, sessionId: gSessionId } = await req.json();
      if (!phone || !/^[6-9]\d{9}$/.test(phone))
        return json({ error: "Valid 10-digit Indian mobile number required" }, 400);

      const { data: car } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      const c = car as Record<string, unknown> | null;
      if (!c || !c.active) return json({ error: "Car not available" }, 404);

      const pickup = new Date(pickupDate), drop = new Date(dropDate);
      const gDurErr = durationError(pickup.toISOString(), drop.toISOString());
      if (gDurErr) return gDurErr;
      if (await hasDateConflict(carId, pickup.toISOString(), drop.toISOString(), gSessionId)) return json({ error: CONFLICT_MSG }, 400);
      const { total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop, (c.category as string) || "");
      const deliveryFee = typeof gdc === "number" && gdc > 0 ? gdc : 0;
      const { discount: couponDiscount, code: appliedCoupon } = await applyCoupon(baseTotal, couponCode);
      const chosenDeposit = resolveDepositChoice(depositChoice);
      const depositNow = chosenDeposit === "now" ? DEPOSIT_AMOUNT : 0;
      const total = baseTotal + deliveryFee + depositNow - couponDiscount;

      let { data: user } = await sb.from("profiles").select("id, name").eq("phone", phone).maybeSingle();
      const u = user as Record<string, unknown> | null;
      if (!u) {
        const id = crypto.randomUUID();
        await sb.from("profiles").insert({ id, phone, name: name ?? "" });
        user = { id, name: name ?? "" };
      } else if (name && !u.name) {
        await sb.from("profiles").update({ name }).eq("id", u.id);
      }
      const userId = (user as Record<string, unknown>).id as string;

      const order = await razorpayCreate({ amount: total * 100, currency: "INR", receipt: makeBookingId(), notes: { carId, phone } });
      const token = await signJwt({ id: userId, phone }, Deno.env.get("JWT_SECRET")!, 2 * 60 * 60);

      return json({
        orderId: order.id, amount: total, currency: "INR",
        keyId: Deno.env.get("RAZORPAY_KEY_ID"),
        days, pricePerDay: c.price_per_day, discount,
        deposit: DEPOSIT_AMOUNT, depositChoice: chosenDeposit, carName: c.name, guestToken: token, deliveryFee,
        couponDiscount, appliedCoupon,
      });
    }

    // POST /validate-coupon — lets a customer type in a private/exclusive
    // code that isn't in the public offers list and find out if it's real,
    // without creating a Razorpay order. Read-only: never consumes a
    // one-time code (that only happens for real at /verify).
    if (req.method === "POST" && path === "/validate-coupon") {
      const user = await getUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const { carId, pickupDate, dropDate, couponCode } = await req.json();
      const { data: car } = await sb.from("cars").select("price_per_day").eq("id", carId).maybeSingle();
      const c = car as Record<string, unknown> | null;
      if (!c) return json({ error: "Car not available" }, 404);

      const { total: baseTotal } = calcPrice(c.price_per_day as number, new Date(pickupDate), new Date(dropDate), (c.category as string) || "");
      const { discount, code } = await applyCoupon(baseTotal, couponCode, { verifiedUserId: user.id });
      if (!code) return json({ error: "Invalid or expired coupon code." }, 400);
      return json({ discount, code });
    }

    // POST /order
    if (req.method === "POST" && path === "/order") {
      const user = await getUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const { carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: odc, couponCode, depositChoice, sessionId: oSessionId } = await req.json();
      const { data: car } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      const c = car as Record<string, unknown> | null;
      if (!c || !c.active) return json({ error: "Car not available" }, 404);

      const pISO = new Date(pickupDate).toISOString(), dISO = new Date(dropDate).toISOString();
      const oDurErr = durationError(pISO, dISO);
      if (oDurErr) return oDurErr;
      if (await hasDateConflict(carId, pISO, dISO, oSessionId)) return json({ error: CONFLICT_MSG }, 400);

      const pickup = new Date(pickupDate), drop = new Date(dropDate);
      const { total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop, (c.category as string) || "");
      const deliveryFee = typeof odc === "number" && odc > 0 ? odc : 0;
      const { discount: couponDiscount, code: appliedCoupon } = await applyCoupon(baseTotal, couponCode, { verifiedUserId: user.id });
      const chosenDeposit = resolveDepositChoice(depositChoice);
      const depositNow = chosenDeposit === "now" ? DEPOSIT_AMOUNT : 0;
      const total = baseTotal + deliveryFee + depositNow - couponDiscount;

      const order = await razorpayCreate({ amount: total * 100, currency: "INR", receipt: makeBookingId(), notes: { carId, phone: user.phone } });
      return json({
        orderId: order.id, amount: total, currency: "INR",
        keyId: Deno.env.get("RAZORPAY_KEY_ID"),
        days, pricePerDay: c.price_per_day, discount, deposit: DEPOSIT_AMOUNT, depositChoice: chosenDeposit, carName: c.name, deliveryFee,
        couponDiscount, appliedCoupon,
      });
    }

    // POST /verify
    if (req.method === "POST" && path === "/verify") {
      const user = await getUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const { razorpayOrderId, razorpayPaymentId, razorpaySignature, carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: vdc, couponCode, depositChoice, sessionId: vSessionId } = await req.json();

      if (!await verifyRazorpay(razorpayOrderId, razorpayPaymentId, razorpaySignature))
        return json({ error: "Payment verification failed" }, 400);

      const [{ data: car }, { data: profile }] = await Promise.all([
        sb.from("cars").select("*").eq("id", carId).maybeSingle(),
        sb.from("profiles").select("*").eq("id", user.id).maybeSingle(),
      ]);
      const c = car as Record<string, unknown>, p = profile as Record<string, unknown>;

      const pickup = new Date(pickupDate), drop = new Date(dropDate);
      // This is the endpoint that actually inserts the booking row — it
      // previously had NO conflict check at all (only /order, the earlier
      // preview step, did, and even that missed pauses). A booking made or
      // a pause added between /order and /verify could slip through.
      if (await hasDateConflict(carId, pickup.toISOString(), drop.toISOString(), vSessionId)) return json({ error: CONFLICT_MSG }, 400);
      const { total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop, (c.category as string) || "");
      const deliveryFee = typeof vdc === "number" && vdc > 0 ? vdc : 0;
      const { discount: couponDiscount, code: appliedCoupon } = await applyCoupon(baseTotal, couponCode, { verifiedUserId: p.id as string, consume: true });
      const chosenDeposit = resolveDepositChoice(depositChoice);
      const depositPaidNow = chosenDeposit === "now";
      const total = baseTotal + deliveryFee + (depositPaidNow ? DEPOSIT_AMOUNT : 0) - couponDiscount;
      const bookingId = makeBookingId();
      const isConfirmed = p.kyc_status === "verified";

      const { data: booking, error } = await sb.from("bookings").insert({
        id: crypto.randomUUID(), booking_id: bookingId,
        car_id: c.id, car_name: c.name,
        user_id: p.id, customer: p.name ?? "", phone: p.phone,
        pickup_date: pickup.toISOString(), pickup_location: pickupLocation ?? "Pune",
        drop_date: drop.toISOString(), drop_location: dropLocation ?? "Pune",
        days, price_per_day: c.price_per_day, total,
        deposit: 0, discount, delivery_fee: deliveryFee,
        deposit_amount: DEPOSIT_AMOUNT, deposit_choice: chosenDeposit,
        deposit_paid: depositPaidNow, deposit_paid_at: depositPaidNow ? new Date().toISOString() : null,
        deposit_razorpay_payment_id: depositPaidNow ? razorpayPaymentId : null,
        coupon_code: appliedCoupon, coupon_discount: couponDiscount,
        razorpay_order_id: razorpayOrderId, razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature, payment_status: "paid",
        paid_at: new Date().toISOString(),
        status: isConfirmed ? "confirmed" : "pending_kyc",
        // Check-in OTP is generated as soon as the booking is confirmed,
        // so the fleet manager has it ready before the customer even uploads photos.
        checkin_otp: isConfirmed ? generateOtp() : null,
      }).select("*").maybeSingle();
      if (error) throw error;

      if (isConfirmed && p.email) {
        sendBookingConfirmationEmail({
          to: p.email as string, customerName: p.name as string, bookingId,
          carName: c.name as string, pickupDate: pickup.toISOString(), dropDate: drop.toISOString(),
          pickupLocation: (pickupLocation as string) ?? "Pune", total,
          customerPhone: p.phone as string | undefined,
        }).catch((e) => console.error("Booking confirmation email failed", bookingId, (e as Error).message));
      }


      const token = await signJwt({ id: p.id, phone: p.phone }, Deno.env.get("JWT_SECRET")!, 30 * 24 * 60 * 60);
      return json({ success: true, bookingId, booking: mapBooking(booking as Record<string, unknown>), token });
    }

    // POST /direct — create booking without Razorpay (test / demo mode)
    if (req.method === "POST" && path === "/direct") {
      const user = await getUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const { carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: dc, couponCode, depositChoice, sessionId: dSessionId } = await req.json();
      const [{ data: car }, { data: profile }] = await Promise.all([
        sb.from("cars").select("*").eq("id", carId).maybeSingle(),
        sb.from("profiles").select("*").eq("id", user.id).maybeSingle(),
      ]);
      const c = car as Record<string, unknown> | null;
      const p = profile as Record<string, unknown> | null;
      if (!c || !c.active) return json({ error: "Car not available" }, 404);
      if (!p) return json({ error: "Profile not found" }, 404);

      const pickup = new Date(pickupDate), drop = new Date(dropDate);
      const pISO = pickup.toISOString(), dISO = drop.toISOString();
      const dDurErr = durationError(pISO, dISO);
      if (dDurErr) return dDurErr;
      if (await hasDateConflict(carId, pISO, dISO, dSessionId)) return json({ error: CONFLICT_MSG }, 400);

      const { total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop, (c.category as string) || "");
      const deliveryFee = typeof dc === "number" && dc > 0 ? dc : 0;
      const { discount: couponDiscount, code: appliedCoupon } = await applyCoupon(baseTotal, couponCode, { verifiedUserId: p.id as string, consume: true });
      const total = baseTotal + deliveryFee - couponDiscount;
      const bookingId = makeBookingId();
      const isConfirmedDirect = p.kyc_status === "verified";

      const { data: booking, error } = await sb.from("bookings").insert({
        id: crypto.randomUUID(), booking_id: bookingId,
        car_id: c.id, car_name: c.name,
        user_id: p.id, customer: p.name ?? "", phone: p.phone,
        pickup_date: pISO, pickup_location: pickupLocation ?? "Katraj Hub, Pune",
        drop_date: dISO, drop_location: dropLocation ?? "Katraj Hub, Pune",
        days, price_per_day: c.price_per_day, total,
        deposit: 0, discount, delivery_fee: deliveryFee,
        deposit_amount: DEPOSIT_AMOUNT, deposit_choice: resolveDepositChoice(depositChoice),
        coupon_code: appliedCoupon, coupon_discount: couponDiscount,
        payment_status: "demo",
        // Auto-confirm if KYC already verified
        status: isConfirmedDirect ? "confirmed" : "pending_kyc",
        checkin_otp: isConfirmedDirect ? generateOtp() : null,
      }).select("*").maybeSingle();
      if (error) throw error;

      if (isConfirmedDirect && p.email) {
        sendBookingConfirmationEmail({
          to: p.email as string, customerName: p.name as string, bookingId,
          carName: c.name as string, pickupDate: pISO, dropDate: dISO,
          pickupLocation: (pickupLocation as string) ?? "Katraj Hub, Pune", total,
          customerPhone: p.phone as string | undefined,
        }).catch((e) => console.error("Booking confirmation email failed", bookingId, (e as Error).message));
      }


      const token = await signJwt({ id: p.id, phone: p.phone }, Deno.env.get("JWT_SECRET")!, 30 * 24 * 60 * 60);
      return json({ success: true, bookingId, booking: mapBooking(booking as Record<string, unknown>), token });
    }

    // POST /guest-direct — create booking for demo/offline users (no JWT, just phone)
    if (req.method === "POST" && path === "/guest-direct") {
      const { phone, name, carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: gddc, couponCode, depositChoice, sessionId: gdSessionId } = await req.json();
      if (!phone) return json({ error: "Phone required" }, 400);

      const { data: car } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      const c = car as Record<string, unknown> | null;
      if (!c || !c.active) return json({ error: "Car not available" }, 404);

      const pISO2 = new Date(pickupDate).toISOString(), dISO2 = new Date(dropDate).toISOString();
      const gdDurErr = durationError(pISO2, dISO2);
      if (gdDurErr) return gdDurErr;
      if (await hasDateConflict(carId, pISO2, dISO2, gdSessionId)) return json({ error: CONFLICT_MSG }, 400);

      let { data: prof } = await sb.from("profiles").select("*").eq("phone", phone).maybeSingle();
      if (!prof) {
        const id = crypto.randomUUID();
        await sb.from("profiles").insert({ id, phone, name: name ?? "" });
        const { data: newProf } = await sb.from("profiles").select("*").eq("id", id).maybeSingle();
        prof = newProf;
      } else if (name && !(prof as Record<string, unknown>).name) {
        await sb.from("profiles").update({ name }).eq("phone", phone);
      }
      const p = prof as Record<string, unknown>;

      const pickup = new Date(pISO2), drop = new Date(dISO2);
      const { total: baseTotal2, discount, days } = calcPrice(c.price_per_day as number, pickup, drop, (c.category as string) || "");
      const deliveryFee2 = typeof gddc === "number" && gddc > 0 ? gddc : 0;
      const { discount: couponDiscount, code: appliedCoupon } = await applyCoupon(baseTotal2, couponCode);
      const total = baseTotal2 + deliveryFee2 - couponDiscount;
      const bookingId = makeBookingId();
      const isConfirmedGuest = p.kyc_status === "verified";

      const { data: booking, error } = await sb.from("bookings").insert({
        id: crypto.randomUUID(), booking_id: bookingId,
        car_id: c.id, car_name: c.name,
        user_id: p.id, customer: (p.name as string) ?? "", phone: p.phone,
        pickup_date: pISO2, pickup_location: pickupLocation ?? "Pune",
        drop_date: dISO2, drop_location: dropLocation ?? "Pune",
        days, price_per_day: c.price_per_day, total,
        deposit: 0, discount, delivery_fee: deliveryFee2,
        deposit_amount: DEPOSIT_AMOUNT, deposit_choice: resolveDepositChoice(depositChoice),
        coupon_code: appliedCoupon, coupon_discount: couponDiscount,
        payment_status: "demo",
        status: isConfirmedGuest ? "confirmed" : "pending_kyc",
        checkin_otp: isConfirmedGuest ? generateOtp() : null,
      }).select("*").maybeSingle();
      if (error) throw error;

      if (isConfirmedGuest && p.email) {
        sendBookingConfirmationEmail({
          to: p.email as string, customerName: p.name as string, bookingId,
          carName: c.name as string, pickupDate: pISO2, dropDate: dISO2,
          pickupLocation: (pickupLocation as string) ?? "Pune", total,
          customerPhone: p.phone as string | undefined,
        }).catch((e) => console.error("Booking confirmation email failed", bookingId, (e as Error).message));
      }


      const token = await signJwt({ id: p.id, phone: p.phone }, Deno.env.get("JWT_SECRET")!, 30 * 24 * 60 * 60);
      return json({ success: true, bookingId, booking: mapBooking(booking as Record<string, unknown>), token });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
