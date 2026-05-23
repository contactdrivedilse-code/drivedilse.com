const router  = require("express").Router();
const jwt     = require("jsonwebtoken");
const axios   = require("axios");
const cloudinary = require("cloudinary").v2;
const multer  = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const User    = require("../models/User");
const { protect } = require("../middleware/auth");

cloudinary.config({
  cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
  api_key:     process.env.CLOUDINARY_API_KEY,
  api_secret:  process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: { folder: "drivedilse-kyc", allowed_formats: ["jpg", "jpeg", "png", "pdf"] },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendSmsOtp(phone, otp) {
  if (process.env.NODE_ENV !== "production") {
    console.log(`[DEV] OTP for ${phone}: ${otp}`);
    return;
  }
  await axios.get("https://www.fast2sms.com/dev/bulkV2", {
    params: {
      authorization: process.env.FAST2SMS_API_KEY,
      variables_values: otp,
      route: "otp",
      numbers: phone,
    },
  });
}

// POST /api/auth/send-otp
router.post("/send-otp", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^[6-9]\d{9}$/.test(phone))
      return res.status(400).json({ error: "Invalid Indian mobile number" });

    const otp      = generateOtp();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await User.findOneAndUpdate(
      { phone },
      { otp, otpExpiry },
      { upsert: true, new: true }
    );

    await sendSmsOtp(phone, otp);
    res.json({ success: true, message: "OTP sent" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/verify-otp
router.post("/verify-otp", async (req, res) => {
  try {
    const { phone, otp } = req.body;
    const user = await User.findOne({ phone });
    if (!user || user.otp !== otp || !user.otpExpiry || user.otpExpiry < new Date())
      return res.status(400).json({ error: "Invalid or expired OTP" });

    user.otp          = "";
    user.otpExpiry    = null;
    user.phoneVerified = true;
    await user.save();

    const token = jwt.sign({ id: user._id, phone }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { phone: user.phone, name: user.name, kyc: user.kyc, phoneVerified: true } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/profile
router.get("/profile", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-otp -otpExpiry");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/profile  — KYC submission with file uploads
router.post(
  "/profile",
  protect,
  upload.fields([{ name: "aadhaar", maxCount: 1 }, { name: "dl", maxCount: 1 }]),
  async (req, res) => {
    try {
      const { name, dob, email } = req.body;
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ error: "User not found" });

      if (name)  user.name  = name;
      if (dob)   user.dob   = dob;
      if (email) user.email = email;

      if (req.files?.aadhaar?.[0]) {
        user.kyc.aadhaarUrl      = req.files.aadhaar[0].path;
        user.kyc.aadhaarUploaded = true;
        user.kyc.status          = "uploaded";
      }
      if (req.files?.dl?.[0]) {
        user.kyc.dlUrl = req.files.dl[0].path;
        user.kyc.status = "uploaded";
      }

      await user.save();
      res.json({ success: true, user });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
