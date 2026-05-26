const router = require("express").Router();
const jwt    = require("jsonwebtoken");
const axios  = require("axios");
const crypto = require("crypto");
const multer = require("multer");
const sb     = require("../db");
const { protect } = require("../middleware/auth");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendSmsOtp(phone, otp) {
  if (!process.env.FAST2SMS_API_KEY) {
    console.log(`[OTP] ${phone} → ${otp}`);
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

function mapProfile(u) {
  return {
    _id:           u.id,
    id:            u.id,
    phone:         u.phone,
    name:          u.name  || "",
    dob:           u.dob   || "",
    email:         u.email || "",
    phoneVerified: u.phone_verified || false,
    kyc: {
      aadhaarUrl:      u.aadhaar_url      || "",
      dlUrl:           u.dl_url           || "",
      aadhaarUploaded: u.aadhaar_uploaded || false,
      dlVerified:      u.dl_verified      || false,
      status:          u.kyc_status       || "pending",
    },
    createdAt: u.created_at,
  };
}

async function uploadKycFile(buffer, mimetype, userId, docType) {
  const ext  = mimetype.includes("pdf") ? "pdf" : "jpg";
  const path = `${userId}/${docType}.${ext}`;
  const { error } = await sb.storage.from("kyc").upload(path, buffer, {
    contentType: mimetype,
    upsert: true,
  });
  if (error) throw error;
  return sb.storage.from("kyc").getPublicUrl(path).data.publicUrl;
}

// POST /api/auth/send-otp
router.post("/send-otp", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^[6-9]\d{9}$/.test(phone))
      return res.status(400).json({ error: "Invalid Indian mobile number" });

    const otp       = generateOtp();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { data: existing } = await sb.from("profiles").select("id").eq("phone", phone).maybeSingle();

    if (existing) {
      await sb.from("profiles").update({ otp, otp_expiry: otpExpiry }).eq("id", existing.id);
    } else {
      await sb.from("profiles").insert({ id: crypto.randomUUID(), phone, otp, otp_expiry: otpExpiry });
    }

    await sendSmsOtp(phone, otp);
    res.json({ success: true, message: "OTP sent" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/verify-otp
router.post("/verify-otp", async (req, res) => {
  try {
    const { phone, otp, name } = req.body;

    const { data: user } = await sb.from("profiles").select("*").eq("phone", phone).maybeSingle();
    if (!user || user.otp !== otp || !user.otp_expiry || new Date(user.otp_expiry) < new Date())
      return res.status(400).json({ error: "Invalid or expired OTP" });

    const updates = { otp: "", otp_expiry: null, phone_verified: true };
    if (name && !user.name) updates.name = name;
    await sb.from("profiles").update(updates).eq("id", user.id);

    const token = jwt.sign({ id: user.id, phone }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: mapProfile({ ...user, ...updates }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/profile
router.get("/profile", protect, async (req, res) => {
  try {
    const { data: user, error } = await sb.from("profiles").select("*").eq("id", req.user.id).maybeSingle();
    if (error) throw error;
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(mapProfile(user));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/profile  — KYC submission
router.post(
  "/profile",
  protect,
  upload.fields([{ name: "aadhaar", maxCount: 1 }, { name: "dl", maxCount: 1 }]),
  async (req, res) => {
    try {
      const { name, dob, email } = req.body;
      const { data: user, error } = await sb.from("profiles").select("*").eq("id", req.user.id).maybeSingle();
      if (error) throw error;
      if (!user) return res.status(404).json({ error: "User not found" });

      const updates = {};
      if (name)  updates.name  = name;
      if (dob)   updates.dob   = dob;
      if (email) updates.email = email;

      if (req.files?.aadhaar?.[0]) {
        const f = req.files.aadhaar[0];
        updates.aadhaar_url      = await uploadKycFile(f.buffer, f.mimetype, user.id, "aadhaar");
        updates.aadhaar_uploaded = true;
        updates.kyc_status       = "uploaded";
      }
      if (req.files?.dl?.[0]) {
        const f = req.files.dl[0];
        updates.dl_url     = await uploadKycFile(f.buffer, f.mimetype, user.id, "dl");
        updates.kyc_status = "uploaded";
      }

      await sb.from("profiles").update(updates).eq("id", user.id);
      const { data: updated } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
      res.json({ success: true, user: mapProfile(updated) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
