const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
  bookingId: { type: String, required: true, unique: true },
  car:       { type: mongoose.Schema.Types.ObjectId, ref: "Car", required: true },
  carName:   { type: String },
  user:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  customer:  { type: String },
  phone:     { type: String },
  pickup: {
    date:     { type: Date, required: true },
    location: { type: String, default: "Pune" },
  },
  drop: {
    date:     { type: Date, required: true },
    location: { type: String, default: "Pune" },
  },
  days:        { type: Number, required: true },
  pricePerDay: { type: Number, required: true },
  total:       { type: Number, required: true },
  deposit:     { type: Number, default: 0 },
  discount:    { type: Number, default: 0 },
  payment: {
    razorpayOrderId:   { type: String, default: "" },
    razorpayPaymentId: { type: String, default: "" },
    razorpaySignature: { type: String, default: "" },
    status: { type: String, enum: ["pending", "paid", "failed", "refunded"], default: "pending" },
    paidAt: { type: Date, default: null },
  },
  checkin: {
    photos: {
      front:         { type: String, default: "" },
      rear:          { type: String, default: "" },
      passengerSide: { type: String, default: "" },
      driverSide:    { type: String, default: "" },
    },
    photosUploadedAt: { type: Date, default: null },
    otp:              { type: String, default: "" },
    otpVerified:      { type: Boolean, default: false },
    checkedInAt:      { type: Date, default: null },
  },
  status: {
    type: String,
    enum: ["pending", "confirmed", "active", "completed", "cancelled"],
    default: "pending",
  },
  notes: { type: String, default: "" },
}, { timestamps: true });

module.exports = mongoose.model("Booking", bookingSchema);
