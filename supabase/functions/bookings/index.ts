import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { verifyJwt, getBearer, getUserToken } from "../_shared/jwt.ts";
import { signStorageUrl } from "../_shared/storage.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function signBookingPhotos(b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ci = (b.checkin ?? {}) as Record<string, unknown>;
  const photos = (ci.photos ?? {}) as Record<string, unknown>;
  const [front, rear, passengerSide, driverSide] = await Promise.all([
    signStorageUrl(sb, photos.front as string),
    signStorageUrl(sb, photos.rear as string),
    signStorageUrl(sb, photos.passengerSide as string),
    signStorageUrl(sb, photos.driverSide as string),
  ]);
  return { ...b, checkin: { ...ci, photos: { front, rear, passengerSide, driverSide } } };
}

const CHECKIN_WINDOW_MINS = 30;
function generateOtp(): string { return String(Math.floor(100000 + Math.random() * 900000)); }

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
  const token = getUserToken(req);
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
    deposit: b.deposit, discount: b.discount, deliveryFee: b.delivery_fee ?? 0,
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

      return json(await Promise.all((bookings ?? []).map((b: Record<string, unknown>) => signBookingPhotos(mapBooking(b, extMap[b.id as string])))));
    }

    // GET /:id/selfie-status — customer polls for selfie verification result
    const selfieStatusMatch = path.match(/^\/([^/]+)\/selfie-status$/);
    if (req.method === "GET" && selfieStatusMatch) {
      const id = selfieStatusMatch[1];
      const { data: booking } = await sb.from("bookings").select("notes").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      const notes = (b.notes as string) || "";
      if (notes.startsWith("selfie:approved")) return json({ status: "approved" });
      if (notes.startsWith("selfie:rejected")) {
        const reason = notes.replace("selfie:rejected:", "") || "Identity could not be verified";
        return json({ status: "rejected", reason });
      }
      return json({ status: "pending" });
    }

    // POST /:id/checkin-b64 — receive base64 photos, upload to storage, generate OTP
    const checkinB64Match = path.match(/^\/([^/]+)\/checkin-b64$/);
    if (req.method === "POST" && checkinB64Match) {
      const id = checkinB64Match[1];
      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "confirmed") return json({ error: "Booking is not in confirmed state" }, 400);

      const nowMs    = Date.now();
      const pickupMs = new Date(b.pickup_date as string).getTime();
      if (nowMs < pickupMs - CHECKIN_WINDOW_MINS * 60000)
        return json({ error: `Check-in opens ${CHECKIN_WINDOW_MINS} minutes before your pickup time` }, 400);

      const body = await req.json() as Record<string, string>;
      const sides = ["front","rear","passengerSide","driverSide"];
      const missing = sides.filter(s => !body[s]);
      if (missing.length) return json({ error: `Missing photos: ${missing.join(", ")}` }, 400);

      const urls: Record<string, string> = {};
      await Promise.all(sides.map(async (s) => {
        const buf  = Uint8Array.from(atob(body[s]), c => c.charCodeAt(0));
        const path = `${id}/${s}.jpg`;
        const { error } = await sb.storage.from("checkin").upload(path, buf, { contentType: "image/jpeg", upsert: true });
        if (error) throw error;
        urls[s] = sb.storage.from("checkin").getPublicUrl(path).data.publicUrl;
      }));

      // Check-in OTP is generated when the booking is confirmed, not here —
      // only fall back to generating one if an older booking somehow lacks it.
      const otp = (b.checkin_otp as string) || generateOtp();
      await sb.from("bookings").update({
        checkin_front: urls.front, checkin_rear: urls.rear,
        checkin_passenger_side: urls.passengerSide, checkin_driver_side: urls.driverSide,
        checkin_photos_at: new Date().toISOString(),
        checkin_otp: otp, checkin_otp_verified: false,
        updated_at: new Date().toISOString(),
      }).eq("id", id);

      return json({ success: true, message: "Photos uploaded. Get your check-in OTP from the DriveDilSe representative." });
    }

    // POST /:id/checkin-urls — receive pre-uploaded photo URLs, generate OTP
    const checkinUrlsMatch = path.match(/^\/([^/]+)\/checkin-urls$/);
    if (req.method === "POST" && checkinUrlsMatch) {
      const id = checkinUrlsMatch[1];
      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "confirmed") return json({ error: "Booking is not in confirmed state" }, 400);

      const nowMs    = Date.now();
      const pickupMs = new Date(b.pickup_date as string).getTime();
      if (nowMs < pickupMs - CHECKIN_WINDOW_MINS * 60000)
        return json({ error: `Check-in opens ${CHECKIN_WINDOW_MINS} minutes before your pickup time` }, 400);

      const { front, rear, passengerSide, driverSide } = await req.json() as Record<string, string>;
      if (!front || !rear || !passengerSide || !driverSide)
        return json({ error: "Missing photo URLs" }, 400);

      const otp = (b.checkin_otp as string) || generateOtp();
      await sb.from("bookings").update({
        checkin_front: front, checkin_rear: rear,
        checkin_passenger_side: passengerSide, checkin_driver_side: driverSide,
        checkin_photos_at: new Date().toISOString(),
        checkin_otp: otp, checkin_otp_verified: false,
        updated_at: new Date().toISOString(),
      }).eq("id", id);

      return json({ success: true, message: "Photos saved. Get your check-in OTP from the DriveDilSe representative." });
    }

    // POST /:id/checkin — upload 4 photos (legacy, kept for compatibility)
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

      const otp = (b.checkin_otp as string) || generateOtp();
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

      const nowMs     = Date.now();
      const dropMs    = new Date(b.drop_date as string).getTime();
      const isLate    = nowMs > dropMs;
      const pph       = Math.round((b.price_per_day as number) / 24);
      const rateMulti = isLate ? 2 : 1;
      const pphFinal  = pph * rateMulti;
      const base = hours < 24
        ? pphFinal * hours
        : (b.price_per_day as number) * rateMulti * (hours / 24);
      const gst   = Math.round(base * 0.18);
      const total = Math.round(base) + gst;

      const order = await razorpayCreate({
        amount: total * 100, currency: "INR",
        receipt: "EXT_" + b.booking_id,
        notes: { bookingId: b.booking_id, hours, isLate: isLate ? "1" : "0" },
      });

      return json({
        orderId: order.id, amount: total, base: Math.round(base), gst, currency: "INR",
        keyId: Deno.env.get("RAZORPAY_KEY_ID"),
        isLate, pph: pphFinal, rateMulti,
      });
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

      const isLateExt  = Date.now() > new Date(b.drop_date as string).getTime();
      const pph        = Math.round((b.price_per_day as number) / 24);
      const rateM      = isLateExt ? 2 : 1;
      const baseExt    = hours < 24 ? pph * rateM * hours : (b.price_per_day as number) * rateM * (hours / 24);
      const gstExt     = Math.round(baseExt * 0.18);
      const cost       = Math.round(baseExt) + gstExt;
      const newDrop    = new Date(new Date(b.drop_date as string).getTime() + hours * 3600000);
      const newDays    = Math.max(1, Math.ceil((newDrop.getTime() - new Date(b.pickup_date as string).getTime()) / 86400000));
      const newTotal   = (b.total as number) + cost;

      await sb.from("bookings").update({
        drop_date: newDrop.toISOString(), days: newDays,
        total: newTotal, updated_at: new Date().toISOString(),
      }).eq("id", id);

      await sb.from("extensions").insert({
        id: crypto.randomUUID(), booking_id: id, hours, cost,
        razorpay_order_id: razorpayOrderId, razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature,
      });

      // Return full updated booking so frontend can sync
      const { data: updated } = await sb.from("bookings").select("*").eq("id", id).maybeSingle();
      const { data: exts }    = await sb.from("extensions").select("*").eq("booking_id", id);
      const extList = (exts ?? []).map((e: Record<string, unknown>) => ({
        hours: e.hours, cost: e.cost, extendedAt: e.created_at,
      }));
      return json({
        success: true, newDrop: newDrop.toISOString(), hours, cost,
        booking: mapBooking(updated as Record<string, unknown>, extList),
      });
    }

    // PUT /:id/reschedule — change booking pickup/drop dates
    const rescheduleMatch = path.match(/^\/([^/]+)\/reschedule$/);
    if (req.method === "PUT" && rescheduleMatch) {
      const id = rescheduleMatch[1];
      const { pickupDate, dropDate } = await req.json();

      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "confirmed") return json({ error: "Only confirmed bookings can be rescheduled" }, 400);

      const newPickup = new Date(pickupDate);
      const newDrop   = new Date(dropDate);

      if (newPickup < new Date()) return json({ error: "Pickup time cannot be in the past" }, 400);
      if (newDrop <= newPickup)   return json({ error: "Drop time must be after pickup time" }, 400);

      const pISOR = newPickup.toISOString(), dISOR = newDrop.toISOString();

      // Conflict check — exclude current booking
      const { data: conflict } = await sb.from("bookings").select("id")
        .eq("car_id", b.car_id as string).neq("id", id)
        .in("status", ["confirmed", "active", "completed"])
        .lt("pickup_date", dISOR).gt("drop_date", pISOR).maybeSingle();
      if (conflict) return json({ error: "Car is not available for the selected dates" }, 400);

      const { total, discount, days } = calcPrice(b.price_per_day as number, newPickup, newDrop);

      await sb.from("bookings").update({
        pickup_date: pISOR, drop_date: dISOR,
        days, total, discount, updated_at: new Date().toISOString(),
      }).eq("id", id);

      const { data: updated } = await sb.from("bookings").select("*").eq("id", id).maybeSingle();
      return json({ success: true, booking: mapBooking(updated as Record<string, unknown>) });
    }

    // POST /:id/damage — upload damage photos (pre check-in or post checkout)
    const damageMatch = path.match(/^\/([^/]+)\/damage$/);
    if (req.method === "POST" && damageMatch) {
      const id  = damageMatch[1];
      const { data: booking } = await sb.from("bookings").select("id, user_id").eq("id", id).eq("user_id", user.id).maybeSingle();
      if (!booking) return json({ error: "Booking not found" }, 404);

      const fd       = await req.formData();
      const typeVal  = (fd.get("type") as string) || "checkin";
      const photos: string[] = [];

      for (let i = 0; i < 10; i++) {
        const file = fd.get("photo" + i) as File | null;
        if (!file) break;
        const buf  = new Uint8Array(await file.arrayBuffer());
        const fpath = `${id}/damage_${typeVal}_${i}_${Date.now()}.jpg`;
        const { error: upErr } = await sb.storage.from("checkin").upload(fpath, buf, { contentType: file.type, upsert: true });
        if (!upErr) photos.push(sb.storage.from("checkin").getPublicUrl(fpath).data.publicUrl);
      }

      // Store URLs in booking notes (append to existing)
      const { data: bk } = await sb.from("bookings").select("notes").eq("id", id).maybeSingle();
      const existing = (bk as Record<string, unknown>)?.notes as string || "";
      const noteKey  = typeVal === "checkout" ? "damage_checkout" : "damage_checkin";
      const newNote  = existing + "\n" + noteKey + ":" + photos.join(",");
      await sb.from("bookings").update({ notes: newNote.trim(), updated_at: new Date().toISOString() }).eq("id", id);

      return json({ success: true, uploaded: photos.length });
    }

    // POST /:id/extend/direct — extend without Razorpay (when payment gateway not configured)
    const extDirectMatch = path.match(/^\/([^/]+)\/extend\/direct$/);
    if (req.method === "POST" && extDirectMatch) {
      const id = extDirectMatch[1];
      const { hours } = await req.json();
      if (!hours || hours <= 0) return json({ error: "Invalid hours" }, 400);

      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (!["confirmed", "active"].includes(b.status as string))
        return json({ error: "Can only extend confirmed or active bookings" }, 400);

      const isLateD  = Date.now() > new Date(b.drop_date as string).getTime();
      const pph      = Math.round((b.price_per_day as number) / 24);
      const rateM    = isLateD ? 2 : 1;
      const baseD    = hours < 24 ? pph * rateM * hours : (b.price_per_day as number) * rateM * (hours / 24);
      const gstD     = Math.round(baseD * 0.18);
      const costD    = Math.round(baseD) + gstD;
      const newDropD = new Date(new Date(b.drop_date as string).getTime() + hours * 3600000);
      const newDaysD = Math.max(1, Math.ceil((newDropD.getTime() - new Date(b.pickup_date as string).getTime()) / 86400000));

      await sb.from("bookings").update({
        drop_date: newDropD.toISOString(), days: newDaysD,
        total: (b.total as number) + costD, updated_at: new Date().toISOString(),
      }).eq("id", id);

      await sb.from("extensions").insert({
        id: crypto.randomUUID(), booking_id: id, hours, cost: costD,
        razorpay_order_id: "", razorpay_payment_id: "direct", razorpay_signature: "",
      });

      const { data: updatedD } = await sb.from("bookings").select("*").eq("id", id).maybeSingle();
      const { data: extsD }    = await sb.from("extensions").select("*").eq("booking_id", id);
      const extListD = (extsD ?? []).map((e: Record<string, unknown>) => ({
        hours: e.hours, cost: e.cost, extendedAt: e.created_at,
      }));
      return json({
        success: true, newDrop: newDropD.toISOString(), hours, cost: costD,
        booking: mapBooking(updatedD as Record<string, unknown>, extListD),
      });
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

      const checkedOutAt = new Date().toISOString();
      // Car unavailable for 4 hours after completion (cleaning/inspection buffer)
      const availableAt  = new Date(Date.now() + 4 * 3600000).toISOString();

      await sb.from("bookings").update({
        checkout_otp_verified: true, checked_out_at: checkedOutAt,
        drop_date: availableAt, // overwrite original drop — car free after 4h
        status: "completed", updated_at: checkedOutAt,
      }).eq("id", id);

      return json({ success: true, message: "Booking closed. Thank you for driving with DriveDilSe!" });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
