const router   = require("express").Router();
const crypto   = require("crypto");
const multer   = require("multer");
const Razorpay = require("razorpay");
const sb       = require("../db");
const { protect } = require("../middleware/auth");

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const CHECKIN_WINDOW_MINS = 30;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function uploadCheckinPhoto(buffer, mimetype, bookingId, side) {
  const path = `${bookingId}/${side}.jpg`;
  const { error } = await sb.storage.from("checkin").upload(path, buffer, {
    contentType: mimetype,
    upsert: true,
  });
  if (error) throw error;
  return sb.storage.from("checkin").getPublicUrl(path).data.publicUrl;
}

function mapBooking(b, extensions) {
  return {
    _id:        b.id,
    id:         b.id,
    bookingId:  b.booking_id,
    car:        { _id: b.car_id, id: b.car_id, name: b.car_name },
    carName:    b.car_name,
    user:       { _id: b.user_id, id: b.user_id },
    customer:   b.customer,
    phone:      b.phone,
    pickup:     { date: b.pickup_date, location: b.pickup_location },
    drop:       { date: b.drop_date,   location: b.drop_location },
    days:       b.days,
    pricePerDay: b.price_per_day,
    total:      b.total,
    deposit:    b.deposit,
    discount:   b.discount,
    payment: {
      razorpayOrderId:   b.razorpay_order_id,
      razorpayPaymentId: b.razorpay_payment_id,
      razorpaySignature: b.razorpay_signature,
      status:            b.payment_status,
      paidAt:            b.paid_at,
    },
    checkin: {
      photos: {
        front:         b.checkin_front,
        rear:          b.checkin_rear,
        passengerSide: b.checkin_passenger_side,
        driverSide:    b.checkin_driver_side,
      },
      photosUploadedAt: b.checkin_photos_at,
      otp:              b.checkin_otp,
      otpVerified:      b.checkin_otp_verified,
      checkedInAt:      b.checked_in_at,
    },
    checkout: {
      otp:          b.checkout_otp,
      otpVerified:  b.checkout_otp_verified,
      checkedOutAt: b.checked_out_at,
    },
    status:      b.status,
    cancelledAt: b.cancelled_at,
    notes:       b.notes,
    createdAt:   b.created_at,
    updatedAt:   b.updated_at,
    extensions:  (extensions || []).map(e => ({
      hours:             e.hours,
      cost:              e.cost,
      razorpayOrderId:   e.razorpay_order_id,
      razorpayPaymentId: e.razorpay_payment_id,
      extendedAt:        e.extended_at,
    })),
  };
}

