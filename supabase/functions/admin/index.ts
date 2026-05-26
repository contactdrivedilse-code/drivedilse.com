import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { signJwt, verifyJwt, getBearer } from "../_shared/jwt.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function mapBooking(b: Record<string, unknown>) {
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
    extensions: [],
  };
}

async function getAdmin(req: Request) {
  const token = getBearer(req);
  if (!token) return null;
  try {
    const p = await verifyJwt(token, Deno.env.get("ADMIN_JWT_SECRET")!) as { role?: string };
    return p.role === "admin" ? p : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const url  = new URL(req.url);
  const path = url.pathname.replace("/admin", "") || "/";

  try {
    // POST /login
    if (req.method === "POST" && path === "/login") {
      const { password } = await req.json();
      if (password !== Deno.env.get("ADMIN_PASSWORD"))
        return json({ error: "Invalid password" }, 401);
      const token = await signJwt({ role: "admin" }, Deno.env.get("ADMIN_JWT_SECRET")!, 24 * 60 * 60);
      return json({ token });
    }

    // All routes below require admin auth
    const admin = await getAdmin(req);
    if (!admin) return json({ error: "Admin access required" }, 401);

    // GET /dashboard
    if (req.method === "GET" && path === "/dashboard") {
      const [{ count: totalCars }, { count: totalBookings }, { count: totalCustomers }, { data: paid }] = await Promise.all([
        sb.from("cars").select("*", { count: "exact", head: true }).eq("active", true),
        sb.from("bookings").select("*", { count: "exact", head: true }),
        sb.from("profiles").select("*", { count: "exact", head: true }).eq("phone_verified", true),
        sb.from("bookings").select("total").eq("payment_status", "paid"),
      ]);
      const revenue = (paid ?? []).reduce((s: number, b: Record<string, unknown>) => s + (b.total as number), 0);
      return json({ totalCars, totalBookings, totalCustomers, revenue });
    }

    // GET /bookings
    if (req.method === "GET" && path === "/bookings") {
      const { data, error } = await sb.from("bookings").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return json((data ?? []).map((b: Record<string, unknown>) => mapBooking(b)));
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
        .select("id, phone, name, dob, email, aadhaar_uploaded, dl_verified, kyc_status, phone_verified, created_at")
        .eq("phone_verified", true).order("created_at", { ascending: false });
      if (error) throw error;
      return json(data);
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
      return json(data);
    }

    // GET /fleet
    if (req.method === "GET" && path === "/fleet") {
      const { data, error } = await sb.from("cars").select("*").order("name", { ascending: true });
      if (error) throw error;
      return json(data);
    }

    // PUT /fleet/:id/toggle
    const toggleMatch = path.match(/^\/fleet\/([^/]+)\/toggle$/);
    if (req.method === "PUT" && toggleMatch) {
      const { data: car } = await sb.from("cars").select("active").eq("id", toggleMatch[1]).maybeSingle();
      if (!car) return json({ error: "Car not found" }, 404);
      const { data, error } = await sb.from("cars")
        .update({ active: !(car as Record<string, unknown>).active })
        .eq("id", toggleMatch[1]).select("id, active").maybeSingle();
      if (error) throw error;
      return json(data);
    }

    // POST /fleet/:id/pause
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

    // DELETE /fleet/:id/pause/:pauseId
    const deletePauseMatch = path.match(/^\/fleet\/([^/]+)\/pause\/([^/]+)$/);
    if (req.method === "DELETE" && deletePauseMatch) {
      const { error } = await sb.from("car_pauses").delete().eq("id", deletePauseMatch[2]).eq("car_id", deletePauseMatch[1]);
      if (error) throw error;
      return json({ success: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
