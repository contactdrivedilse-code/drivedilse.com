const router = require("express").Router();
const jwt    = require("jsonwebtoken");
const sb     = require("../db");
const { protectAdmin } = require("../middleware/auth");

// POST /api/admin/login
router.post("/login", async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== process.env.ADMIN_PASSWORD)
      return res.status(401).json({ error: "Invalid password" });
    const token = jwt.sign({ role: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "24h" });
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/dashboard
router.get("/dashboard", protectAdmin, async (req, res) => {
  try {
    const [
      { count: totalCars },
      { count: totalBookings },
      { count: totalCustomers },
      { data: paidBookings },
    ] = await Promise.all([
      sb.from("cars").select("*", { count: "exact", head: true }).eq("active", true),
      sb.from("bookings").select("*", { count: "exact", head: true }),
      sb.from("profiles").select("*", { count: "exact", head: true }).eq("phone_verified", true),
      sb.from("bookings").select("total").eq("payment_status", "paid"),
    ]);

    const revenue = (paidBookings || []).reduce((s, b) => s + b.total, 0);
    res.json({ totalCars, totalBookings, totalCustomers, revenue });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/bookings
router.get("/bookings", protectAdmin, async (req, res) => {
  try {
    const { data: bookings, error } = await sb.from("bookings")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(bookings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/bookings/:id/status
router.put("/bookings/:id/status", protectAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await sb.from("bookings")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Booking not found" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/customers
router.get("/customers", protectAdmin, async (req, res) => {
  try {
    const { data, error } = await sb.from("profiles")
      .select("id, phone, name, dob, email, aadhaar_uploaded, dl_verified, kyc_status, phone_verified, created_at")
      .eq("phone_verified", true)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/fleet
router.get("/fleet", protectAdmin, async (req, res) => {
  try {
    const { data, error } = await sb.from("cars").select("*").order("name", { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/fleet/:id/toggle
router.put("/fleet/:id/toggle", protectAdmin, async (req, res) => {
  try {
    const { data: car } = await sb.from("cars").select("active").eq("id", req.params.id).maybeSingle();
    if (!car) return res.status(404).json({ error: "Car not found" });
    const { data, error } = await sb.from("cars")
      .update({ active: !car.active })
      .eq("id", req.params.id)
      .select("id, active")
      .maybeSingle();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/fleet/:id/pause
router.post("/fleet/:id/pause", protectAdmin, async (req, res) => {
  try {
    const { from, to, note } = req.body;
    const { data: car } = await sb.from("cars").select("id").eq("id", req.params.id).maybeSingle();
    if (!car) return res.status(404).json({ error: "Car not found" });

    const { data, error } = await sb.from("car_pauses").insert({
      id:        require("crypto").randomUUID(),
      car_id:    req.params.id,
      from_date: new Date(from).toISOString(),
      to_date:   new Date(to).toISOString(),
      note:      note || "",
    }).select("*").maybeSingle();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/fleet/:id/pause/:pauseId
router.delete("/fleet/:id/pause/:pauseId", protectAdmin, async (req, res) => {
  try {
    const { error } = await sb.from("car_pauses")
      .delete()
      .eq("id", req.params.pauseId)
      .eq("car_id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/customers/:id/kyc
router.put("/customers/:id/kyc", protectAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const updates = { kyc_status: status };
    if (status === "verified") updates.dl_verified = true;

    const { data, error } = await sb.from("profiles")
      .update(updates)
      .eq("id", req.params.id)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "User not found" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/bookings/:id/checkin-otp — admin reveals checkin OTP
router.post("/bookings/:id/checkin-otp", protectAdmin, async (req, res) => {
  try {
    const { data: booking } = await sb.from("bookings")
      .select("checkin_otp, status").eq("id", req.params.id).maybeSingle();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "confirmed")
      return res.status(400).json({ error: "Booking is not in confirmed state" });
    res.json({ otp: booking.checkin_otp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/bookings/:id/checkout-otp — admin reveals checkout OTP
router.post("/bookings/:id/checkout-otp", protectAdmin, async (req, res) => {
  try {
    const { data: booking } = await sb.from("bookings")
      .select("checkout_otp, status").eq("id", req.params.id).maybeSingle();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "active")
      return res.status(400).json({ error: "Booking is not active" });
    res.json({ otp: booking.checkout_otp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