// GET /api/bookings — user's own bookings
router.get("/", protect, async (req, res) => {
  try {
    const { data: bookings, error } = await sb.from("bookings")
      .select("*")
      .eq("user_id", req.user.id)
      .order("pickup_date", { ascending: true });
    if (error) throw error;

    const { data: exts } = await sb.from("extensions")
      .select("*")
      .in("booking_id", (bookings || []).map(b => b.id));

    const extsByBooking = {};
    for (const e of exts || []) {
      if (!extsByBooking[e.booking_id]) extsByBooking[e.booking_id] = [];
      extsByBooking[e.booking_id].push(e);
    }

    res.json((bookings || []).map(b => mapBooking(b, extsByBooking[b.id])));
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
      const { data: booking } = await sb.from("bookings")
        .select("*").eq("id", req.params.id).eq("user_id", req.user.id).maybeSingle();
      if (!booking) return res.status(404).json({ error: "Booking not found" });
      if (booking.status !== "confirmed")
        return res.status(400).json({ error: "Booking is not in confirmed state" });

      const nowMs    = Date.now();
      const pickupMs = new Date(booking.pickup_date).getTime();
      if (nowMs < pickupMs - CHECKIN_WINDOW_MINS * 60000)
        return res.status(400).json({ error: `Check-in opens ${CHECKIN_WINDOW_MINS} minutes before your pickup time` });

      const files   = req.files || {};
      const missing = ["front", "rear", "passengerSide", "driverSide"].filter(k => !files[k]?.[0]);
      if (missing.length)
        return res.status(400).json({ error: `Missing photos: ${missing.join(", ")}` });

      const [front, rear, passengerSide, driverSide] = await Promise.all([
        uploadCheckinPhoto(files.front[0].buffer,         files.front[0].mimetype,         booking.id, "front"),
        uploadCheckinPhoto(files.rear[0].buffer,          files.rear[0].mimetype,          booking.id, "rear"),
        uploadCheckinPhoto(files.passengerSide[0].buffer, files.passengerSide[0].mimetype, booking.id, "passengerSide"),
        uploadCheckinPhoto(files.driverSide[0].buffer,    files.driverSide[0].mimetype,    booking.id, "driverSide"),
      ]);

      const otp = generateOtp();
      await sb.from("bookings").update({
        checkin_front:           front,
        checkin_rear:            rear,
        checkin_passenger_side:  passengerSide,
        checkin_driver_side:     driverSide,
        checkin_photos_at:       new Date().toISOString(),
        checkin_otp:             otp,
        checkin_otp_verified:    false,
        updated_at:              new Date().toISOString(),
      }).eq("id", booking.id);

      res.json({ success: true, message: "Photos uploaded. Get your check-in OTP from the DriveDilSe representative." });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// POST /api/bookings/:id/checkin/verify
router.post("/:id/checkin/verify", protect, async (req, res) => {
  try {
    const { otp } = req.body;
    const { data: booking } = await sb.from("bookings")
      .select("*").eq("id", req.params.id).eq("user_id", req.user.id).maybeSingle();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "confirmed")
      return res.status(400).json({ error: "Booking is not in confirmed state" });
    if (!booking.checkin_otp)
      return res.status(400).json({ error: "Upload car photos first to receive your OTP" });
    if (booking.checkin_otp !== otp)
      return res.status(400).json({ error: "Incorrect OTP. Get it from the DriveDilSe representative." });

    const checkoutOtp = generateOtp();
    await sb.from("bookings").update({
      checkin_otp_verified: true,
      checked_in_at:        new Date().toISOString(),
      checkout_otp:         checkoutOtp,
      checkout_otp_verified: false,
      status:               "active",
      updated_at:           new Date().toISOString(),
    }).eq("id", booking.id);

    res.json({ success: true, message: "Check-in complete! Enjoy your drive." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bookings/:id/extend/order
router.post("/:id/extend/order", protect, async (req, res) => {
  try {
    const { hours } = req.body;
    if (!hours || hours <= 0) return res.status(400).json({ error: "Invalid hours" });

    const { data: booking } = await sb.from("bookings")
      .select("*").eq("id", req.params.id).eq("user_id", req.user.id).maybeSingle();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!["confirmed", "active"].includes(booking.status))
      return res.status(400).json({ error: "Can only extend confirmed or active bookings" });

    const pph  = Math.round(booking.price_per_day / 24);
    const cost = hours < 24 ? pph * hours : booking.price_per_day * (hours / 24);

    const order = await razorpay.orders.create({
      amount:   Math.round(cost) * 100,
      currency: "INR",
      receipt:  "EXT_" + booking.booking_id,
      notes:    { bookingId: booking.booking_id, hours },
    });

    res.json({ orderId: order.id, amount: Math.round(cost), currency: "INR", keyId: process.env.RAZORPAY_KEY_ID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bookings/:id/extend/verify
router.post("/:id/extend/verify", protect, async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, hours } = req.body;

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");
    if (expected !== razorpaySignature)
      return res.status(400).json({ error: "Payment verification failed" });

    const { data: booking } = await sb.from("bookings")
      .select("*").eq("id", req.params.id).eq("user_id", req.user.id).maybeSingle();
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const pph       = Math.round(booking.price_per_day / 24);
    const cost      = hours < 24 ? pph * hours : booking.price_per_day * (hours / 24);
    const newDrop   = new Date(new Date(booking.drop_date).getTime() + hours * 3600000);
    const newDays   = Math.max(1, Math.ceil((newDrop - new Date(booking.pickup_date)) / 86400000));
    const newTotal  = booking.total + Math.round(cost);

    await sb.from("bookings").update({
      drop_date:  newDrop.toISOString(),
      days:       newDays,
      total:      newTotal,
      updated_at: new Date().toISOString(),
    }).eq("id", booking.id);

    await sb.from("extensions").insert({
      id:                  crypto.randomUUID(),
      booking_id:          booking.id,
      hours,
      cost:                Math.round(cost),
      razorpay_order_id:   razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature:  razorpaySignature,
    });

    res.json({ success: true, newDrop: newDrop.toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/bookings/:id/cancel
router.put("/:id/cancel", protect, async (req, res) => {
  try {
    const { data: booking } = await sb.from("bookings")
      .select("id, status").eq("id", req.params.id).eq("user_id", req.user.id).maybeSingle();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "confirmed")
      return res.status(400).json({ error: "Only confirmed bookings can be cancelled" });

    await sb.from("bookings").update({
      status:       "cancelled",
      cancelled_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    }).eq("id", booking.id);

    res.json({ success: true, message: "Booking cancelled." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bookings/:id/checkout/verify
router.post("/:id/checkout/verify", protect, async (req, res) => {
  try {
    const { otp } = req.body;
    const { data: booking } = await sb.from("bookings")
      .select("*").eq("id", req.params.id).eq("user_id", req.user.id).maybeSingle();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "active")
      return res.status(400).json({ error: "Booking is not active" });
    if (!booking.checkout_otp)
      return res.status(400).json({ error: "Checkout OTP not yet generated" });
    if (booking.checkout_otp !== otp)
      return res.status(400).json({ error: "Incorrect OTP. Get it from the DriveDilSe representative." });

    await sb.from("bookings").update({
      checkout_otp_verified: true,
      checked_out_at:        new Date().toISOString(),
      status:                "completed",
      updated_at:            new Date().toISOString(),
    }).eq("id", booking.id);

    res.json({ success: true, message: "Booking closed. Thank you for driving with DriveDilSe!" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
