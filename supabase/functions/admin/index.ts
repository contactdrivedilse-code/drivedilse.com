import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { signJwt, verifyJwt, getBearer } from "../_shared/jwt.ts";
import { signStorageUrl } from "../_shared/storage.ts";
import { sendEmail, escapeHtml, sendBookingConfirmationEmail } from "../_shared/email.ts";
import { putFile, deleteFile } from "../_shared/github.ts";
import { slugify, buildBlogPostHtml, buildBlogIndexHtml, buildSitemapXml, type BlogPost } from "../_shared/blog.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function generateOtp(): string { return String(Math.floor(100000 + Math.random() * 900000)); }

// Re-fetches every published post and re-commits both the blog index page
// and sitemap.xml, so they're always in sync with whatever's actually live
// — called after every publish/unpublish/delete rather than trying to
// patch those two files incrementally.
async function rebuildBlogIndexAndSitemap(): Promise<void> {
  const { data } = await sb.from("blog_posts").select("*").eq("status", "published").order("published_at", { ascending: false });
  const posts: BlogPost[] = ((data ?? []) as Record<string, unknown>[]).map((p) => ({
    slug: p.slug as string, title: p.title as string, excerpt: p.excerpt as string,
    content: p.content as string, metaDescription: p.meta_description as string,
    author: p.author as string, publishedAt: p.published_at as string,
  }));
  await putFile("blog/index.html", buildBlogIndexHtml(posts), "Rebuild blog index");
  await putFile("sitemap.xml", buildSitemapXml(posts), "Rebuild sitemap.xml");
}

// Sign the check-in photo URLs on a mapped booking (private bucket support).
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

function mapCar(c: Record<string, unknown>, pauses: Record<string, unknown>[] = []) {
  return {
    _id: c.id, id: c.id,
    name: c.name, category: c.category,
    transmission: c.transmission, fuel: c.fuel, seats: c.seats,
    pricePerDay: c.price_per_day, deposit: c.deposit,
    features: c.features ?? [],
    active: c.active,
    imageUrl: c.image_url || "",
    images: (c.images as string[] | null) || [],
    coverPhoto: (c.cover_photo as string) || "",
    exteriorPhotos: (c.exterior_photos as string[] | null) || [],
    interiorPhotos: (c.interior_photos as string[] | null) || [],
    pauses: pauses.map((p) => ({ _id: p.id, from: p.from_date, to: p.to_date, note: p.note })),
  };
}

function mapCoupon(c: Record<string, unknown>) {
  return {
    _id: c.id, id: c.id, code: c.code, title: c.title,
    description: c.description ?? "", type: c.type, value: c.value,
    minAmount: c.min_amount ?? 0, active: c.active, createdAt: c.created_at,
    newCustomerOnly: c.new_customer_only ?? false,
    isPublic: c.is_public ?? true, maxUses: c.max_uses ?? null, timesUsed: c.times_used ?? 0,
  };
}

function mapBooking(b: Record<string, unknown>) {
  return {
    _id: b.id, id: b.id, bookingId: b.booking_id,
    car: { _id: b.car_id, id: b.car_id, name: b.car_name }, carName: b.car_name,
    customer: b.customer, phone: b.phone,
    pickup: { date: b.pickup_date, location: b.pickup_location },
    drop:   { date: b.drop_date,   location: b.drop_location },
    days: b.days, pricePerDay: b.price_per_day, total: b.total,
    deposit: b.deposit, discount: b.discount,
    depositAmount: b.deposit_amount ?? 0, depositChoice: b.deposit_choice ?? "later", depositPaid: b.deposit_paid ?? false,
    settlement: b.settlement_filled_at ? {
      filledAt: b.settlement_filled_at, lateHours: b.settlement_late_hours ?? 0,
      damageAmount: b.settlement_damage_amount ?? 0, fastagAmount: b.settlement_fastag_amount ?? 0,
      fuelAmount: b.settlement_fuel_amount ?? 0, extensionAmount: b.settlement_extension_amount ?? 0,
      notes: b.settlement_notes ?? "", suggestedRefund: b.settlement_suggested_refund ?? 0,
    } : (b.checked_out_at ? { lateHours: b.settlement_late_hours ?? 0 } : null),
    depositRefundAmount: b.deposit_refund_amount ?? null, depositRefundStatus: b.deposit_refund_status ?? null,
    couponCode: b.coupon_code ?? null, couponDiscount: b.coupon_discount ?? 0,
    payment: { razorpayOrderId: b.razorpay_order_id, razorpayPaymentId: b.razorpay_payment_id, status: b.payment_status, paidAt: b.paid_at },
    checkin: {
      photos: { front: b.checkin_front, rear: b.checkin_rear, passengerSide: b.checkin_passenger_side, driverSide: b.checkin_driver_side },
      photosUploadedAt: b.checkin_photos_at, otp: b.checkin_otp, otpVerified: b.checkin_otp_verified, checkedInAt: b.checked_in_at,
    },
    checkout: { otp: b.checkout_otp, otpVerified: b.checkout_otp_verified, checkedOutAt: b.checked_out_at },
    status: b.status, cancelledAt: b.cancelled_at, notes: b.notes,
    refund: b.cancelled_at ? {
      amount: b.refund_amount, pct: b.refund_pct, status: b.refund_status, razorpayRefundId: b.razorpay_refund_id, reason: b.refund_reason,
      depositAmount: b.deposit_paid ? b.deposit_amount : 0, depositStatus: b.deposit_refund_status, depositRefundId: b.deposit_refund_id,
    } : null,
    source: b.source ?? "website", pickupDone: b.pickup_done ?? false, dropDone: b.drop_done ?? false,
    createdAt: b.created_at, updatedAt: b.updated_at,
    extensions: [],
  };
}

