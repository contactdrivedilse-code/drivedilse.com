import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { verifyJwt, getBearer } from "../_shared/jwt.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CHECKIN_WINDOW_MINS = 30;
function generateOtp(): string { return String(Math.floor(100000 + Math.random() * 900000)); }

async function getUser(req: Request) {
  const token = getBearer(req);
  if (!token) return null;
  try { return await verifyJwt(token, Deno.env.get("JWT_SECRET")!) as { id: string; phone: string }; }
  catch { return null; }
}

async function uploadPhoto(buf: Uint8Array, mime: string, bookingId: string, side: string): Promise<string> {
  const path = `${bookingId}/${side}.jpg`;
  const { error } = await sb.storage.from("checkin").upload(path, buf, { contentType: mime, upsert: true });
  if (error) throw error;
  return sb.storage.from("checkin").getPublicUrl(path).data.publicUrl;
}

async function verifyRazorpay(orderId: string, paymentId: string, signature: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(Deno.env.get("RAZORPAY_KEY_SECRET")!),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(`${orderId}|${paymentId}`));
  const expected = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}

function mapBooking(b: Record<string, unknown>, exts: Record<string, unknown>[] = []) {
  return {
    _id: b.id, id: b.id, bookingId: b.booking_id,
    car: { _id: b.car_id, id: b.car_id, name: b.car_name }, carName: b.car_name,
    customer: b.customer, phone: b.phone,
    pickup: { date: b.pickup_date, location: b.pickup_location },
    drop:   { date: b.drop_date,   location: b.drop_location },
    days: b.days, pricePerDay: b.price_per_day, total: b.total,
    deposit: b.deposit, discount: b.discount,
    payment: { razorpayOrderId: b.razorpay_order_id, razorpayPaymentId: b.razorpay_payment_id, status: b.payment_status, paidAt: b.paid_at },
    checkin: {
      photos: { front: b.checkin_front, rear: b.checkin_rear, passengerSide: b.checkin_passenger_side, driverSide: b.checkin_driver_side },
      photosUploadedAt: b.checkin_photos_at, otp: b.checkin_otp, otpVerified: b.checkin_otp_verified, checkedInAt: b.checked_in_at,
    },
    checkout: { otp: b.checkout_otp, otpVerified: b.checkout_otp_verified, checkedOutAt: b.checked_out_at },
    status: b.status, cancelledAt: b.cancelled_at, notes: b.notes,
    createdAt: b.created_at, updatedAt: b.updated_at,
    extensions: exts.map(e => ({ hours: e.hours, cost: e.cost, razorpayOrderId: e.razorpay_order_id, extendedAt: e.extended_at })),
  };
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const url  = new URL(req.url);
  const path = url.pathname.replace("/bookings", "") || "/";

  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  try {
    // GET / — user's bookings
    if (req.method === "GET" && (path === "/" || path === "")) {
      const { data: bookings, error } = await sb.from("bookings").select("*")
        .eq("user_id", user.id).order("pickup_date", { ascending: true });
      if (error) throw error;

      const ids = (bookings ?? []).map((b: Record<string, unknown>) => b.id as string);
      const { data: exts } = ids.length
        ? await sb.from("extensions").select("*").in("booking_id", ids)
        : { data: [] };

      const extMap: Record<string, Record<string, unknown>[]> = {};
      for (const e of exts ?? []) {
        const ee = e as Record<string, unknown>;
        const bid = ee.booking_id as string;
        if (!extMap[bid]) extMap[bid] = [];
        extMap[bid].push(ee);
      }

      return json((bookings ?? []).map((b: Record<string, unknown>) => mapBooking(b, extMap[b.id as string])));
    }

    // POST /:id/checkin — upload 4 photos
    const checkinMatch = path.match(/^\/([^/]+)\/checkin$/);
    if (req.method === "POST" && checkinMatch) {
      const id = checkinMatch[1];
      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "confirmed") return json({ error: "Booking is not in confirmed state" }, 400);

      const nowMs    = Date.now();
      const pickupMs = new Date(b.pickup_date as string).getTime();
      if (nowMs < pickupMs - CHECKIN_WINDOW_MINS * 60000)
        return json({ error: `Check-in opens ${CHECKIN_WINDOW_MINS} minutes before your pickup time` }, 400);

      const fd      = await req.formData();
      const sides   = ["front", "rear", "passengerSide", "driverSide"] as const;
      const missing = sides.filter(s => !fd.get(s));
      if (missing.length) return json({ error: `Missing photos: ${missing.join(", ")}` }, 400);

      const [front, rear, passengerSide, driverSide] = await Promise.all(
        sides.map(async (s) => {
          const f = fd.get(s) as File;
          return uploadPhoto(new Uint8Array(await f.arrayBuffer()), f.type, id, s);
        })
      );

      const otp = generateOtp();
      await sb.from("bookings").update({
        checkin_front: front, checkin_rear: rear,
        checkin_passenger_side: passengerSide, checkin_driver_side: driverSide,
        checkin_photos_at: new Date().toISOString(),
        checkin_otp: otp, checkin_otp_verified: false,
        updated_at: new Date().toISOString(),
      }).eq("id", id);

      return json({ success: true, message: "Photos uploaded. Get your check-in OTP from the DriveDilSe representative." });
    }

    // POST /:id/checkin/verify
    const checkinVerifyMatch = path.match(/^\/([^/]+)\/checkin\/verify$/);
    if (req.method === "POST" && checkinVerifyMatch) {
      const id = checkinVerifyMatch[1];
      const { otp } = await req.json();
      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "confirmed") return json({ error: "Booking is not in confirmed state" }, 400);
      if (!b.checkin_otp) return json({ error: "Upload car photos first" }, 400);
      if (b.checkin_otp !== otp) return json({ error: "Incorrect OTP. Get it from the DriveDilSe representative." }, 400);

      const checkoutOtp = generateOtp();
      await sb.from("bookings").update({
        checkin_otp_verified: true, checked_in_at: new Date().toISOString(),
        checkout_otp: checkoutOtp, checkout_otp_verified: false,
        status: "active", updated_at: new Date().toISOString(),
      }).eq("id", id);

      return json({ success: true, message: "Check-in complete! Enjoy your drive." });
    }

    // POST /:id/extend/order
    const extOrderMatch = path.match(/^\/([^/]+)\/extend\/order$/);
    if (req.method === "POST" && extOrderMatch) {
      const id = extOrderMatch[1];
      const { hours } = await req.json();
      if (!hours || hours <= 0) return json({ error: "Invalid hours" }, 400);

      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (!["confirmed", "active"].includes(b.status as string))
        return json({ error: "Can only extend confirmed or active bookings" }, 400);

      const pph  = Math.round((b.price_per_day as number) / 24);
      const cost = hours < 24 ? pph * hours : (b.price_per_day as number) * (hours / 24);
      const order = await razorpayCreate({
        amount: Math.round(cost) * 100, currency: "INR",
        receipt: "EXT_" + b.booking_id,
        notes: { bookingId: b.booking_id, hours },
      });

      return json({ orderId: order.id, amount: Math.round(cost), currency: "INR", keyId: Deno.env.get("RAZORPAY_KEY_ID") });
    }

    // POST /:id/extend/verify
    const extVerifyMatch = path.match(/^\/([^/]+)\/extend\/verify$/);
    if (req.method === "POST" && extVerifyMatch) {
      const id = extVerifyMatch[1];
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature, hours } = await req.json();

      if (!await verifyRazorpay(razorpayOrderId, razorpayPaymentId, razorpaySignature))
        return json({ error: "Payment verification failed" }, 400);

      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);

      const pph     = Math.round((b.price_per_day as number) / 24);
      const cost    = hours < 24 ? pph * hours : (b.price_per_day as number) * (hours / 24);
      const newDrop = new Date(new Date(b.drop_date as string).getTime() + hours * 3600000);
      const newDays = Math.max(1, Math.ceil((newDrop.getTime() - new Date(b.pickup_date as string).getTime()) / 86400000));

      await sb.from("bookings").update({
        drop_date: newDrop.toISOString(), days: newDays,
        total: (b.total as number) + Math.round(cost),
        updated_at: new Date().toISOString(),
      }).eq("id", id);

      await sb.from("extensions").insert({
        id: crypto.randomUUID(), booking_id: id, hours, cost: Math.round(cost),
        razorpay_order_id: razorpayOrderId, razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature,
      });

      return json({ success: true, newDrop: newDrop.toISOString() });
    }

    // PUT /:id/cancel
    const cancelMatch = path.match(/^\/([^/]+)\/cancel$/);
    if (req.method === "PUT" && cancelMatch) {
      const id = cancelMatch[1];
      const { data: booking } = await sb.from("bookings").select("id, status").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "confirmed") return json({ error: "Only confirmed bookings can be cancelled" }, 400);

      await sb.from("bookings").update({
        status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", id);

      return json({ success: true, message: "Booking cancelled." });
    }

    // POST /:id/checkout/verify
    const checkoutVerifyMatch = path.match(/^\/([^/]+)\/checkout\/verify$/);
    if (req.method === "POST" && checkoutVerifyMatch) {
      const id = checkoutVerifyMatch[1];
      const { otp } = await req.json();
      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "active") return json({ error: "Booking is not active" }, 400);
      if (!b.checkout_otp) return json({ error: "Checkout OTP not yet generated" }, 400);
      if (b.checkout_otp !== otp) return json({ error: "Incorrect OTP. Get it from the DriveDilSe representative." }, 400);

      await sb.from("bookings").update({
        checkout_otp_verified: true, checked_out_at: new Date().toISOString(),
        status: "completed", updated_at: new Date().toISOString(),
      }).eq("id", id);

      return json({ success: true, message: "Booking closed. Thank you for driving with DriveDilSe!" });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
