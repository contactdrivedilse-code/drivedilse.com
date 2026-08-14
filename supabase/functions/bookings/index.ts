import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight, corsHeaders } from "../_shared/cors.ts";
import { verifyJwt, getBearer, getUserToken } from "../_shared/jwt.ts";
import { signStorageUrl } from "../_shared/storage.ts";
// Zoho Books invoice generation removed

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
function generateOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}
const DEPOSIT_AMOUNT = Number(Deno.env.get("DEPOSIT_AMOUNT_INR")) || 1000;

// Marginal bracket rates (â‚¹/hr, excl GST) â€" mirrors frontend calcDynamicPrice
// Each rate applies ONLY to hours within its bracket: [0-12hr, 12-24hr, 24-168hr, 168hr+]
const CAT_BRACKETS: Record<string, number[]> = {
  compact: [ 96, 60, 39, 48],  // 24hrâ‰ˆâ‚¹2.2k | 7dâ‰ˆâ‚¹8.8k | 14dâ‰ˆâ‚¹18k | 30dâ‰ˆâ‚¹40k
  premium: [105, 65, 43, 54],  // 24hrâ‰ˆâ‚¹2.4k | 7dâ‰ˆâ‚¹9.7k | 14dâ‰ˆâ‚¹20k | 30dâ‰ˆâ‚¹45k
  MPV:     [130, 81, 45, 64],  // 24hrâ‰ˆâ‚¹3k   | 7dâ‰ˆâ‚¹10.6k| 14dâ‰ˆâ‚¹23k | 30dâ‰ˆâ‚¹52k
  SUV:     [156, 97, 54, 73],  // 24hrâ‰ˆâ‚¹3.5k | 7dâ‰ˆâ‚¹12.8k| 14dâ‰ˆâ‚¹27k | 30dâ‰ˆâ‚¹60k
};
const BRACKET_CUTS = [0, 12, 24, 168, Infinity];

function getCatBrackets(category: string, pricePerDay: number): number[] {
  if (category === "MPV") return CAT_BRACKETS.MPV;
  if (category === "SUV" || category === "Compact SUV") return CAT_BRACKETS.SUV;
  return pricePerDay < 1580 ? CAT_BRACKETS.compact : CAT_BRACKETS.premium;
}

function getMarginalBase(rates: number[], fromHr: number, toHr: number): number {
  let cost = 0;
  for (let i = 0; i < rates.length; i++) {
    const s = Math.max(fromHr, BRACKET_CUTS[i]);
    const e = Math.min(toHr,   BRACKET_CUTS[i + 1]);
    if (e > s) cost += (e - s) * rates[i];
  }
  return cost;
}