function makeBookingId(): string { return "DS" + Date.now().toString(36).toUpperCase(); }

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

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
function validateImage(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) return "Only JPEG, PNG or WEBP images are allowed";
  if (file.size > MAX_IMAGE_BYTES) return "Image must be smaller than 5MB";
  return null;
}

async function getAdmin(req: Request, requireAdmin = false) {
  const url = new URL(req.url);
  const token = req.headers.get("x-admin-token")
    || url.searchParams.get("_t")
    || getBearer(req);
  if (!token) return null;
  try {
    const p = await verifyJwt(token, Deno.env.get("ADMIN_JWT_SECRET")!) as { role?: string };
    if (requireAdmin && p.role !== "admin") return null;
    return (p.role === "admin" || p.role === "fleet") ? p : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const url  = new URL(req.url);
  const path = url.pathname.replace("/admin", "") || "/";

  try {
    // POST /login
    if (req.method === "POST" && path === "/login") {
      const { password, role } = await req.json();
      if (role === "fleet") {
        if (password !== Deno.env.get("FLEET_PASSWORD"))
          return json({ error: "Invalid password" }, 401);
        const token = await signJwt({ role: "fleet" }, Deno.env.get("ADMIN_JWT_SECRET")!, 12 * 60 * 60);
        return json({ token, role: "fleet" });
      }
      if (password !== Deno.env.get("ADMIN_PASSWORD"))
        return json({ error: "Invalid password" }, 401);
      const token = await signJwt({ role: "admin" }, Deno.env.get("ADMIN_JWT_SECRET")!, 24 * 60 * 60);
      return json({ token, role: "admin" });
    }

    // All routes below require admin or fleet auth
    const admin = await getAdmin(req);
    if (!admin) return json({ error: "Admin access required" }, 401);
    const isAdmin = (admin as Record<string, unknown>).role === "admin";

    // DELETE /clear-phone/:phone — temp endpoint to clear test data (admin only)
    const clearPhoneMatch = path.match(/^\/clear-phone\/([^/]+)$/);
    if (req.method === "DELETE" && clearPhoneMatch && isAdmin) {
      const phone = clearPhoneMatch[1];
      const { data: prof } = await sb.from("profiles").select("id").eq("phone", phone).maybeSingle();
      if (prof) {
        await sb.from("bookings").delete().eq("phone", phone);
        await sb.from("profiles").delete().eq("phone", phone);
      }
      return json({ success: true, message: `Cleared data for ${phone}` });
    }

    // PUT /selfie/:bookingId — approve or reject selfie (fleet/admin)
    const selfieMatch = path.match(/^\/selfie\/([^/]+)$/);
    if (req.method === "PUT" && selfieMatch) {
      const bookingId = selfieMatch[1];
      const { status, reason } = await req.json();
      const noteVal = status === "approved" ? "selfie:approved" : `selfie:rejected:${reason || "Identity could not be verified"}`;
      await sb.from("bookings").update({ notes: noteVal, updated_at: new Date().toISOString() }).eq("id", bookingId);
      return json({ success: true, status });
    }

    // GET /dashboard
    if (req.method === "GET" && path === "/dashboard") {
      const queries: Promise<unknown>[] = [
        sb.from("cars").select("*", { count: "exact", head: true }).eq("active", true),
        sb.from("bookings").select("*", { count: "exact", head: true }),
        sb.from("profiles").select("*", { count: "exact", head: true }).eq("phone_verified", true),
      ];
      if (isAdmin) queries.push(sb.from("bookings").select("total").eq("payment_status", "paid"));
      const results = await Promise.all(queries) as Record<string, unknown>[];
      const [carsRes, bookingsRes, customersRes] = results;
      const revenue = isAdmin
        ? ((results[3] as { data: Record<string, unknown>[] }).data ?? []).reduce((s: number, b: Record<string, unknown>) => s + (b.total as number), 0)
        : null;
      return json({
        totalCars: (carsRes as { count: number }).count,
        totalBookings: (bookingsRes as { count: number }).count,
        totalCustomers: (customersRes as { count: number }).count,
        ...(isAdmin ? { revenue } : {}),
      });
    }

    // GET /bookings
    if (req.method === "GET" && path === "/bookings") {
      const { data, error } = await sb.from("bookings").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return json(await Promise.all((data ?? []).map((b: Record<string, unknown>) => signBookingPhotos(mapBooking(b)))));
    }

    // PUT /bookings/:id/status
    const bkStatusMatch = path.match(/^\/bookings\/([^/]+)\/status$/);
    if (req.method === "PUT" && bkStatusMatch) {
      const { status } = await req.json();
      const updates: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
      if (status === "confirmed") {
        const { data: cur } = await sb.from("bookings").select("checkin_otp").eq("id", bkStatusMatch[1]).maybeSingle();
        if (!(cur as Record<string, unknown> | null)?.checkin_otp) updates.checkin_otp = generateOtp();
      }
      const { data, error } = await sb.from("bookings")
        .update(updates)
        .eq("id", bkStatusMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Booking not found" }, 404);
      return json(await signBookingPhotos(mapBooking(data as Record<string, unknown>)));
    }

    // POST /bookings/:id/refund/mark-done — admin confirms a manual refund
    // (e.g. UPI/bank transfer) for a booking Razorpay couldn't auto-refund
    const markRefundMatch = path.match(/^\/bookings\/([^/]+)\/refund\/mark-done$/);
    if (req.method === "POST" && markRefundMatch && isAdmin) {
      const { data, error } = await sb.from("bookings")
        .update({ refund_status: "refunded_manually", updated_at: new Date().toISOString() })
        .eq("id", markRefundMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Booking not found" }, 404);
      return json(await signBookingPhotos(mapBooking(data as Record<string, unknown>)));
    }

    // POST /bookings/:id/deposit-refund/mark-done — admin confirms a manual
    // deposit refund (UPI/bank transfer) when Razorpay couldn't auto-refund it
    const markDepositRefundMatch = path.match(/^\/bookings\/([^/]+)\/deposit-refund\/mark-done$/);
    if (req.method === "POST" && markDepositRefundMatch && isAdmin) {
      const { data, error } = await sb.from("bookings")
        .update({ deposit_refund_status: "refunded_manually", updated_at: new Date().toISOString() })
        .eq("id", markDepositRefundMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Booking not found" }, 404);
      return json(await signBookingPhotos(mapBooking(data as Record<string, unknown>)));
    }

    // POST /bookings/:id/deposit/mark-paid — admin manually marks the
    // deposit collected (e.g. cash at handover) for pay-later bookings
    const markDepositPaidMatch = path.match(/^\/bookings\/([^/]+)\/deposit\/mark-paid$/);
    if (req.method === "POST" && markDepositPaidMatch && isAdmin) {
      const { data, error } = await sb.from("bookings")
        .update({ deposit_paid: true, deposit_paid_at: new Date().toISOString(), deposit_razorpay_payment_id: "manual", updated_at: new Date().toISOString() })
        .eq("id", markDepositPaidMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Booking not found" }, 404);
      return json(await signBookingPhotos(mapBooking(data as Record<string, unknown>)));
    }

    // GET /bookings/pending-settlement-refunds — completed trips where the
    // fleet manager has filled the post-checkout checklist but the deposit
    // hasn't been refunded yet. This is the admin "notification" queue.
    if (req.method === "GET" && path === "/bookings/pending-settlement-refunds" && isAdmin) {
      const { data, error } = await sb.from("bookings").select("*")
        .eq("status", "completed").not("settlement_filled_at", "is", null)
        .is("deposit_refund_status", null).order("settlement_filled_at", { ascending: true });
      if (error) throw error;
      return json((data ?? []).map((b: Record<string, unknown>) => mapBooking(b)));
    }

    // POST /bookings/:id/settlement — fleet manager (or admin) records
    // post-checkout deductions against the deposit: damage, FASTag, fuel,
    // and a late-return/unbilled-extension charge. Produces a suggested
    // refund = deposit - deductions, which admin reviews before refunding.
    const settlementMatch = path.match(/^\/bookings\/([^/]+)\/settlement$/);
    if (req.method === "POST" && settlementMatch) {
      const { damageAmount, fastagAmount, fuelAmount, extensionAmount, notes } = await req.json();
      const { data: booking } = await sb.from("bookings").select("*").eq("id", settlementMatch[1]).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (b.status !== "completed") return json({ error: "Booking is not completed yet" }, 400);

      const damage    = Math.max(0, Number(damageAmount) || 0);
      const fastag    = Math.max(0, Number(fastagAmount) || 0);
      const fuel      = Math.max(0, Number(fuelAmount) || 0);
      const extension = Math.max(0, Number(extensionAmount) || 0);
      const depositAmt = Number(b.deposit_amount) || 0;
      const suggestedRefund = Math.max(0, depositAmt - damage - fastag - fuel - extension);

      const { data, error } = await sb.from("bookings").update({
        settlement_filled_at: new Date().toISOString(),
        settlement_damage_amount: damage, settlement_fastag_amount: fastag,
        settlement_fuel_amount: fuel, settlement_extension_amount: extension,
        settlement_notes: notes ?? "", settlement_suggested_refund: suggestedRefund,
        updated_at: new Date().toISOString(),
      }).eq("id", settlementMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      return json(mapBooking(data as Record<string, unknown>));
    }

    // POST /bookings/:id/deposit/settle-refund — admin reviews the suggested
    // amount (or overrides it) and actually triggers the Razorpay refund.
    const settleRefundMatch = path.match(/^\/bookings\/([^/]+)\/deposit\/settle-refund$/);
    if (req.method === "POST" && settleRefundMatch && isAdmin) {
      const { amount } = await req.json();
      const { data: booking } = await sb.from("bookings").select("*").eq("id", settleRefundMatch[1]).maybeSingle();
      const b = booking as Record<string, unknown> | null;
      if (!b) return json({ error: "Booking not found" }, 404);
      if (!b.deposit_paid) return json({ error: "No deposit was collected on this booking" }, 400);

      const refundAmount = Math.max(0, Math.min(Number(amount) || 0, Number(b.deposit_amount) || 0));
      let refundStatus = "needs_manual";
      let refundId: string | null = null;

      if (refundAmount > 0) {
        const paymentId = b.deposit_razorpay_payment_id as string;
        if (paymentId && paymentId !== "manual") {
          try {
            const refund = await razorpayRefund(paymentId, Math.round(refundAmount * 100));
            refundId = refund.id;
            refundStatus = "refunded";
          } catch (e) {
            console.error("Deposit settle-refund failed for booking", settleRefundMatch[1], (e as Error).message);
            refundStatus = "failed_needs_manual";
          }
        }
      } else {
        refundStatus = "refunded"; // nothing owed back — fully consumed by deductions
      }

      const { data, error } = await sb.from("bookings").update({
        deposit_refund_amount: refundAmount, deposit_refund_status: refundStatus,
        deposit_refund_id: refundId, updated_at: new Date().toISOString(),
      }).eq("id", settleRefundMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      return json(mapBooking(data as Record<string, unknown>));
    }

    // POST /bookings/:id/checkin-otp — reveal check-in OTP to admin
    const ciOtpMatch = path.match(/^\/bookings\/([^/]+)\/checkin-otp$/);
    if (req.method === "POST" && ciOtpMatch) {
      const { data: b } = await sb.from("bookings").select("checkin_otp, status").eq("id", ciOtpMatch[1]).maybeSingle();
      const bk = b as Record<string, unknown> | null;
      if (!bk) return json({ error: "Booking not found" }, 404);
      if (bk.status !== "confirmed") return json({ error: "Booking is not in confirmed state" }, 400);
      return json({ otp: bk.checkin_otp });
    }

    // POST /bookings/:id/checkout-otp — reveal checkout OTP to admin
    const coOtpMatch = path.match(/^\/bookings\/([^/]+)\/checkout-otp$/);
    if (req.method === "POST" && coOtpMatch) {
      const { data: b } = await sb.from("bookings").select("checkout_otp, status").eq("id", coOtpMatch[1]).maybeSingle();
      const bk = b as Record<string, unknown> | null;
      if (!bk) return json({ error: "Booking not found" }, 404);
      if (bk.status !== "active") return json({ error: "Booking is not active" }, 400);
      return json({ otp: bk.checkout_otp });
    }

    // GET /customers
    if (req.method === "GET" && path === "/customers") {
      const { data, error } = await sb.from("profiles")
        .select("id, phone, name, dob, email, aadhaar_url, dl_url, aadhaar_uploaded, dl_verified, kyc_status, phone_verified, created_at")
        .eq("phone_verified", true).order("created_at", { ascending: false });
      if (error) throw error;
      return json(await Promise.all((data ?? []).map(async (u: Record<string, unknown>) => ({
        _id: u.id, id: u.id,
        phone: u.phone, name: u.name, email: u.email, dob: u.dob,
        createdAt: u.created_at,
        kyc: {
          status: u.kyc_status || "pending",
          aadhaarUrl: (await signStorageUrl(sb, u.aadhaar_url as string)) || null,
          dlUrl: (await signStorageUrl(sb, u.dl_url as string)) || null,
          aadhaarUploaded: u.aadhaar_uploaded,
          dlVerified: u.dl_verified,
        },
      }))));
    }

    // PUT /customers/:id/kyc
    const kycMatch = path.match(/^\/customers\/([^/]+)\/kyc$/);
    if (req.method === "PUT" && kycMatch) {
      const { status } = await req.json();
      const updates: Record<string, unknown> = { kyc_status: status };
      if (status === "verified") updates.dl_verified = true;
      const { data, error } = await sb.from("profiles").update(updates).eq("id", kycMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "User not found" }, 404);
      const p2 = data as Record<string, unknown>;
      // When KYC is verified, confirm all pending_kyc bookings for this user
      // Match by BOTH user_id AND phone to handle profile recreations
      if (status === "verified") {
        const { data: toConfirm } = await sb.from("bookings").select("id, booking_id, car_name, pickup_date, drop_date, pickup_location, total")
          .or(`user_id.eq.${kycMatch[1]},phone.eq.${p2.phone as string}`)
          .eq("status", "pending_kyc");
        // Each booking gets its own OTP — generated now so the fleet manager
        // has it ready as soon as the booking is confirmed, not after photos.
        if (p2.email) {
          ((toConfirm ?? []) as Record<string, unknown>[]).forEach((row) => {
            sendBookingConfirmationEmail({
              to: p2.email as string, customerName: p2.name as string, bookingId: row.booking_id as string,
              carName: row.car_name as string, pickupDate: row.pickup_date as string, dropDate: row.drop_date as string,
              pickupLocation: row.pickup_location as string, total: row.total as number,
            }).catch((e) => console.error("Booking confirmation email failed", row.booking_id, (e as Error).message));
          });
        }
        await Promise.all(((toConfirm ?? []) as Record<string, unknown>[]).map((row) =>
          sb.from("bookings").update({
            status: "confirmed", checkin_otp: generateOtp(), updated_at: new Date().toISOString(),
          }).eq("id", row.id as string)
        ));
      }
      const p = data as Record<string, unknown>;
      return json({
        _id: p.id, id: p.id, phone: p.phone, name: p.name,
        kyc: {
          status: p.kyc_status,
          aadhaarUrl: await signStorageUrl(sb, p.aadhaar_url as string),
          dlUrl: await signStorageUrl(sb, p.dl_url as string),
        },
      });
    }

    // GET /fleet
    if (req.method === "GET" && path === "/fleet") {
      const { data: cars, error } = await sb.from("cars").select("*").order("name", { ascending: true });
      if (error) throw error;
      const ids = (cars ?? []).map((c: Record<string, unknown>) => c.id as string);
      const { data: pauses } = ids.length ? await sb.from("car_pauses").select("*").in("car_id", ids) : { data: [] };
      const pauseMap: Record<string, Record<string, unknown>[]> = {};
      for (const p of pauses ?? []) {
        const pp = p as Record<string, unknown>;
        const cid = pp.car_id as string;
        if (!pauseMap[cid]) pauseMap[cid] = [];
        pauseMap[cid].push(pp);
      }
      return json((cars ?? []).map((c: Record<string, unknown>) => mapCar(c, pauseMap[c.id as string] ?? [])));
    }

    // POST /fleet — create new car
    if (req.method === "POST" && path === "/fleet") {
      const { name, category, transmission, fuel, seats, pricePerDay, features } = await req.json();
      if (!name || !pricePerDay) return json({ error: "name and pricePerDay required" }, 400);
      const { data, error } = await sb.from("cars").insert({
        id: crypto.randomUUID(), name, category: category || "Hatchback",
        transmission: transmission || "Manual", fuel: fuel || "Petrol",
        seats: seats || 5, price_per_day: pricePerDay, features: features ?? [],
        deposit: 0, active: true, image_url: "", images: [],
      }).select("*").maybeSingle();
      if (error) throw error;
      return json(mapCar(data as Record<string, unknown>), 201);
    }

    // POST /fleet/:id/photo — upload a photo for a car into one of three
    // sections: cover (single photo, overwrites), exterior or interior
    // (multiple, capped at 5 each)
    const SECTION_CAP: Record<string, number> = { exterior: 5, interior: 5 };
    const photoMatch = path.match(/^\/fleet\/([^/]+)\/photo$/);
    if (req.method === "POST" && photoMatch) {
      const carId = photoMatch[1];
      const fd = await req.formData();
      const file = fd.get("photo") as File | null;
      const section = ((fd.get("section") as string) || "exterior").toLowerCase();
      if (!file) return json({ error: "photo field required" }, 400);
      if (!["cover", "exterior", "interior"].includes(section)) return json({ error: "Invalid section" }, 400);
      const imgErr = validateImage(file);
      if (imgErr) return json({ error: imgErr }, 400);

      const { data: carRow } = await sb.from("cars").select("cover_photo, exterior_photos, interior_photos, image_url, images").eq("id", carId).maybeSingle();
      const c = (carRow as Record<string, unknown>) || {};

      if (section === "exterior" || section === "interior") {
        const col = section === "exterior" ? "exterior_photos" : "interior_photos";
        const existing = (c[col] as string[] | null) || [];
        if (existing.length >= SECTION_CAP[section]) return json({ error: `Maximum ${SECTION_CAP[section]} ${section} photos allowed` }, 400);
      }

      const ext = file.type.includes("png") ? "png" : file.type.includes("webp") ? "webp" : "jpg";
      const storagePath = `${carId}/${section}/${Date.now()}.${ext}`;
      const buf = new Uint8Array(await file.arrayBuffer());
      const { error: upErr } = await sb.storage.from("cars").upload(storagePath, buf, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const publicUrl = sb.storage.from("cars").getPublicUrl(storagePath).data.publicUrl;

      const updates: Record<string, unknown> = {};
      // Keep the legacy image_url/images columns in sync so any code still
      // reading them (old cached clients, reports) doesn't break.
      updates.images = [...((c.images as string[] | null) || []), publicUrl];
      if (section === "cover") {
        updates.cover_photo = publicUrl;
        updates.image_url = publicUrl; // cover always takes priority as the legacy "main" image
      } else {
        const col = section === "exterior" ? "exterior_photos" : "interior_photos";
        updates[col] = [...((c[col] as string[] | null) || []), publicUrl];
        if (!c.cover_photo && !c.image_url) updates.image_url = publicUrl;
      }

      await sb.from("cars").update(updates).eq("id", carId);
      const { data: updated } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      return json(mapCar(updated as Record<string, unknown>));
    }

    // DELETE /fleet/:id/photo — remove a photo from a section
    if (req.method === "DELETE" && photoMatch) {
      const { url, section } = await req.json();
      const carId = photoMatch[1];
      const { data: carRow } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      const c = carRow as Record<string, unknown>;
      if (!c) return json({ error: "Car not found" }, 404);

      const updates: Record<string, unknown> = {};
      if (section === "cover") {
        updates.cover_photo = "";
      } else if (section === "interior") {
        updates.interior_photos = ((c.interior_photos as string[] | null) || []).filter((u) => u !== url);
      } else {
        updates.exterior_photos = ((c.exterior_photos as string[] | null) || []).filter((u) => u !== url);
      }
      const legacyImages = ((c.images as string[] | null) || []).filter((u) => u !== url);
      updates.images = legacyImages;
      if (c.image_url === url) updates.image_url = legacyImages[0] || "";

      await sb.from("cars").update(updates).eq("id", carId);
      const { data: updated } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
      return json(mapCar(updated as Record<string, unknown>));
    }

    // PUT /fleet/:id/toggle
    const toggleMatch = path.match(/^\/fleet\/([^/]+)\/toggle$/);
    if (req.method === "PUT" && toggleMatch) {
      const { data: car } = await sb.from("cars").select("active").eq("id", toggleMatch[1]).maybeSingle();
      if (!car) return json({ error: "Car not found" }, 404);
      const { data, error } = await sb.from("cars")
        .update({ active: !(car as Record<string, unknown>).active })
        .eq("id", toggleMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      return json(mapCar(data as Record<string, unknown>));
    }

    // PUT /fleet/:id — update car details (must come after toggle match)
    const carEditMatch = path.match(/^\/fleet\/([^/]+)$/);
    if (req.method === "PUT" && carEditMatch) {
      const body = await req.json();
      const updates: Record<string, unknown> = {};
      if (body.name         !== undefined) updates.name          = body.name;
      if (body.category     !== undefined) updates.category      = body.category;
      if (body.transmission !== undefined) updates.transmission  = body.transmission;
      if (body.fuel         !== undefined) updates.fuel          = body.fuel;
      if (body.seats        !== undefined) updates.seats         = body.seats;
      if (body.pricePerDay  !== undefined) updates.price_per_day = body.pricePerDay;
      if (body.features     !== undefined) updates.features      = body.features;
      const { data, error } = await sb.from("cars").update(updates).eq("id", carEditMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Car not found" }, 404);
      return json(mapCar(data as Record<string, unknown>));
    }

    // POST /fleet/:id/pause — Admin or Fleet Manager can pause a car
    const pauseMatch = path.match(/^\/fleet\/([^/]+)\/pause$/);
    if (req.method === "POST" && pauseMatch) {
      const { from, to, note } = await req.json();
      const { data: car } = await sb.from("cars").select("id").eq("id", pauseMatch[1]).maybeSingle();
      if (!car) return json({ error: "Car not found" }, 404);
      const { data, error } = await sb.from("car_pauses").insert({
        id: crypto.randomUUID(), car_id: pauseMatch[1],
        from_date: new Date(from).toISOString(), to_date: new Date(to).toISOString(), note: note ?? "",
      }).select("*").maybeSingle();
      if (error) throw error;
      return json(data);
    }

    // DELETE /fleet/:id/pause/:pauseId — Admin or Fleet Manager
    const deletePauseMatch = path.match(/^\/fleet\/([^/]+)\/pause\/([^/]+)$/);
    if (req.method === "DELETE" && deletePauseMatch) {
      const { error } = await sb.from("car_pauses").delete().eq("id", deletePauseMatch[2]).eq("car_id", deletePauseMatch[1]);
      if (error) throw error;
      return json({ success: true });
    }

    // POST /fleet/:id/manual-booking — Fleet Manager only. Records a booking made
    // elsewhere (e.g. Zoomcar) so the car shows as unavailable here and it appears
    // on the daily schedule.
    const manualBkMatch = path.match(/^\/fleet\/([^/]+)\/manual-booking$/);
    if (req.method === "POST" && manualBkMatch) {
      if (isAdmin) return json({ error: "Admin has view-only access to the schedule. Use a Fleet Manager account to add a booking." }, 403);
      const carId = manualBkMatch[1];
      const { source, customer, phone, pickupDate, dropDate, pickupLocation, dropLocation, notes } = await req.json();
      if (!pickupDate || !dropDate) return json({ error: "pickupDate and dropDate required" }, 400);

      const { data: car } = await sb.from("cars").select("id, name, price_per_day").eq("id", carId).maybeSingle();
      if (!car) return json({ error: "Car not found" }, 404);
      const c = car as Record<string, unknown>;

      const pickup = new Date(pickupDate), drop = new Date(dropDate);
      if (!(drop > pickup)) return json({ error: "Drop date must be after pickup date" }, 400);
      const pISO = pickup.toISOString(), dISO = drop.toISOString();

      const { data: conflict } = await sb.from("bookings").select("id").eq("car_id", carId)
        .in("status", ["confirmed", "active", "completed", "pending_kyc"]).lt("pickup_date", dISO).gt("drop_date", pISO).maybeSingle();
      if (conflict) return json({ error: "Car is already booked for these dates" }, 400);

      const days = Math.max(1, Math.ceil((drop.getTime() - pickup.getTime()) / (24 * 3600000)));
      const { data: booking, error } = await sb.from("bookings").insert({
        id: crypto.randomUUID(), booking_id: makeBookingId(),
        car_id: c.id, car_name: c.name,
        customer: customer || (source || "External"), phone: phone || "",
        pickup_date: pISO, pickup_location: pickupLocation || "",
        drop_date: dISO, drop_location: dropLocation || "",
        days, price_per_day: c.price_per_day, total: 0,
        deposit: 0, discount: 0, delivery_fee: 0,
        payment_status: "external", status: "confirmed",
        source: source || "Manual", notes: notes || "",
      }).select("*").maybeSingle();
      if (error) throw error;
      return json(mapBooking(booking as Record<string, unknown>), 201);
    }

    // GET /schedule/today — today's pickups & drop-offs for the checklist
    if (req.method === "GET" && path === "/schedule/today") {
      const now = new Date();
      const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
      const dayEnd   = new Date(now); dayEnd.setHours(23, 59, 59, 999);
      const [{ data: pickups }, { data: drops }] = await Promise.all([
        sb.from("bookings").select("*").neq("status", "cancelled")
          .gte("pickup_date", dayStart.toISOString()).lte("pickup_date", dayEnd.toISOString()),
        sb.from("bookings").select("*").neq("status", "cancelled")
          .gte("drop_date", dayStart.toISOString()).lte("drop_date", dayEnd.toISOString()),
      ]);
      const items = [
        ...(pickups ?? []).map((b: Record<string, unknown>) => ({
          id: b.id, bookingId: b.booking_id, type: "pickup", time: b.pickup_date,
          carName: b.car_name, customer: b.customer, phone: b.phone, location: b.pickup_location,
          source: b.source ?? "website", done: !!b.pickup_done,
        })),
        ...(drops ?? []).map((b: Record<string, unknown>) => ({
          id: b.id, bookingId: b.booking_id, type: "drop", time: b.drop_date,
          carName: b.car_name, customer: b.customer, phone: b.phone, location: b.drop_location,
          source: b.source ?? "website", done: !!b.drop_done,
        })),
      ];
      items.sort((a, b) => new Date(a.time as string).getTime() - new Date(b.time as string).getTime());
      return json(items);
    }

    // PUT /bookings/:id/checklist — Fleet Manager only; ticks off a pickup or drop
    const checklistMatch = path.match(/^\/bookings\/([^/]+)\/checklist$/);
    if (req.method === "PUT" && checklistMatch) {
      if (isAdmin) return json({ error: "Admin has view-only access to the schedule. Use a Fleet Manager account to update it." }, 403);
      const { type, done } = await req.json();
      if (type !== "pickup" && type !== "drop") return json({ error: "type must be pickup or drop" }, 400);
      const col = type === "pickup" ? "pickup_done" : "drop_done";
      const { data, error } = await sb.from("bookings").update({ [col]: !!done }).eq("id", checklistMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Booking not found" }, 404);
      return json(mapBooking(data as Record<string, unknown>));
    }

    // GET /coupons — list all coupons (admin only)
    if (req.method === "GET" && path === "/coupons") {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const { data, error } = await sb.from("coupons").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return json((data ?? []).map((c: Record<string, unknown>) => mapCoupon(c)));
    }

    // POST /coupons — create coupon (admin only)
    if (req.method === "POST" && path === "/coupons") {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const { code, title, description, type, value, minAmount, active, newCustomerOnly, isPublic } = await req.json();
      if (!code || !title || !value) return json({ error: "code, title and value required" }, 400);
      const { data, error } = await sb.from("coupons").insert({
        id: crypto.randomUUID(), code: String(code).toUpperCase().trim(), title,
        description: description ?? "", type: type === "flat" ? "flat" : "percent",
        value, min_amount: minAmount ?? 0, active: active !== false,
        new_customer_only: newCustomerOnly === true,
        is_public: isPublic !== false,
      }).select("*").maybeSingle();
      if (error) throw error;
      return json(mapCoupon(data as Record<string, unknown>), 201);
    }

    // PUT /coupons/:id — update coupon (admin only)
    const couponEditMatch = path.match(/^\/coupons\/([^/]+)$/);
    if (req.method === "PUT" && couponEditMatch) {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const body = await req.json();
      const updates: Record<string, unknown> = {};
      if (body.code        !== undefined) updates.code        = String(body.code).toUpperCase().trim();
      if (body.title       !== undefined) updates.title       = body.title;
      if (body.description !== undefined) updates.description = body.description;
      if (body.type        !== undefined) updates.type        = body.type === "flat" ? "flat" : "percent";
      if (body.value       !== undefined) updates.value       = body.value;
      if (body.minAmount   !== undefined) updates.min_amount  = body.minAmount;
      if (body.active      !== undefined) updates.active      = body.active;
      if (body.newCustomerOnly !== undefined) updates.new_customer_only = body.newCustomerOnly === true;
      if (body.isPublic    !== undefined) updates.is_public   = body.isPublic === true;
      const { data, error } = await sb.from("coupons").update(updates).eq("id", couponEditMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Coupon not found" }, 404);
      return json(mapCoupon(data as Record<string, unknown>));
    }

    // DELETE /coupons/:id — remove coupon (admin only)
    if (req.method === "DELETE" && couponEditMatch) {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const { error } = await sb.from("coupons").delete().eq("id", couponEditMatch[1]);
      if (error) throw error;
      return json({ success: true });
    }

    // GET /tickets — support tickets raised from the chat widget
    if (req.method === "GET" && path === "/tickets") {
      const { data, error } = await sb.from("support_tickets").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return json((data ?? []).map((t: Record<string, unknown>) => ({
        _id: t.id, id: t.id, name: t.name, phone: t.phone, email: t.email ?? "",
        message: t.message, status: t.status, createdAt: t.created_at,
        replyMessage: t.reply_message ?? "", replyImageUrl: t.reply_image_url ?? "", repliedAt: t.replied_at,
      })));
    }

    // PUT /tickets/:id/resolve — mark a ticket resolved/open
    const ticketResolveMatch = path.match(/^\/tickets\/([^/]+)\/resolve$/);
    if (req.method === "PUT" && ticketResolveMatch) {
      const { resolved } = await req.json();
      const { data: ticket, error } = await sb.from("support_tickets")
        .update({ status: resolved ? "resolved" : "open", resolved_at: resolved ? new Date().toISOString() : null })
        .eq("id", ticketResolveMatch[1])
        .select()
        .single();
      if (error) throw error;

      if (resolved && ticket.email) {
        await sendEmail(
          ticket.email,
          "Your support ticket has been resolved — DriveDilSe",
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#161616">DriveDilSe</h2>
            <p>Hi ${escapeHtml(ticket.name)}, your support ticket has been marked as resolved.</p>
            <p style="background:#f6f6f6;border-radius:8px;padding:12px"><strong>Your message:</strong><br/>${escapeHtml(ticket.message)}</p>
            ${ticket.reply_message ? `<p style="background:#fff8e1;border-radius:8px;padding:12px"><strong>Our response:</strong><br/>${escapeHtml(ticket.reply_message)}</p>` : ""}
            <p>If this didn't resolve your issue, just raise a new ticket and we'll take another look.</p>
          </div>`,
        ).catch((e) => console.error("Resolve email failed:", e));
      }

      return json({ success: true });
    }

    // PUT /tickets/:id/reply — admin/fleet reply to a ticket, optionally with an image
    const ticketReplyMatch = path.match(/^\/tickets\/([^/]+)\/reply$/);
    if (req.method === "PUT" && ticketReplyMatch) {
      const ticketId = ticketReplyMatch[1];
      const fd = await req.formData();
      const message = (fd.get("message") as string | null)?.trim() || "";
      const image = fd.get("image") as File | null;
      if (!message) return json({ error: "Reply message is required" }, 400);

      let imageUrl = "";
      if (image) {
        const imgErr = validateImage(image);
        if (imgErr) return json({ error: imgErr }, 400);
        const ext = image.type.includes("png") ? "png" : image.type.includes("webp") ? "webp" : "jpg";
        const storagePath = `${ticketId}/${Date.now()}.${ext}`;
        const buf = new Uint8Array(await image.arrayBuffer());
        const { error: upErr } = await sb.storage.from("tickets").upload(storagePath, buf, { contentType: image.type, upsert: false });
        if (upErr) throw upErr;
        imageUrl = sb.storage.from("tickets").getPublicUrl(storagePath).data.publicUrl;
      }

      const { data: ticket, error } = await sb.from("support_tickets")
        .update({ reply_message: message, reply_image_url: imageUrl || null, replied_at: new Date().toISOString() })
        .eq("id", ticketId)
        .select()
        .single();
      if (error) throw error;

      if (ticket.email) {
        await sendEmail(
          ticket.email,
          "We've replied to your support ticket — DriveDilSe",
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#161616">DriveDilSe</h2>
            <p>Hi ${escapeHtml(ticket.name)}, our team has replied to your ticket:</p>
            <p style="background:#fff8e1;border-radius:8px;padding:12px">${escapeHtml(message)}</p>
            ${imageUrl ? `<p><img src="${imageUrl}" style="max-width:100%;border-radius:8px" /></p>` : ""}
            <p style="color:#666;font-size:13px">Original message: ${escapeHtml(ticket.message)}</p>
          </div>`,
        ).catch((e) => console.error("Reply email failed:", e));
      }

      return json({ success: true, replyImageUrl: imageUrl });
    }

    // GET /blog — list all posts (drafts + published) for the admin panel
    if (req.method === "GET" && path === "/blog") {
      const { data, error } = await sb.from("blog_posts").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return json(data ?? []);
    }

    // POST /blog — create a new draft post
    if (req.method === "POST" && path === "/blog") {
      const body = await req.json();
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "Title is required" }, 400);
      let slug = slugify(title);
      const { data: clash } = await sb.from("blog_posts").select("id").eq("slug", slug).maybeSingle();
      if (clash) slug = slug + "-" + Date.now().toString(36);

      const { data, error } = await sb.from("blog_posts").insert({
        slug, title,
        excerpt: String(body.excerpt ?? ""),
        content: String(body.content ?? ""),
        meta_description: String(body.metaDescription ?? ""),
        author: String(body.author ?? "DriveDilSe Team"),
      }).select().single();
      if (error) throw error;
      return json(data, 201);
    }

    // PUT /blog/:id — update a post's fields (does not touch the live page;
    // call /publish again afterwards to push the update live)
    const blogIdMatch = path.match(/^\/blog\/([^/]+)$/);
    if (req.method === "PUT" && blogIdMatch) {
      const body = await req.json();
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.title !== undefined) updates.title = String(body.title).trim();
      if (body.excerpt !== undefined) updates.excerpt = String(body.excerpt);
      if (body.content !== undefined) updates.content = String(body.content);
      if (body.metaDescription !== undefined) updates.meta_description = String(body.metaDescription);
      if (body.author !== undefined) updates.author = String(body.author);
      const { data, error } = await sb.from("blog_posts").update(updates).eq("id", blogIdMatch[1]).select().maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Post not found" }, 404);
      return json(data);
    }

    // DELETE /blog/:id — delete the post and, if it was published, its live page
    if (req.method === "DELETE" && blogIdMatch) {
      const { data: post } = await sb.from("blog_posts").select("*").eq("id", blogIdMatch[1]).maybeSingle();
      const p = post as Record<string, unknown> | null;
      if (!p) return json({ error: "Post not found" }, 404);
      await sb.from("blog_posts").delete().eq("id", blogIdMatch[1]);
      if (p.status === "published") {
        try {
          await deleteFile(`blog/${p.slug}.html`, `Delete blog post: ${p.title}`);
          await rebuildBlogIndexAndSitemap();
        } catch (ghErr) {
          console.error("GitHub cleanup failed after delete:", (ghErr as Error).message);
        }
      }
      return json({ success: true });
    }

    // POST /blog/:id/publish — generate the static page and commit it live
    const publishMatch = path.match(/^\/blog\/([^/]+)\/publish$/);
    if (req.method === "POST" && publishMatch) {
      const { data: post } = await sb.from("blog_posts").select("*").eq("id", publishMatch[1]).maybeSingle();
      const p = post as Record<string, unknown> | null;
      if (!p) return json({ error: "Post not found" }, 404);
      if (!String(p.content ?? "").trim()) return json({ error: "Add some content before publishing" }, 400);

      const publishedAt = (p.published_at as string) || new Date().toISOString();
      await sb.from("blog_posts").update({ status: "published", published_at: publishedAt }).eq("id", publishMatch[1]);

      const blogPost: BlogPost = {
        slug: p.slug as string, title: p.title as string, excerpt: p.excerpt as string,
        content: p.content as string, metaDescription: p.meta_description as string,
        author: p.author as string, publishedAt,
      };
      await putFile(`blog/${blogPost.slug}.html`, buildBlogPostHtml(blogPost), `Publish blog post: ${blogPost.title}`);
      await rebuildBlogIndexAndSitemap();
      return json({ success: true, url: `https://www.drivedilse.com/blog/${blogPost.slug}` });
    }

    // POST /blog/:id/unpublish — take the live page down, keep the draft
    const unpublishMatch = path.match(/^\/blog\/([^/]+)\/unpublish$/);
    if (req.method === "POST" && unpublishMatch) {
      const { data: post } = await sb.from("blog_posts").select("slug, title").eq("id", unpublishMatch[1]).maybeSingle();
      const p = post as Record<string, unknown> | null;
      if (!p) return json({ error: "Post not found" }, 404);
      await sb.from("blog_posts").update({ status: "draft" }).eq("id", unpublishMatch[1]);
      await deleteFile(`blog/${p.slug}.html`, `Unpublish blog post: ${p.title}`);
      await rebuildBlogIndexAndSitemap();
      return json({ success: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
