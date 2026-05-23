const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  phone:     { type: String, required: true, unique: true },
  name:      { type: String, default: "" },
  dob:       { type: String, default: "" },
  email:     { type: String, default: "" },
  otp:       { type: String, default: "" },
  otpExpiry: { type: Date,   default: null },
  kyc: {
    aadhaarUrl: { type: String, default: "" },
    dlUrl:      { type: String, default: "" },
    aadhaarUploaded: { type: Boolean, default: false },
    dlVerified:      { type: Boolean, default: false },
    status: { type: String, enum: ["pending", "uploaded", "verified", "rejected"], default: "pending" },
  },
  phoneVerified: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);
