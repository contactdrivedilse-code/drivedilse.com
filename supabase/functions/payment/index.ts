import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { signJwt, verifyJwt, getBearer } from "../_shared/jwt.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function makeBookingId(): string { return "DS" + Date.now().toString(36).toUpperCase(); }

function calcMultiplier(hours: number): number {
  const days = hours / 24;
  if (hours <= 8)  return 1.30;
  if (hours <= 12) return 1.15;
  if (days <= 1)   return 1.00;
  if (days <= 3)   return 0.95;
  if (days <= 5)   return 0.92;
  if (days <= 7)   return 0.90;
  if (days <= 14)  return 0.85;
  if (days <= 21)  return 0.80;
  return 0.75;
}

function calcPrice(pricePerDay: number, pickup: Date, drop: Date) {
  const hours    = (drop.getTime() - pickup.getTime()) / 3600000;
  const mult     = calcMultiplier(hours);
  const base     = Math.round(pricePerDay * mult * hours / 24);
  const gst      = Math.round(base * 0.18);
  const total    = base + gst;
  const full     = Math.round(pricePerDay * hours / 24);
  const discount = Math.max(0, full - base);
  const days     = Math.max(1, Math.ceil(hours / 24));
  return { base, gst, total, discount, days };
}

async function getUser(req: Request) {
  const token = getBearer(req);
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

  try {
    // POST /guest-order
    if (req.method === "POST" && path === "/guest-order") {
      const { phone, name, carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: gdc } = await req.json();
      if (!phone || !/^[6-9]\d{9}$/.test(phone))
        return json({ error: "Valid 10-digit Indian mobile number required" }, 400);

      const { data: car } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      const c = car as Record<string, unknown> | null;
      if (!c || !c.active) return json({ error: "Car not available" }, 404);

      const pickup = new Date(pickupDate), drop = new Date(dropDate);
      const { total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop);
      const deliveryFee = typeof gdc === "number" && gdc > 0 ? gdc : 0;
      const total = baseTotal + deliveryFee;

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
        deposit: 0, carName: c.name, guestToken: token, deliveryFee,
      });
    }

    // POST /order
    if (req.method === "POST" && path === "/order") {
      const user = await getUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const { carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: odc } = await req.json();
      const { data: car } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      const c = car as Record<string, unknown> | null;
      if (!c || !c.active) return json({ error: "Car not available" }, 404);

      const pISO = new Date(pickupDate).toISOString(), dISO = new Date(dropDate).toISOString();
      const { data: conflict } = await sb.from("bookings").select("id").eq("car_id", carId)
        .in("status", ["confirmed", "active", "completed"]).lt("pickup_date", dISO).gt("drop_date", pISO).maybeSingle();
      if (conflict) return json({ error: "Car is already booked for these dates or in preparation (4-hour buffer after last trip)" }, 400);

      const pickup = new Date(pickupDate), drop = new Date(dropDate);
      const { total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop);
      const deliveryFee = typeof odc === "number" && odc > 0 ? odc : 0;
      const total = baseTotal + deliveryFee;

      const order = await razorpayCreate({ amount: total * 100, currency: "INR", receipt: makeBookingId(), notes: { carId, phone: user.phone } });
      return json({
        orderId: order.id, amount: total, currency: "INR",
        keyId: Deno.env.get("RAZORPAY_KEY_ID"),
        days, pricePerDay: c.price_per_day, discount, deposit: 0, carName: c.name, deliveryFee,
      });
    }

    // POST /verify
    if (req.method === "POST" && path === "/verify") {
      const user = await getUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const { razorpayOrderId, razorpayPaymentId, razorpaySignature, carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: vdc } = await req.json();

      if (!await verifyRazorpay(razorpayOrderId, razorpayPaymentId, razorpaySignature))
        return json({ error: "Payment verification failed" }, 400);

      const [{ data: car }, { data: profile }] = await Promise.all([
        sb.from("cars").select("*").eq("id", carId).maybeSingle(),
        sb.from("profiles").select("*").eq("id", user.id).maybeSingle(),
      ]);
      const c = car as Record<string, unknown>, p = profile as Record<string, unknown>;

      const pickup = new Date(pickupDate), drop = new Date(dropDate);
      const { total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop);
      const deliveryFee = typeof vdc === "number" && vdc > 0 ? vdc : 0;
      const total = baseTotal + deliveryFee;
      const bookingId = makeBookingId();

      const { data: booking, error } = await sb.from("bookings").insert({
        id: crypto.randomUUID(), booking_id: bookingId,
        car_id: c.id, car_name: c.name,
        user_id: p.id, customer: p.name ?? "", phone: p.phone,
        pickup_date: pickup.toISOString(), pickup_location: pickupLocation ?? "Pune",
        drop_date: drop.toISOString(), drop_location: dropLocation ?? "Pune",
        days, price_per_day: c.price_per_day, total,
        deposit: 0, discount, delivery_fee: deliveryFee,
        razorpay_order_id: razorpayOrderId, razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature, payment_status: "paid",
        paid_at: new Date().toISOString(),
        status: (p.kyc_status === "verified") ? "confirmed" : "pending_kyc",
      }).select("*").maybeSingle();
      if (error) throw error;

      const token = await signJwt({ id: p.id, phone: p.phone }, Deno.env.get("JWT_SECRET")!, 30 * 24 * 60 * 60);
      return json({ success: true, bookingId, booking: mapBooking(booking as Record<string, unknown>), token });
    }

    // POST /direct — create booking without Razorpay (test / demo mode)
    if (req.method === "POST" && path === "/direct") {
      const user = await getUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const { carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: dc } = await req.json();
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
      const { data: conflict } = await sb.from("bookings").select("id").eq("car_id", carId)
        .in("status", ["confirmed", "active", "completed"]).lt("pickup_date", dISO).gt("drop_date", pISO).maybeSingle();
      if (conflict) return json({ error: "Car is already booked for these dates or in preparation (4-hour buffer after last trip)" }, 400);

      const { total: baseTotal, discount, days } = calcPrice(c.price_per_day as number, pickup, drop);
      const deliveryFee = typeof dc === "number" && dc > 0 ? dc : 0;
      const total = baseTotal + deliveryFee;
      const bookingId = makeBookingId();

      const { data: booking, error } = await sb.from("bookings").insert({
        id: crypto.randomUUID(), booking_id: bookingId,
        car_id: c.id, car_name: c.name,
        user_id: p.id, customer: p.name ?? "", phone: p.phone,
        pickup_date: pISO, pickup_location: pickupLocation ?? "Katraj Hub, Pune",
        drop_date: dISO, drop_location: dropLocation ?? "Katraj Hub, Pune",
        days, price_per_day: c.price_per_day, total,
        deposit: 0, discount, delivery_fee: deliveryFee,
        payment_status: "demo",
        // Auto-confirm if KYC already verified
        status: (p.kyc_status === "verified") ? "confirmed" : "pending_kyc",
      }).select("*").maybeSingle();
      if (error) throw error;

      const token = await signJwt({ id: p.id, phone: p.phone }, Deno.env.get("JWT_SECRET")!, 30 * 24 * 60 * 60);
      return json({ success: true, bookingId, booking: mapBooking(booking as Record<string, unknown>), token });
    }

    // POST /guest-direct — create booking for demo/offline users (no JWT, just phone)
    if (req.method === "POST" && path === "/guest-direct") {
      const { phone, name, carId, pickupDate, dropDate, pickupLocation, dropLocation, deliveryCharge: gddc } = await req.json();
      if (!phone) return json({ error: "Phone required" }, 400);

      const { data: car } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      const c = car as Record<string, unknown> | null;
      if (!c || !c.active) return json({ error: "Car not available" }, 404);

      const pISO2 = new Date(pickupDate).toISOString(), dISO2 = new Date(dropDate).toISOString();
      const { data: conflict2 } = await sb.from("bookings").select("id").eq("car_id", carId)
        .in("status", ["confirmed", "active", "completed"]).lt("pickup_date", dISO2).gt("drop_date", pISO2).maybeSingle();
      if (conflict2) return json({ error: "Car is already booked for these dates or in preparation (4-hour buffer after last trip)" }, 400);

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
      const { total: baseTotal2, discount, days } = calcPrice(c.price_per_day as number, pickup, drop);
      const deliveryFee2 = typeof gddc === "number" && gddc > 0 ? gddc : 0;
      const total = baseTotal2 + deliveryFee2;
      const bookingId = makeBookingId();

      const { data: booking, error } = await sb.from("bookings").insert({
        id: crypto.randomUUID(), booking_id: bookingId,
        car_id: c.id, car_name: c.name,
        user_id: p.id, customer: (p.name as string) ?? "", phone: p.phone,
        pickup_date: pISO2, pickup_location: pickupLocation ?? "Pune",
        drop_date: dISO2, drop_location: dropLocation ?? "Pune",
        days, price_per_day: c.price_per_day, total,
        deposit: 0, discount, delivery_fee: deliveryFee2,
        payment_status: "demo",
        status: (p.kyc_status === "verified") ? "confirmed" : "pending_kyc",
      }).select("*").maybeSingle();
      if (error) throw error;

      const token = await signJwt({ id: p.id, phone: p.phone }, Deno.env.get("JWT_SECRET")!, 30 * 24 * 60 * 60);
      return json({ success: true, bookingId, booking: mapBooking(booking as Record<string, unknown>), token });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
