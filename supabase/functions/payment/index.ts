import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { signJwt, verifyJwt, getUserToken } from "../_shared/jwt.ts";
import { sendBookingConfirmationEmail } from "../_shared/email.ts";
import { checkRateLimit } from "../_shared/ratelimit.ts";
import { calcPrice } from "../_shared/pricing.ts";
import { computeOrderPaymentSignature } from "../_shared/razorpay.ts";
import {
  DEPOSIT_AMOUNT, resolveDepositChoice, resolveDeliveryFee,
  makeBookingId, generateOtp, hasDateConflict, CONFLICT_MSG,
  applyCoupon, mapBooking, createBooking,
} from "../_shared/booking.ts";
// Zoho Books invoice generation removed

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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
  const expected = await computeOrderPaymentSignature(orderId, paymentId, Deno.env.get("RAZORPAY_KEY_SECRET")!);
  return expected === signature;
}

// Stashes everything needed to reconstruct the booking from a bare Razorpay
// order id — read by the payment.captured webhook (payment-webhook/index.ts)
// if the client-side /verify call never happens (e.g. a UPI app redirect
// kills the browser tab before it can come back and confirm).
async function savePendingOrder(orderId: string, p: {
  userId: string; carId: string; pickupDate: string; dropDate: string;
  pickupLocation?: string; dropLocation?: string; deliveryFee: number;
  couponCode?: string; depositChoice: "now" | "later"; sessionId?: string;
}) {
  const { error } = await sb.from("pending_orders").insert({
    razorpay_order_id: orderId, user_id: p.userId, car_id: p.carId,
    pickup_date: p.pickupDate, drop_date: p.dropDate,
    pickup_location: p.pickupLocation ?? null, drop_location: p.dropLocation ?? null,
    delivery_fee: p.deliveryFee, coupon_code: p.couponCode ?? null,
    deposit_choice: p.depositChoice, session_id: p.sessionId ?? null,
  });
  if (error) console.error("savePendingOrder failed", orderId, error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);

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
      const expires = new Date(Date.now() + 10 * 60000).toISOString();

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

      return json({ holdId: (hold as Record<string, unknown>).id, expiresAt: expires, minutesLeft: 10 });
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
      // IP rate limit: 10 guest order attempts per IP per 10 minutes.
      const grl = await checkRateLimit(sb, req, "payment-order", 10, 600);
      if (!grl.allowed) return json({ error: "Too many requests. Please try again later." }, 429);

      const { phone, name, carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: gdc, couponCode, depositChoice, sessionId: gSessionId } = await req.json();
      if (!phone || !/^[6-9]\d{9}$/.test(phone))
        return json({ error: "Valid 10-digit Indian mobile number required" }, 400);

      const { data: car } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      const c = car as Record<string, unknown> | null;
      if (!c || !c.active) return json({ error: "Car not available" }, 404);

      const pickup = new Date(pickupDate), drop = new Date(dropDate);
      const gDurErr = durationError(pickup.toISOString(), drop.toISOString());
      if (gDurErr) return gDurErr;
      if (await hasDateConflict(sb, carId, pickup.toISOString(), drop.toISOString(), gSessionId)) return json({ error: CONFLICT_MSG }, 400);
      const { base: baseFare, total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop, (c.category as string) || "");
      const deliveryFee = resolveDeliveryFee(gdc);

      // Look up (or create) the guest profile first so we can pass verifiedUserId
      // to applyCoupon — without it, applyCoupon always returns 0 discount.
      let { data: user } = await sb.from("profiles").select("id, name").eq("phone", phone).maybeSingle();
      const u = user as Record<string, unknown> | null;
      if (!u) {
        const id = crypto.randomUUID();
        await sb.from("profiles").insert({ id, phone, name: name ?? "", phone_verified: true });
        user = { id, name: name ?? "" };
      } else if (name && !u.name) {
        await sb.from("profiles").update({ name }).eq("id", u.id);
      }
      const userId = (user as Record<string, unknown>).id as string;

      const { discount: couponDiscount, code: appliedCoupon } = await applyCoupon(sb, baseTotal, couponCode, { verifiedUserId: userId });
      const chosenDeposit = resolveDepositChoice(depositChoice);
      const depositNow = chosenDeposit === "now" ? DEPOSIT_AMOUNT : 0;
      const gst = Math.round((baseFare + deliveryFee) * 0.18);
      const total = baseFare + deliveryFee + gst + depositNow - couponDiscount;

      const order = await razorpayCreate({ amount: total * 100, currency: "INR", receipt: makeBookingId(), notes: { carId, phone } });
      const token = await signJwt({ id: userId, phone }, Deno.env.get("JWT_SECRET")!, 2 * 60 * 60);
      await savePendingOrder(order.id, {
        userId, carId, pickupDate: pickup.toISOString(), dropDate: drop.toISOString(),
        pickupLocation, dropLocation, deliveryFee, couponCode: appliedCoupon ?? undefined,
        depositChoice: chosenDeposit, sessionId: gSessionId,
      });

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
      const { discount, code } = await applyCoupon(sb, baseTotal, couponCode, { verifiedUserId: user.id });
      if (!code) return json({ error: "Invalid or expired coupon code." }, 400);
      return json({ discount, code });
    }

    // POST /order
    if (req.method === "POST" && path === "/order") {
      // IP rate limit: 10 order attempts per IP per 10 minutes. Blocks bots creating fake orders.
      const rl = await checkRateLimit(sb, req, "payment-order", 10, 600);
      if (!rl.allowed) return json({ error: "Too many requests. Please try again later." }, 429);

      const user = await getUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const { carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: odc, couponCode, depositChoice, sessionId: oSessionId } = await req.json();
      const { data: car } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      const c = car as Record<string, unknown> | null;
      if (!c || !c.active) return json({ error: "Car not available" }, 404);

      const pISO = new Date(pickupDate).toISOString(), dISO = new Date(dropDate).toISOString();
      const oDurErr = durationError(pISO, dISO);
      if (oDurErr) return oDurErr;
      if (await hasDateConflict(sb, carId, pISO, dISO, oSessionId)) return json({ error: CONFLICT_MSG }, 400);

      const pickup = new Date(pickupDate), drop = new Date(dropDate);
      const { base: baseFare, total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop, (c.category as string) || "");
      const deliveryFee = resolveDeliveryFee(odc);
      const { discount: couponDiscount, code: appliedCoupon } = await applyCoupon(sb, baseTotal, couponCode, { verifiedUserId: user.id });
      const chosenDeposit = resolveDepositChoice(depositChoice);
      const depositNow = chosenDeposit === "now" ? DEPOSIT_AMOUNT : 0;
      const gst = Math.round((baseFare + deliveryFee) * 0.18);
      const total = baseFare + deliveryFee + gst + depositNow - couponDiscount;

      const order = await razorpayCreate({ amount: total * 100, currency: "INR", receipt: makeBookingId(), notes: { carId, phone: user.phone } });
      await savePendingOrder(order.id, {
        userId: user.id, carId, pickupDate: pISO, dropDate: dISO,
        pickupLocation, dropLocation, deliveryFee, couponCode: appliedCoupon ?? undefined,
        depositChoice: chosenDeposit, sessionId: oSessionId,
      });

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

      const result = await createBooking(sb, {
        userId: user.id, carId, pickupDate, dropDate, pickupLocation, dropLocation,
        deliveryCharge: vdc, couponCode, depositChoice, sessionId: vSessionId,
        razorpayOrderId, razorpayPaymentId, razorpaySignature,
      });
      if (!result.ok) return json({ error: result.message }, result.reason === "blacklisted" ? 403 : 400);

      const token = await signJwt({ id: user.id, phone: user.phone }, Deno.env.get("JWT_SECRET")!, 30 * 24 * 60 * 60);
      return json({ success: true, bookingId: result.bookingId, booking: mapBooking(result.booking), token });
    }

    // POST /direct — create booking without Razorpay (test / demo mode)
    if (req.method === "POST" && path === "/direct") {
      if (Deno.env.get("ALLOW_DIRECT_BOOKING") !== "true")
        return json({ error: "Not available" }, 403);
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
      if (await hasDateConflict(sb, carId, pISO, dISO, dSessionId)) return json({ error: CONFLICT_MSG }, 400);
      const { data: blEntry2 } = await sb.from("blacklist").select("phone").eq("phone", (p.phone as string || "").replace(/\D/g, "")).maybeSingle();
      if (blEntry2) return json({ error: "Booking unavailable. Please contact support." }, 403);
      const { base: baseFare, total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop, (c.category as string) || "");
      const deliveryFee = resolveDeliveryFee(dc);
      const { discount: couponDiscount, code: appliedCoupon } = await applyCoupon(sb, baseTotal, couponCode, { verifiedUserId: p.id as string, consume: true });
      const gst = Math.round((baseFare + deliveryFee) * 0.18);
      const total = baseFare + deliveryFee + gst - couponDiscount;
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
      if (Deno.env.get("ALLOW_DIRECT_BOOKING") !== "true")
        return json({ error: "Not available" }, 403);
      const { phone, name, carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: gddc, couponCode, depositChoice, sessionId: gdSessionId } = await req.json();
      if (!phone) return json({ error: "Phone required" }, 400);

      const { data: car } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      const c = car as Record<string, unknown> | null;
      if (!c || !c.active) return json({ error: "Car not available" }, 404);

      const pISO2 = new Date(pickupDate).toISOString(), dISO2 = new Date(dropDate).toISOString();
      const gdDurErr = durationError(pISO2, dISO2);
      if (gdDurErr) return gdDurErr;
      if (await hasDateConflict(sb, carId, pISO2, dISO2, gdSessionId)) return json({ error: CONFLICT_MSG }, 400);

      let { data: prof } = await sb.from("profiles").select("*").eq("phone", phone).maybeSingle();
      if (!prof) {
        const id = crypto.randomUUID();
        await sb.from("profiles").insert({ id, phone, name: name ?? "", phone_verified: true });
        const { data: newProf } = await sb.from("profiles").select("*").eq("id", id).maybeSingle();
        prof = newProf;
      } else if (name && !(prof as Record<string, unknown>).name) {
        await sb.from("profiles").update({ name }).eq("phone", phone);
      }
      const p = prof as Record<string, unknown>;

      const { data: blEntry3 } = await sb.from("blacklist").select("phone").eq("phone", (p.phone as string || "").replace(/\D/g, "")).maybeSingle();
      if (blEntry3) return json({ error: "Booking unavailable. Please contact support." }, 403);
      const pickup = new Date(pISO2), drop = new Date(dISO2);
      const { base: baseFare2, total: baseTotal2, discount, days } = calcPrice(c.price_per_day as number, pickup, drop, (c.category as string) || "");
      const deliveryFee2 = resolveDeliveryFee(gddc);
      const { discount: couponDiscount, code: appliedCoupon } = await applyCoupon(sb, baseTotal2, couponCode, { verifiedUserId: p.id as string });
      const gst2 = Math.round((baseFare2 + deliveryFee2) * 0.18);
      const total = baseFare2 + deliveryFee2 + gst2 - couponDiscount;
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
    console.error("[500]", (e as Error).message);
    return json({ error: "Internal server error" }, 500);
  }
});
