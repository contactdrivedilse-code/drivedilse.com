const mongoose = require("mongoose");

const pauseSchema = new mongoose.Schema({
  from: { type: Date, required: true },
  to:   { type: Date, required: true },
  note: { type: String, default: "" },
});

const carSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  category:   { type: String, enum: ["Hatchback", "Sedan", "SUV", "MPV"], required: true },
  fuel:       { type: String, default: "Petrol" },
  seats:      { type: Number, default: 5 },
  transmission: { type: String, enum: ["Manual", "Automatic"], default: "Manual" },
  pricePerDay:  { type: Number, required: true },
  deposit:      { type: Number, default: 0 },
  features:     [String],
  image:        { type: String, default: "" },
  active:       { type: Boolean, default: true },
  pauses:       [pauseSchema],
}, { timestamps: true });

carSchema.methods.isAvailable = function (pickup, drop) {
  if (!this.active) return false;
  const p = new Date(pickup);
  const d = new Date(drop);
  return !this.pauses.some(pause => p < pause.to && d > pause.from);
};

module.exports = mongoose.model("Car", carSchema);