function calcPrice(pricePerDay: number, pickup: Date, drop: Date, category = "Hatchback") {
  const hours = (drop.getTime() - pickup.getTime()) / 3600000;
  const rates = getCatBrackets(category, pricePerDay);
  const base  = Math.round(getMarginalBase(rates, 0, hours));
  const gst   = Math.round(base * 0.18);
  const days  = Math.max(1, Math.ceil(hours / 24));
  return { base, gst, total: base + gst, discount: 0, days };
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

function mapBooking(b: Record<string, unknown>, exts: Record<string, unknown>[] = [], review: Record<string, unknown> | null = null) {
  return {
    _id: b.id, id: b.id, bookingId: b.booking_id,
    car: { _id: b.car_id, id: b.car_id, name: b.car_name }, carName: b.car_name,
    hasReview: !!review,
    myReview: review ? { rating: review.rating, reviewText: review.review_text } : null,
    customer: b.customer, phone: b.phone,
    pickup: { date: b.pickup_date, location: b.pickup_location },
    drop:   { date: b.drop_date,   location: b.drop_location },
    days: b.days, pricePerDay: b.price_per_day, total: b.total,
    deposit: b.deposit, discount: b.discount, deliveryFee: b.delivery_fee ?? 0,
    depositAmount: b.deposit_amount ?? 0, depositChoice: b.deposit_choice ?? "later",
    depositPaid: b.deposit_paid ?? false, depositPaidAt: b.deposit_paid_at ?? null,
    settlement: b.settlement_filled_at ? {
      filledAt: b.settlement_filled_at, lateHours: b.settlement_late_hours ?? 0,
      damageAmount: b.settlement_damage_amount ?? 0, fastagAmount: b.settlement_fastag_amount ?? 0,
      fuelAmount: b.settlement_fuel_amount ?? 0, extensionAmount: b.settlement_extension_amount ?? 0,
      notes: b.settlement_notes ?? "", suggestedRefund: b.settlement_suggested_refund ?? 0,
    } : (b.checked_out_at ? { lateHours: b.settlement_late_hours ?? 0 } : null),
    depositRefundAmount: b.deposit_refund_amount ?? null, depositRefundStatus: b.deposit_refund_status ?? null,
    payment: { razorpayOrderId: b.razorpay_order_id, razorpayPaymentId: b.razorpay_payment_id, status: b.payment_status, paidAt: b.paid_at },
    checkin: {
      photos: { front: b.checkin_front, rear: b.checkin_rear, passengerSide: b.checkin_passenger_side, driverSide: b.checkin_driver_side },
      photosUploadedAt: b.checkin_photos_at, otp: b.checkin_otp, otpVerified: b.checkin_otp_verified, checkedInAt: b.checked_in_at,
      kmReading: b.checkin_km ?? null, fuelPhotoUrl: b.checkin_fuel_photo ?? null,
    },
    checkout: { otp: b.checkout_otp, otpVerified: b.checkout_otp_verified, checkedOutAt: b.checked_out_at, kmReading: b.checkout_km ?? null, fuelPhotoUrl: b.checkout_fuel_photo ?? null },
    invoiceId: b.zoho_invoice_id ?? null,
    status: b.status, cancelledAt: b.cancelled_at, notes: b.notes,
    refund: b.cancelled_at ? {
      amount: b.refund_amount, pct: b.refund_pct, status: b.refund_status, razorpayRefundId: b.razorpay_refund_id, reason: b.refund_reason,
      depositAmount: b.deposit_paid ? b.deposit_amount : 0, depositStatus: b.deposit_refund_status, depositRefundId: b.deposit_refund_id,
    } : null,
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

// Cancellation refund tiers, matching the policy shown on /policy and the
// booking cancellation tab: >48h before pickup = full refund, 24-48h = 50%,
// under 24h / no-show = no refund of the booking fee.
function refundPctForCancellation(pickupDateIso: string): number {
  const hoursUntilPickup = (new Date(pickupDateIso).getTime() - Date.now()) / 3600000;
  if (hoursUntilPickup >= 48) return 1;
  if (hoursUntilPickup >= 24) return 0.5;
  return 0;
}

function refundReasonText(pct: number, total: number): string {
  if (!(total > 0)) return "No payment is on record for this booking, so there's nothing to refund.";
  if (pct === 1)   return "Cancelled more than 48 hours before pickup -- full refund of the booking fee, per our cancellation policy.";
  if (pct === 0.5) return "Cancelled 24-48 hours before pickup -- 50% refund of the booking fee, per our cancellation policy.";
  return "Cancelled less than 24 hours before pickup -- the booking fee is non-refundable per our cancellation policy.";
}

async function razorpayRefund(paymentId: string, amountPaise: number) {
  const auth = btoa(`${Deno.env.get("RAZORPAY_KEY_ID")}:${Deno.env.get("RAZORPAY_KEY_SECRET")}`);
  const res  = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
    method: "POST",
    headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amountPaise, speed: "normal" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.description || "Razorpay refund failed");
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);

  const url  = new URL(req.url);
  const path = url.pathname.replace("/bookings", "") || "/";

  const user = await getUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  try {
    // GET / â€" user's bookings
    if (req.method === "GET" && (path === "/" || path === "")) {
      const { data: bookings, error } = await sb.from("bookings").select("*")
        .eq("user_id", user.id).order("pickup_date", { ascending: true });
      if (error) throw error;

      const ids = (bookings ?? []).map((b: Record<string, unknown>) => b.id as string);
      const { data: exts } = ids.length
        ? await sb.from("extensions").select("*").in("booking_id", ids)
        : { data: [] };
      const { data: reviewed } = ids.length
        ? await sb.from("car_reviews").select("booking_id, rating, review_text").in("booking_id", ids)
        : { data: [] };

      const extMap: Record<string, Record<string, unknown>[]> = {};
      for (const e of exts ?? []) {
        const ee = e as Record<string, unknown>;
        const bid = ee.booking_id as string;
        if (!extMap[bid]) extMap[bid] = [];
        extMap[bid].push(ee);
      }
      const reviewMap: Record<string, Record<string, unknown>> = {};
      for (const r of reviewed ?? []) {
        const rr = r as Record<string, unknown>;
        reviewMap[rr.booking_id as string] = rr;
      }

      return json(await Promise.all((bookings ?? []).map((b: Record<string, unknown>) =>
        signBookingPhotos(mapBooking(b, extMap[b.id as string], reviewMap[b.id as string])))));
    }

    // POST /:id/selfie â€" customer uploads selfie to storage; auto-approved (no manual review needed)
    const selfieUploadMatch = path.match(/^\/([^/]+)\/selfie$/);
    if (req.method === "POST" && selfieUploadMatch) {
      const id = selfieUploadMatch[1];
      const { data: booking } = await sb.from("bookings").select("id, status, user_id").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "confirmed") return json({ error: "Booking not in confirmed state" }, 400);

      const body = await req.json() as { selfie?: string };
      if (!body.selfie) return json({ error: "selfie required" }, 400);
      // A 5 MB image encodes to â‰ˆ6.7 MB of base64 (â‰ˆ6.7M chars).
      if (body.selfie.length > 7 * 1024 * 1024)
        return json({ error: "Selfie image too large (max 5 MB)" }, 413);

      const base64 = body.selfie.replace(/^data:image\/[^;]+;base64,/, "");
      const buf    = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const sPath  = `${id}/selfie.jpg`;
      const { error: upErr } = await sb.storage.from("checkin").upload(sPath, buf, { contentType: "image/jpeg", upsert: true });
      if (upErr) throw upErr;
      const selfieUrl = sb.storage.from("checkin").getPublicUrl(sPath).data.publicUrl;

      await sb.from("bookings").update({ notes: "selfie:approved", updated_at: new Date().toISOString() }).eq("id", id);
      return json({ success: true });
    }

    // GET /:id/selfie-status â€" customer polls for selfie verification result
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

    // POST /:id/checkin-b64 â€" receive base64 photos, upload to storage, generate OTP
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
      // Each photo: 5 MB image ≈ 6.7 MB base64
      const oversized = sides.find(s => body[s] && body[s].length > 7 * 1024 * 1024);
      if (oversized) return json({ error: `Photo "${oversized}" too large (max 5 MB each)` }, 413);

      const urls: Record<string, string> = {};
      const allSides = body.fuel ? [...sides, "fuel"] : sides;
      await Promise.all(allSides.map(async (s) => {
        const buf  = Uint8Array.from(atob(body[s]), c => c.charCodeAt(0));
        const path = `${id}/${s}.jpg`;
        const { error } = await sb.storage.from("checkin").upload(path, buf, { contentType: "image/jpeg", upsert: true });
        if (error) throw error;
        urls[s] = sb.storage.from("checkin").getPublicUrl(path).data.publicUrl;
      }));

      // Check-in OTP is generated when the booking is confirmed, not here --
      // only fall back to generating one if an older booking somehow lacks it.
      const otp = (b.checkin_otp as string) || generateOtp();
      const dbUpdate: Record<string, unknown> = {
        checkin_front: urls.front, checkin_rear: urls.rear,
        checkin_passenger_side: urls.passengerSide, checkin_driver_side: urls.driverSide,
        checkin_photos_at: new Date().toISOString(),
        checkin_otp: otp, checkin_otp_verified: false,
        updated_at: new Date().toISOString(),
      };
      if (body.kmReading) dbUpdate.checkin_km = parseInt(body.kmReading, 10);
      if (urls.fuel)      dbUpdate.checkin_fuel_photo = urls.fuel;
      await sb.from("bookings").update(dbUpdate).eq("id", id);

      return json({ success: true, message: "Photos uploaded. Get your check-in OTP from the DriveDilSe representative." });
    }

    // POST /:id/checkin-urls â€" receive pre-uploaded photo URLs, generate OTP
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

      // Only accept URLs from our own Supabase storage — reject any external
      // host that a customer could supply to bypass the real photo requirement.
      const supabaseHost = new URL(Deno.env.get("SUPABASE_URL")!).host;
      const allowedPrefix = `https://${supabaseHost}/storage/`;
      const photoUrls = [front, rear, passengerSide, driverSide];
      if (photoUrls.some((u) => !u.startsWith(allowedPrefix)))
        return json({ error: "Invalid photo URL — must be uploaded to DriveDilSe storage" }, 400);

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

    // POST /:id/checkin â€" upload 4 photos (legacy, kept for compatibility)
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

    // POST /:id/deposit/order â€" create a Razorpay order to pay the
    // refundable deposit for a "pay later" booking, before/at check-in
    const depositOrderMatch = path.match(/^\/([^/]+)\/deposit\/order$/);
    if (req.method === "POST" && depositOrderMatch) {
      const id = depositOrderMatch[1];
      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.deposit_paid) return json({ error: "Deposit already paid" }, 400);
      const amount = (b.deposit_amount as number) || DEPOSIT_AMOUNT;

      const order = await razorpayCreate({ amount: amount * 100, currency: "INR", receipt: "DEP" + Date.now().toString(36).toUpperCase(), notes: { bookingId: id, type: "deposit" } });
      await sb.from("bookings").update({ deposit_razorpay_order_id: order.id }).eq("id", id);

      return json({ orderId: order.id, amount, currency: "INR", keyId: Deno.env.get("RAZORPAY_KEY_ID") });
    }

    // POST /:id/deposit/verify
    const depositVerifyMatch = path.match(/^\/([^/]+)\/deposit\/verify$/);
    if (req.method === "POST" && depositVerifyMatch) {
      const id = depositVerifyMatch[1];
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = await req.json();
      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.deposit_razorpay_order_id !== razorpayOrderId) return json({ error: "Order mismatch" }, 400);
      if (!await verifyRazorpay(razorpayOrderId, razorpayPaymentId, razorpaySignature))
        return json({ error: "Payment verification failed" }, 400);

      await sb.from("bookings").update({
        deposit_paid: true, deposit_paid_at: new Date().toISOString(),
        deposit_razorpay_payment_id: razorpayPaymentId, updated_at: new Date().toISOString(),
      }).eq("id", id);

      return json({ success: true, message: "Refundable deposit paid." });
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
      // deposit_choice is null for bookings made before this feature shipped â€"
      // those were never asked for a deposit, so don't retroactively block them.
      if (b.deposit_choice && !b.deposit_paid) return json({ error: "Please pay the refundable security deposit before check-in." }, 400);
      // Block check-in if there is a pending booking amount (manual bookings with partial collection)
      if (b.amount_collected != null) {
        const pending = Number(b.total) - Number(b.amount_collected);
        if (pending > 0) return json({ error: `Please clear the pending amount of ₹${pending.toLocaleString("en-IN")} before check-in.` }, 400);
      }
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

    // PUT /:id/reschedule â€" change booking pickup/drop dates
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

      // Conflict check â€" exclude current booking
      const { data: conflict } = await sb.from("bookings").select("id")
        .eq("car_id", b.car_id as string).neq("id", id)
        .in("status", ["pending", "pending_kyc", "confirmed", "active", "completed"])
        .lt("pickup_date", dISOR).gt("drop_date", pISOR).maybeSingle();
      if (conflict) return json({ error: "Car is not available for the selected dates" }, 400);

      // Lock the effective per-hour rate from the original booking so customers
      // always reschedule at the same rate they paid â€" no new duration multipliers.
      const { data: extsForRs } = await sb.from("extensions").select("cost").eq("booking_id", id);
      const extTotalRs = (extsForRs ?? []).reduce((s, e) => s + (((e as Record<string, unknown>).cost as number) || 0), 0);
      const origPickup = new Date(b.pickup_date as string);
      const origDrop   = new Date(b.drop_date as string);
      const origHrs    = Math.max(1, (origDrop.getTime() - origPickup.getTime()) / 3600000);
      const lockedPph  = ((b.total as number) - extTotalRs) / 1.18 / origHrs;
      const newHrs     = (newDrop.getTime() - newPickup.getTime()) / 3600000;
      const newBase    = Math.round(lockedPph * newHrs);
      const newGst     = Math.round(newBase * 0.18);
      const total      = newBase + newGst + extTotalRs;
      const days       = Math.max(1, Math.ceil(newHrs / 24));

      await sb.from("bookings").update({
        pickup_date: pISOR, drop_date: dISOR,
        days, total, discount: 0, updated_at: new Date().toISOString(),
      }).eq("id", id);

      const { data: updated } = await sb.from("bookings").select("*").eq("id", id).maybeSingle();
      return json({ success: true, booking: mapBooking(updated as Record<string, unknown>) });
    }

    // POST /:id/damage â€" upload damage photos (pre check-in or post checkout)
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
        const imgErr = validateImage(file);
        if (imgErr) return json({ error: `photo${i}: ${imgErr}` }, 400);
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

    // POST /:id/extend/direct â€" extend without Razorpay (when payment gateway not configured)
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
      // Direct (no-payment) extension is only valid for demo bookings.
      // Real paid bookings must go through /extend/order + /extend/verify.
      if (b.payment_status !== "demo")
        return json({ error: "Use the extension payment flow for this booking" }, 403);

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

    // GET /:id/cancel-preview â€" refund amount the user would get right now
    const cancelPreviewMatch = path.match(/^\/([^/]+)\/cancel-preview$/);
    if (req.method === "GET" && cancelPreviewMatch) {
      const id = cancelPreviewMatch[1];
      const { data: booking } = await sb.from("bookings").select("status, pickup_date, total, deposit_choice, deposit_paid, deposit_amount").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      const pct = refundPctForCancellation(b.pickup_date as string);
      const total = Number(b.total) || 0;
      const depositBundled = b.deposit_choice === "now" && !!b.deposit_paid;
      const depositAmt = Number(b.deposit_amount) || 0;
      const bookingFeeBase = depositBundled ? Math.max(0, total - depositAmt) : total;
      const amount = Math.round(bookingFeeBase * pct * 100) / 100;
      const depositRefundAmount = b.deposit_paid ? depositAmt : 0;
      return json({
        refundPct: pct, refundAmount: amount, refundReason: refundReasonText(pct, bookingFeeBase),
        depositRefundAmount,
      });
    }

    // PUT /:id/cancel
    const cancelMatch = path.match(/^\/([^/]+)\/cancel$/);
    if (req.method === "PUT" && cancelMatch) {
      const id = cancelMatch[1];
      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "confirmed") return json({ error: "Only confirmed bookings can be cancelled" }, 400);

      const pct = refundPctForCancellation(b.pickup_date as string);
      const totalAmt = Number(b.total) || 0;
      // Deposit paid at booking time ("now") is bundled into the same
      // Razorpay payment as the booking fee â€" strip it out before applying
      // the cancellation-tier percentage, since the deposit is always
      // 100% refundable regardless of timing, unlike the booking fee.
      const depositBundled = b.deposit_choice === "now" && !!b.deposit_paid;
      const depositAmt = Number(b.deposit_amount) || 0;
      const bookingFeeBase = depositBundled ? Math.max(0, totalAmt - depositAmt) : totalAmt;
      const refundAmount = Math.round(bookingFeeBase * pct * 100) / 100;
      const refundReason = refundReasonText(pct, bookingFeeBase);

      let refundStatus = "not_applicable";
      let razorpayRefundId: string | null = null;

      if (refundAmount > 0) {
        const paymentId = b.razorpay_payment_id as string;
        if (paymentId && paymentId !== "direct") {
          try {
            const refund = await razorpayRefund(paymentId, Math.round(refundAmount * 100));
            razorpayRefundId = refund.id;
            refundStatus = "refunded";
          } catch (e) {
            console.error("Razorpay refund failed for booking", id, (e as Error).message);
            refundStatus = "failed_needs_manual";
          }
        } else {
          refundStatus = "needs_manual";
        }
      }

      // Deposit refund â€" always 100%, independent of the booking-fee tier.
      let depositRefundAmount = 0;
      let depositRefundStatus = "not_applicable";
      let depositRefundId: string | null = null;
      if (b.deposit_paid) {
        depositRefundAmount = depositAmt;
        const depPaymentId = depositBundled ? (b.razorpay_payment_id as string) : (b.deposit_razorpay_payment_id as string);
        if (depositRefundAmount > 0 && depPaymentId && depPaymentId !== "direct") {
          try {
            const dRefund = await razorpayRefund(depPaymentId, Math.round(depositRefundAmount * 100));
            depositRefundId = dRefund.id;
            depositRefundStatus = "refunded";
          } catch (e) {
            console.error("Razorpay deposit refund failed for booking", id, (e as Error).message);
            depositRefundStatus = "failed_needs_manual";
          }
        } else if (depositRefundAmount > 0) {
          depositRefundStatus = "needs_manual";
        }
      }

      await sb.from("bookings").update({
        status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        refund_amount: refundAmount, refund_pct: pct, razorpay_refund_id: razorpayRefundId, refund_status: refundStatus,
        refund_reason: refundReason,
        deposit_refund_status: depositRefundStatus, deposit_refund_id: depositRefundId,
      }).eq("id", id);

      return json({
        success: true, message: "Booking cancelled.",
        refundAmount, refundPct: pct, refundStatus, refundReason,
        depositRefundAmount, depositRefundStatus,
      });
    }

    // POST /:id/checkout/verify
    const checkoutVerifyMatch = path.match(/^\/([^/]+)\/checkout\/verify$/);
    if (req.method === "POST" && checkoutVerifyMatch) {
      const id = checkoutVerifyMatch[1];
      const body = await req.json() as Record<string, unknown>;
      const { otp, kmReading, fuelPhotoB64, fuelPhotoMime } = body as { otp: string; kmReading?: string; fuelPhotoB64?: string; fuelPhotoMime?: string };
      const { data: booking } = await sb.from("bookings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "active") return json({ error: "Booking is not active" }, 400);
      if (!b.checkout_otp) return json({ error: "Checkout OTP not yet generated" }, 400);
      if (b.checkout_otp !== otp) return json({ error: "Incorrect OTP. Get it from the DriveDilSe representative." }, 400);

      const checkedOutAt = new Date().toISOString();
      const availableAt  = new Date(Date.now() + 4 * 3600000).toISOString();

      const { base, gst, days } = calcPrice(b.price_per_day as number, new Date(b.pickup_date as string), new Date(b.drop_date as string), b.car_category as string || "Hatchback");

      const lateMs    = Date.now() - new Date(b.drop_date as string).getTime();
      const lateHours = lateMs > 0 ? Math.ceil(lateMs / 3600000) : 0;

      // Upload checkout fuel photo if provided
      let checkoutFuelUrl: string | null = null;
      if (fuelPhotoB64) {
        try {
          const buf = Uint8Array.from(atob(fuelPhotoB64), (c) => c.charCodeAt(0));
          const mime = fuelPhotoMime || "image/jpeg";
          const ext  = mime.includes("png") ? "png" : "jpg";
          const storagePath = `checkins/${id}/checkout_fuel.${ext}`;
          const { error: upErr } = await sb.storage.from("checkin-photos").upload(storagePath, buf, { contentType: mime, upsert: true });
          if (!upErr) checkoutFuelUrl = sb.storage.from("checkin-photos").getPublicUrl(storagePath).data.publicUrl;
        } catch { /* non-fatal */ }
      }

      const updateFields: Record<string, unknown> = {
        checkout_otp_verified: true, checked_out_at: checkedOutAt,
        drop_date: availableAt,
        status: "completed", updated_at: checkedOutAt,
        settlement_late_hours: lateHours,
      };
      if (kmReading) updateFields.checkout_km = parseInt(String(kmReading), 10);
      if (checkoutFuelUrl) updateFields.checkout_fuel_photo = checkoutFuelUrl;

      await sb.from("bookings").update(updateFields).eq("id", id);


      return json({ success: true, message: "Booking closed. Thank you for driving with DriveDilSe!" });
    }


    // /:id/review â€" leave a review for a completed trip's car (one per booking)
    const reviewMatch = path.match(/^\/([^/]+)\/review$/);
    if (req.method === "GET" && reviewMatch) {
      const { data } = await sb.from("car_reviews").select("rating, review_text").eq("booking_id", reviewMatch[1]).maybeSingle();
      const r = data as Record<string, unknown> | null;
      return json({ reviewed: !!r, rating: r?.rating ?? null, reviewText: r?.review_text ?? null });
    }
    if (req.method === "POST" && reviewMatch) {
      const id = reviewMatch[1];
      const { rating, reviewText } = await req.json();

      const ratingNum = Number(rating);
      if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5)
        return json({ error: "Rating must be a whole number from 1 to 5" }, 400);
      const text = String(reviewText ?? "").trim().slice(0, 1000);

      const { data: booking } = await sb.from("bookings").select("id, car_id, customer, status, user_id").eq("id", id).eq("user_id", user.id).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "completed") return json({ error: "You can only review a completed trip" }, 400);

      const { data: existing } = await sb.from("car_reviews").select("id").eq("booking_id", id).maybeSingle();
      if (existing) return json({ error: "You've already reviewed this trip" }, 400);

      const { error: insErr } = await sb.from("car_reviews").insert({
        booking_id: id,
        car_id: b.car_id as string,
        user_id: user.id,
        customer_name: (b.customer as string) || "",
        rating: ratingNum,
        review_text: text,
      });
      if (insErr) {
        if ((insErr as { code?: string }).code === "23505") return json({ error: "You've already reviewed this trip" }, 400);
        throw insErr;
      }

      return json({ success: true, message: "Thanks for your review!" });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error("[500]", (e as Error).message);
    return json({ error: "Internal server error" }, 500);
  }
});

