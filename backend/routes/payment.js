const router   = require("express").Router();
const Razorpay = require("razorpay");
const crypto   = require("crypto");
const Car      = require("../models/Car");
const Booking  = require("../models/Booking");
const User     = require("../models/User");
const { protect } = require("../middleware/auth");

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

function makeBookingId() {
  return "DS" + Date.now().toString(36).toUpperCase();
}

// POST /api/payment/order
router.post("/order", protect, async (req, res) => {
  try {
    const { carId, pickupDate, dropDate, pickupLocation, dropLocation } = req.body;

    const car = await Car.findById(carId);
    if (!car || !car.active) return res.status(404).json({ error: "Car not available" });
    if (!car.isAvailable(pickupDate, dropDate))
      return res.status(400).json({ error: "Car not available for selected dates" });

    const pickup = new Date(pickupDate);
    const drop   = new Date(dropDate);
    const days   = Math.max(1, Math.ceil((drop - pickup) / (1000 * 60 * 60 * 24)));

    let discount = 0;
    if (days >= 30)      discount = 0.30;
    else if (days >= 14) discount = 0.20;
    else if (days >= 7)  discount = 0.10;

    const pricePerDay  = car.pricePerDay;
    const baseTotal    = pricePerDay * days;
    const discountAmt  = Math.round(baseTotal * discount);
    const total        = baseTotal - discountAmt;

    const order = await razorpay.orders.create({
      amount:   total * 100, // paise
      currency: "INR",
      receipt:  makeBookingId(),
      notes:    { carId, phone: req.user.phone },
    });

    res.json({
      orderId: order.id,
      amount:  total,
      currency: "INR",
      keyId:   process.env.RAZORPAY_KEY_ID,
      days,
      pricePerDay,
      discount: discountAmt,
      deposit:  car.deposit,
      carName:  car.name,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payment/verify
router.post("/verify", protect, async (req, res) => {
  try {
    const {
      razorpayOrderId, razorpayPaymentId, razorpaySignature,
      carId, pickupDate, dropDate, pickupLocation, dropLocation,
    } = req.body;

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (expected !== razorpaySignature)
      return res.status(400).json({ error: "Payment verification failed" });

    const car    = await Car.findById(carId);
    const user   = await User.findById(req.user.id);
    const pickup = new Date(pickupDate);
    const drop   = new Date(dropDate);
    const days   = Math.max(1, Math.ceil((drop - pickup) / (1000 * 60 * 60 * 24)));

    let discount = 0;
    if (days >= 30)      discount = 0.30;
    else if (days >= 14) discount = 0.20;
    else if (days >= 7)  discount = 0.10;

    const pricePerDay = car.pricePerDay;
    const total       = Math.round(pricePerDay * days * (1 - discount));

    const booking = await Booking.create({
      bookingId:   makeBookingId(),
      car:         car._id,
      carName:     car.name,
      user:        user._id,
      customer:    user.name || "",
      phone:       user.phone,
      pickup:      { date: pickup, location: pickupLocation || "Pune" },
      drop:        { date: drop,   location: dropLocation   || "Pune" },
      days,
      pricePerDay,
      total,
      deposit:     car.deposit,
      discount:    Math.round(pricePerDay * days * discount),
      payment: {
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature,
        status: "paid",
        paidAt: new Date(),
      },
      status: "confirmed",
    });

    res.json({ success: true, bookingId: booking.bookingId, booking });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
