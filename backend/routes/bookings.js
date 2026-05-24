const router     = require("express").Router();
const cloudinary = require("cloudinary").v2;
const multer     = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const Booking    = require("../models/Booking");
const { protect } = require("../middleware/auth");

cloudinary.config({
  cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
  api_key:     process.env.CLOUDINARY_API_KEY,
  api_secret:  process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: { folder: "drivedilse-checkin", allowed_formats: ["jpg", "jpeg", "png", "webp"] },
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

const CHECKIN_WINDOW_MINS = 30;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// GET /api/bookings — user's own bookings
router.get("/", protect, async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.user.id })
      .populate("car", "name category image")
      .sort({ "pickup.date": 1 });
    res.json(bookings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bookings/:id/checkin — upload 4 car photos, generate check-in OTP
router.post(
  "/:id/checkin",
  protect,
  upload.fields([
    { name: "front",         maxCount: 1 },
    { name: "rear",          maxCount: 1 },
    { name: "passengerSide", maxCount: 1 },
    { name: "driverSide",    maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const booking = await Booking.findOne({ _id: req.params.id, user: req.user.id });
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.status !== "confirmed")
        return res.status(400).json({ error: "Booking is not in confirmed state" });

      // Enforce 30-min window
      const pickupMs   = new Date(booking.pickup.date).getTime();
      const nowMs      = Date.now();
      const windowMs   = CHECKIN_WINDOW_MINS * 60 * 1000;
      if (nowMs < pickupMs - windowMs)
        return res.status(400).json({ error: `Check-in opens ${CHECKIN_WINDOW_MINS} minutes before your pickup time` });

      const files = req.files || {};
      const required = ["front", "rear", "passengerSide", "driverSide"];
      const missing  = required.filter(k => !files[k]?.[0]);
      if (missing.length)
        return res.status(400).json({ error: `Missing photos: ${missing.join(", ")}` });

      booking.checkin.photos.front         = files.front[0].path;
      booking.checkin.photos.rear          = files.rear[0].path;
      booking.checkin.photos.passengerSide = files.passengerSide[0].path;
      booking.checkin.photos.driverSide    = files.driverSide[0].path;
      booking.checkin.photosUploadedAt     = new Date();
      booking.checkin.otp                  = generateOtp();
      booking.checkin.otpVerified          = false;

      await booking.save();
      res.json({ success: true, message: "Photos uploaded. Get your check-in OTP from the DriveDilSe representative." });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// POST /api/bookings/:id/checkin/verify — enter OTP, activate booking
router.post("/:id/checkin/verify", protect, async (req, res) => {
  try {
    const { otp } = req.body;
    const booking = await Booking.findOne({ _id: req.params.id, user: req.user.id });
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "confirmed")
      return res.status(400).json({ error: "Booking is not in confirmed state" });
    if (!booking.checkin.otp)
      return res.status(400).json({ error: "Upload car photos first to receive your OTP" });
    if (booking.checkin.otp !== otp)
      return res.status(400).json({ error: "Incorrect OTP. Get it from the DriveDilSe representative." });

    booking.checkin.otpVerified  = true;
    booking.checkin.checkedInAt  = new Date();
    booking.status               = "active";
    booking.checkout.otp         = generateOtp();
    booking.checkout.otpVerified = false;
    await booking.save();

    res.json({ success: true, message: "Check-in complete! Enjoy your drive." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bookings/:id/checkout/verify — rep shares checkout OTP, booking closes
router.post("/:id/checkout/verify", protect, async (req, res) => {
  try {
    const { otp } = req.body;
    const booking = await Booking.findOne({ _id: req.params.id, user: req.user.id });
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "active")
      return res.status(400).json({ error: "Booking is not active" });
    if (!booking.checkout.otp)
      return res.status(400).json({ error: "Checkout OTP not yet generated" });
    if (booking.checkout.otp !== otp)
      return res.status(400).json({ error: "Incorrect OTP. Get it from the DriveDilSe representative." });

    booking.checkout.otpVerified  = true;
    booking.checkout.checkedOutAt = new Date();
    booking.status                = "completed";
    await booking.save();

    res.json({ success: true, message: "Booking closed. Thank you for driving with DriveDilSe!" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
