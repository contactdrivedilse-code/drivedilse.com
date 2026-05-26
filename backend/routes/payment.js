const router   = require("express").Router();
const Razorpay = require("razorpay");
const crypto   = require("crypto");
const jwt      = require("jsonwebtoken");
const sb       = require("../db");
const { protect } = require("../middleware/auth");

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

function makeBookingId() {
  return "DS" + Date.now().toString(36).toUpperCase();
}

function calcDiscount(days) {
  if (days >= 30) return 0.30;
  if (days >= 14) return 0.20;
  if (days >= 7)  return 0.10;
  return 0;
}

function mapBooking(b) {
  return {
    _id:        b.id,
    id:         b.id,
    bookingId:  b.booking_id,
    car:        { _id: b.car_id, id: b.car_id, name: b.car_name },
    carName:    b.car_name,
    user:       { _id: b.user_id, id: b.user_id, phone: b.phone, name: b.customer },
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
    extensions:  [],
  };
}

// POST /api/payment/guest-order — no JWT; creates user by phone if needed
router.post("/guest-order", async (req, res) => {
  try {
    const { phone, name, carId, pickupDate, dropDate, pickupLocation, dropLocation } = req.body;

    if (!phone || !/^[6-9]\d{9}$/.test(phone))
      return res.status(400).json({ error: "Valid 10-digit Indian mobile number required" });

    const { data: car } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
    if (!car || !car.active) return res.status(404).json({ error: "Car not available" });

    const pickup = new Date(pickupDate);
    const drop   = new Date(dropDate);
    const days   = Math.max(1, Math.ceil((drop - pickup) / 86400000));
    const disc   = calcDiscount(days);
    const total  = Math.round(car.price_per_day * days * (1 - disc));

    // Find or create user
    let { data: user } = await sb.from("profiles").select("id, name").eq("phone", phone).maybeSingle();
    if (!user) {
      const id = require("crypto").randomUUID();
      await sb.from("profiles").insert({ id, phone, name: name || "" });
      user = { id, name: name || "" };
    } else if (name && !user.name) {
      await sb.from("profiles").update({ name }).eq("id", user.id);
    }

    const order = await razorpay.orders.create({
      amount:   total * 100,
      currency: "INR",
      receipt:  makeBookingId(),
      notes:    { carId, phone },
    });

    const token = jwt.sign({ id: user.id, phone }, process.env.JWT_SECRET, { expiresIn: "2h" });

    res.json({
      orderId: order.id, amount: total, currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
      days, pricePerDay: car.price_per_day,
      discount: Math.round(car.price_per_day * days * disc),
      deposit: car.deposit, carName: car.name,
      guestToken: token,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payment/order
router.post("/order", protect, async (req, res) => {
  try {
    const { carId, pickupDate, dropDate, pickupLocation, dropLocation } = req.body;

    const { data: car } = await sb.from("cars").select("*").eq("id", carId).maybeSingle();
    if (!car || !car.active) return res.status(404).json({ error: "Car not available" });

    const pickupISO = new Date(pickupDate).toISOString();
    const dropISO   = new Date(dropDate).toISOString();

    const { data: conflict } = await sb.from("bookings")
      .select("id")
      .eq("car_id", carId)
      .in("status", ["confirmed", "active"])
      .lt("pickup_date", dropISO)
      .gt("drop_date", pickupISO)
      .maybeSingle();

    if (conflict) return res.status(400).json({ error: "Car is already booked for these dates" });

    const pickup = new Date(pickupDate);
    const drop   = new Date(dropDate);
    const days   = Math.max(1, Math.ceil((drop - pickup) / 86400000));
    const disc   = calcDiscount(days);
    const discAmt = Math.round(car.price_per_day * days * disc);
    const total   = car.price_per_day * days - discAmt;

    const order = await razorpay.orders.create({
      amount:   total * 100,
      currency: "INR",
      receipt:  makeBookingId(),
      notes:    { carId, phone: req.user.phone },
    });

    res.json({
      orderId: order.id, amount: total, currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
      days, pricePerDay: car.price_per_day,
      discount: discAmt, deposit: car.deposit, carName: car.name,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/payment/verify
router.post("/verify", protect, async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, carId, pickupDate, dropDate, pickupLocation, dropLocation } = req.body;

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");
    if (expected !== razorpaySignature)
      return res.status(400).json({ error: "Payment verification failed" });

    const [{ data: car }, { data: user }] = await Promise.all([
      sb.from("cars").select("*").eq("id", carId).maybeSingle(),
      sb.from("profiles").select("*").eq("id", req.user.id).maybeSingle(),
    ]);

    const pickup = new Date(pickupDate);
    const drop   = new Date(dropDate);
    const days   = Math.max(1, Math.ceil((drop - pickup) / 86400000));
    const disc   = calcDiscount(days);
    const total  = Math.round(car.price_per_day * days * (1 - disc));

    const bookingId = makeBookingId();
    const { data: booking, error } = await sb.from("bookings").insert({
      id:                   require("crypto").randomUUID(),
      booking_id:           bookingId,
      car_id:               car.id,
      car_name:             car.name,
      user_id:              user.id,
      customer:             user.name || "",
      phone:                user.phone,
      pickup_date:          pickup.toISOString(),
      pickup_location:      pickupLocation || "Pune",
      drop_date:            drop.toISOString(),
      drop_location:        dropLocation   || "Pune",
      days,
      price_per_day:        car.price_per_day,
      total,
      deposit:              car.deposit,
      discount:             Math.round(car.price_per_day * days * disc),
      razorpay_order_id:    razorpayOrderId,
      razorpay_payment_id:  razorpayPaymentId,
      razorpay_signature:   razorpaySignature,
      payment_status:       "paid",
      paid_at:              new Date().toISOString(),
      status:               "confirmed",
    }).select("*").maybeSingle();

    if (error) throw error;

    const token = jwt.sign({ id: user.id, phone: user.phone }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ success: true, bookingId, booking: mapBooking(booking), token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
