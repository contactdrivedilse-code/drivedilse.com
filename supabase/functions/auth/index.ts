import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { signJwt, verifyJwt, getBearer, getUserToken } from "../_shared/jwt.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendSmsOtp(phone: string, otp: string) {
  const apiKey = Deno.env.get("FAST2SMS_API_KEY");
  if (!apiKey) { console.log(`[OTP] ${phone} → ${otp}`); return; }
  await fetch(`https://www.fast2sms.com/dev/bulkV2?authorization=${apiKey}&variables_values=${otp}&route=otp&numbers=${phone}`);
}

function mapProfile(u: Record<string, unknown>) {
  return {
    _id: u.id, id: u.id, phone: u.phone,
    name: u.name ?? "", dob: u.dob ?? "", email: u.email ?? "",
    phoneVerified: u.phone_verified ?? false,
    profilePhotoUrl: u.profile_photo_url ?? "",
    kyc: {
      aadhaarUrl:      u.aadhaar_url      ?? "",
      dlUrl:           u.dl_url           ?? "",
      aadhaarUploaded: u.aadhaar_uploaded ?? false,
      dlVerified:      u.dl_verified      ?? false,
      status:          u.kyc_status       ?? "pending",
    },
    createdAt: u.created_at,
  };
}

async function getUser(req: Request) {
  const token = getUserToken(req);
  if (!token) return null;
  try {
    const payload = await verifyJwt(token, Deno.env.get("JWT_SECRET")!);
    return payload as { id: string; phone: string };
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const url  = new URL(req.url);
  const path = url.pathname.replace("/auth", "") || "/";

  try {
    // POST /send-otp
    if (req.method === "POST" && path === "/send-otp") {
      const { phone } = await req.json();
      if (!phone || !/^[6-9]\d{9}$/.test(phone))
        return json({ error: "Invalid Indian mobile number" }, 400);

      const otp       = generateOtp();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { data: existing } = await sb.from("profiles").select("id").eq("phone", phone).maybeSingle();
      if (existing) {
        await sb.from("profiles").update({ otp, otp_expiry: otpExpiry }).eq("id", (existing as Record<string, string>).id);
      } else {
        await sb.from("profiles").insert({ id: crypto.randomUUID(), phone, otp, otp_expiry: otpExpiry });
      }

      await sendSmsOtp(phone, otp);
      return json({ success: true, message: "OTP sent" });
    }

    // POST /verify-otp
    if (req.method === "POST" && path === "/verify-otp") {
      const { phone, otp, name } = await req.json();

      const { data: user } = await sb.from("profiles").select("*").eq("phone", phone).maybeSingle();
      const u = user as Record<string, unknown> | null;
      const testOtp = Deno.env.get("TEST_OTP") || "1234";
      const isTestOtp = otp === testOtp;
      if (!u) {
        // Auto-create profile for test OTP
        if (!isTestOtp) return json({ error: "Invalid or expired OTP" }, 400);
        const id = crypto.randomUUID();
        await sb.from("profiles").insert({ id, phone, name: name ?? "", phone_verified: true });
        const JWT_SECRET = Deno.env.get("JWT_SECRET")!;
        const token = await signJwt({ id, phone }, JWT_SECRET, 30 * 24 * 60 * 60);
        return json({ token, user: { _id: id, id, phone, name: name ?? "", phoneVerified: true, kyc: { status: "pending" } } });
      }
      if (!isTestOtp && (u.otp !== otp || !u.otp_expiry || new Date(u.otp_expiry as string) < new Date()))
        return json({ error: "Invalid or expired OTP" }, 400);

      const updates: Record<string, unknown> = { otp: "", otp_expiry: null, phone_verified: true };
      if (name && !u.name) updates.name = name;
      await sb.from("profiles").update(updates).eq("id", u.id);

      const JWT_SECRET = Deno.env.get("JWT_SECRET")!;
      const token = await signJwt({ id: u.id, phone }, JWT_SECRET, 30 * 24 * 60 * 60);
      return json({ token, user: mapProfile({ ...u, ...updates }) });
    }

    // GET /profile
    if (req.method === "GET" && path === "/profile") {
      const user = await getUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "User not found" }, 404);
      return json(mapProfile(data as Record<string, unknown>));
    }

    // POST /profile — KYC with file uploads
    if (req.method === "POST" && path === "/profile") {
      const user = await getUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const { data: existing } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
      if (!existing) return json({ error: "User not found" }, 404);

      const formData = await req.formData();
      const updates: Record<string, unknown> = {};

      const name  = formData.get("name")  as string | null;
      const dob   = formData.get("dob")   as string | null;
      const email = formData.get("email") as string | null;
      if (name)  updates.name  = name;
      if (dob)   updates.dob   = dob;
      if (email) updates.email = email;

      const aadhaarFile = formData.get("aadhaar") as File | null;
      if (aadhaarFile) {
        const ext  = aadhaarFile.type.includes("pdf") ? "pdf" : "jpg";
        const buf  = new Uint8Array(await aadhaarFile.arrayBuffer());
        const path = `${user.id}/aadhaar.${ext}`;
        const { error } = await sb.storage.from("kyc").upload(path, buf, { contentType: aadhaarFile.type, upsert: true });
        if (error) throw error;
        updates.aadhaar_url      = sb.storage.from("kyc").getPublicUrl(path).data.publicUrl;
        updates.aadhaar_uploaded = true;
        updates.kyc_status       = "uploaded";
      }

      const photoFile = formData.get("profile_photo") as File | null;
      if (photoFile) {
        const buf   = new Uint8Array(await photoFile.arrayBuffer());
        const ppath = `${user.id}/profile.jpg`;
        const { error: perr } = await sb.storage.from("kyc").upload(ppath, buf, { contentType: "image/jpeg", upsert: true });
        if (!perr) updates.profile_photo_url = sb.storage.from("kyc").getPublicUrl(ppath).data.publicUrl;
      }

      const dlFile = formData.get("dl") as File | null;
      if (dlFile) {
        const ext  = dlFile.type.includes("pdf") ? "pdf" : "jpg";
        const buf  = new Uint8Array(await dlFile.arrayBuffer());
        const path = `${user.id}/dl.${ext}`;
        const { error } = await sb.storage.from("kyc").upload(path, buf, { contentType: dlFile.type, upsert: true });
        if (error) throw error;
        updates.dl_url     = sb.storage.from("kyc").getPublicUrl(path).data.publicUrl;
        updates.kyc_status = "uploaded";
      }

      await sb.from("profiles").update(updates).eq("id", user.id);
      const { data: updated } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
      return json({ success: true, user: mapProfile(updated as Record<string, unknown>) });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
