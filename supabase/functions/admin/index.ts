import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { signJwt, verifyJwt, getBearer } from "../_shared/jwt.ts";
import { signStorageUrl } from "../_shared/storage.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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
    pauses: pauses.map((p) => ({ _id: p.id, from: p.from_date, to: p.to_date, note: p.note })),
  };
}

function mapCoupon(c: Record<string, unknown>) {
  return {
    _id: c.id, id: c.id, code: c.code, title: c.title,
    description: c.description ?? "", type: c.type, value: c.value,
    minAmount: c.min_amount ?? 0, active: c.active, createdAt: c.created_at,
    newCustomerOnly: c.new_customer_only ?? false,
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
    couponCode: b.coupon_code ?? null, couponDiscount: b.coupon_discount ?? 0,
    payment: { razorpayOrderId: b.razorpay_order_id, razorpayPaymentId: b.razorpay_payment_id, status: b.payment_status, paidAt: b.paid_at },
    checkin: {
      photos: { front: b.checkin_front, rear: b.checkin_rear, passengerSide: b.checkin_passenger_side, driverSide: b.checkin_driver_side },
      photosUploadedAt: b.checkin_photos_at, otp: b.checkin_otp, otpVerified: b.checkin_otp_verified, checkedInAt: b.checked_in_at,
    },
    checkout: { otp: b.checkout_otp, otpVerified: b.checkout_otp_verified, checkedOutAt: b.checked_out_at },
    status: b.status, cancelledAt: b.cancelled_at, notes: b.notes,
    source: b.source ?? "website", pickupDone: b.pickup_done ?? false, dropDone: b.drop_done ?? false,
    createdAt: b.created_at, updatedAt: b.updated_at,
    extensions: [],
  };
}

function makeBookingId(): string { return "DS" + Date.now().toString(36).toUpperCase(); }

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
      const { data, error } = await sb.from("bookings")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", bkStatusMatch[1]).select("*").maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Booking not found" }, 404);
      return json(await signBookingPhotos(mapBooking(data as Record<string, unknown>)));
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
        await sb.from("bookings")
          .update({ status: "confirmed", updated_at: new Date().toISOString() })
          .eq("user_id", kycMatch[1]).eq("status", "pending_kyc");
        // Also match by phone in case user_id changed after profile recreation
        await sb.from("bookings")
          .update({ status: "confirmed", updated_at: new Date().toISOString() })
          .eq("phone", p2.phone as string).eq("status", "pending_kyc");
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

    // POST /fleet/:id/photo — upload a photo for a car
    const photoMatch = path.match(/^\/fleet\/([^/]+)\/photo$/);
    if (req.method === "POST" && photoMatch) {
      const carId = photoMatch[1];
      const fd = await req.formData();
      const file = fd.get("photo") as File | null;
      if (!file) return json({ error: "photo field required" }, 400);
      const ext = file.type.includes("png") ? "png" : file.type.includes("webp") ? "webp" : "jpg";
      const storagePath = `${carId}/${Date.now()}.${ext}`;
      const buf = new Uint8Array(await file.arrayBuffer());
      const { error: upErr } = await sb.storage.from("cars").upload(storagePath, buf, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const publicUrl = sb.storage.from("cars").getPublicUrl(storagePath).data.publicUrl;
      const { data: car } = await sb.from("cars").select("images, image_url").eq("id", carId).maybeSingle();
      const existing = ((car as Record<string, unknown>)?.images as string[] | null) || [];
      const newImages = [...existing, publicUrl];
      const imgUrl = ((car as Record<string, unknown>)?.image_url as string) || publicUrl;
      await sb.from("cars").update({ images: newImages, image_url: imgUrl || publicUrl }).eq("id", carId);
      return json({ url: publicUrl, images: newImages });
    }

    // DELETE /fleet/:id/photo — remove a photo
    if (req.method === "DELETE" && photoMatch) {
      const { url } = await req.json();
      const { data: car } = await sb.from("cars").select("images, image_url").eq("id", photoMatch[1]).maybeSingle();
      const c = car as Record<string, unknown>;
      const existing = (c?.images as string[] | null) || [];
      const newImages = existing.filter((u) => u !== url);
      await sb.from("cars").update({ images: newImages, image_url: newImages[0] || "" }).eq("id", photoMatch[1]);
      return json({ images: newImages });
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

    // POST /fleet/:id/pause — Fleet Manager only; Admin is read-only on the schedule
    const pauseMatch = path.match(/^\/fleet\/([^/]+)\/pause$/);
    if (req.method === "POST" && pauseMatch) {
      if (isAdmin) return json({ error: "Admin has view-only access to the schedule. Use a Fleet Manager account to add a pause." }, 403);
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

    // DELETE /fleet/:id/pause/:pauseId — Fleet Manager only
    const deletePauseMatch = path.match(/^\/fleet\/([^/]+)\/pause\/([^/]+)$/);
    if (req.method === "DELETE" && deletePauseMatch) {
      if (isAdmin) return json({ error: "Admin has view-only access to the schedule. Use a Fleet Manager account to remove a pause." }, 403);
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
      const { code, title, description, type, value, minAmount, active, newCustomerOnly } = await req.json();
      if (!code || !title || !value) return json({ error: "code, title and value required" }, 400);
      const { data, error } = await sb.from("coupons").insert({
        id: crypto.randomUUID(), code: String(code).toUpperCase().trim(), title,
        description: description ?? "", type: type === "flat" ? "flat" : "percent",
        value, min_amount: minAmount ?? 0, active: active !== false,
        new_customer_only: newCustomerOnly === true,
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

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
