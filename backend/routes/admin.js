const router  = require("express").Router();
const jwt     = require("jsonwebtoken");
const bcrypt  = require("bcryptjs");
const Car     = require("../models/Car");
const Booking = require("../models/Booking");
const User    = require("../models/User");
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
    const [totalCars, totalBookings, totalCustomers, bookings] = await Promise.all([
      Car.countDocuments({ active: true }),
      Booking.countDocuments(),
      User.countDocuments({ phoneVerified: true }),
      Booking.find({ "payment.status": "paid" }).select("total"),
    ]);
    const revenue = bookings.reduce((s, b) => s + b.total, 0);
    res.json({ totalCars, totalBookings, totalCustomers, revenue });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/bookings
router.get("/bookings", protectAdmin, async (req, res) => {
  try {
    const bookings = await Booking.find()
      .populate("car", "name category")
      .populate("user", "phone name")
      .sort({ createdAt: -1 });
    res.json(bookings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/bookings/:id/status
router.put("/bookings/:id/status", protectAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const booking = await Booking.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    res.json(booking);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/customers
router.get("/customers", protectAdmin, async (req, res) => {
  try {
    const users = await User.find({ phoneVerified: true }).select("-otp -otpExpiry").sort({ createdAt: -1 });
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/fleet
router.get("/fleet", protectAdmin, async (req, res) => {
  try {
    const cars = await Car.find().sort({ name: 1 });
    res.json(cars);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/fleet/:id/toggle
router.put("/fleet/:id/toggle", protectAdmin, async (req, res) => {
  try {
    const car = await Car.findById(req.params.id);
    if (!car) return res.status(404).json({ error: "Car not found" });
    car.active = !car.active;
    await car.save();
    res.json({ id: car._id, active: car.active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/fleet/:id/pause
router.post("/fleet/:id/pause", protectAdmin, async (req, res) => {
  try {
    const { from, to, note } = req.body;
    const car = await Car.findById(req.params.id);
    if (!car) return res.status(404).json({ error: "Car not found" });
    car.pauses.push({ from, to, note });
    await car.save();
    res.json(car);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/fleet/:id/pause/:pauseId
router.delete("/fleet/:id/pause/:pauseId", protectAdmin, async (req, res) => {
  try {
    const car = await Car.findById(req.params.id);
    if (!car) return res.status(404).json({ error: "Car not found" });
    car.pauses = car.pauses.filter(p => p._id.toString() !== req.params.pauseId);
    await car.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/customers/:id/kyc
router.put("/customers/:id/kyc", protectAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { "kyc.status": status, ...(status === "verified" ? { "kyc.dlVerified": true } : {}) },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
