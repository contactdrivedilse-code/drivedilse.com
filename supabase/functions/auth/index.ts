import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { signJwt, verifyJwt, getBearer, getUserToken } from "../_shared/jwt.ts";
import { signStorageUrl } from "../_shared/storage.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Replace stored public KYC URLs with short-lived signed URLs so private
// buckets remain viewable by the owning customer.
async function signProfileKyc(p: Record<string, unknown>): Promise<Record<string, unknown>> {
  const [aadhaarUrl, dlUrl, profilePhotoUrl] = await Promise.all([
    signStorageUrl(sb, p.kyc && (p.kyc as Record<string, unknown>).aadhaarUrl as string),
    signStorageUrl(sb, p.kyc && (p.kyc as Record<string, unknown>).dlUrl as string),
    signStorageUrl(sb, p.profilePhotoUrl as string),
  ]);
  return {
    ...p,
    profilePhotoUrl,
    kyc: { ...(p.kyc as Record<string, unknown>), aadhaarUrl, dlUrl },
  };
}

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendEmailOtp(email: string, otp: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) { console.log(`[OTP] ${email} → ${otp}`); return; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "DriveDilSe <info@drivedilse.com>",
      to: [email],
      subject: `${otp} is your DriveDilSe verification code`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#161616">DriveDilSe</h2>
        <p>Your verification code is:</p>
        <p style="font-size:28px;font-weight:800;letter-spacing:4px">${otp}</p>
        <p style="color:#666;font-size:13px">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </div>`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to send OTP email (${res.status}): ${body}`);
  }
}

function mapProfile(u: Record<string, unknown>) {
  return {
    _id: u.id, id: u.id, phone: u.phone,
    name: u.name ?? "", dob: u.dob ?? "", email: u.email ?? "",
    phoneVerified: u.phone_verified ?? false,
    emailVerified: u.phone_verified ?? false,
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
    return payload as { id: string; phone: string; email?: string };
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const url  = new URL(req.url);
  const path = url.pathname.replace("/auth", "") || "/";

  try {
    // POST /send-otp — OTP is always emailed, never texted. `phone` is kept
    // only as the contact field on the profile; `email` is the verification channel.
    if (req.method === "POST" && path === "/send-otp") {
      const { phone, email } = await req.json();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return json({ error: "Invalid email address" }, 400);
      if (phone && !/^[6-9]\d{9}$/.test(phone))
        return json({ error: "Invalid Indian mobile number" }, 400);

      const otp       = generateOtp();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const emailLc   = String(email).trim().toLowerCase();

      // Look up by email first (the identity key for OTP); fall back to phone
      // so an existing phone-only profile (e.g. from a guest booking) gets merged.
      let { data: existing } = await sb.from("profiles").select("id").eq("email", emailLc).maybeSingle();
      if (!existing && phone) {
        const byPhone = await sb.from("profiles").select("id").eq("phone", phone).maybeSingle();
        existing = byPhone.data;
      }

      if (existing) {
        const updates: Record<string, unknown> = { otp, otp_expiry: otpExpiry, email: emailLc };
        if (phone) updates.phone = phone;
        await sb.from("profiles").update(updates).eq("id", (existing as Record<string, string>).id);
      } else {
        await sb.from("profiles").insert({ id: crypto.randomUUID(), phone: phone || null, email: emailLc, otp, otp_expiry: otpExpiry });
      }

      await sendEmailOtp(emailLc, otp);
      return json({ success: true, message: "OTP sent" });
    }

    // POST /verify-otp
    if (req.method === "POST" && path === "/verify-otp") {
      const { phone, otp, name, email } = await req.json();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return json({ error: "Invalid email address" }, 400);
      const emailLc = String(email).trim().toLowerCase();

      const { data: user } = await sb.from("profiles").select("*").eq("email", emailLc).maybeSingle();
      const u = user as Record<string, unknown> | null;
      // Test-OTP bypass is OFF unless explicitly enabled. Previously it
      // defaulted to "1234" for ANY identity, allowing account takeover.
      const testOtp = Deno.env.get("TEST_OTP");
      const isTestOtp = Deno.env.get("ALLOW_TEST_OTP") === "true" && !!testOtp && otp === testOtp;
      if (!u) {
        // Auto-create profile for test OTP
        if (!isTestOtp) return json({ error: "Invalid or expired OTP" }, 400);
        const id = crypto.randomUUID();
        await sb.from("profiles").insert({ id, phone: phone || null, email: emailLc, name: name ?? "", phone_verified: true });
        const JWT_SECRET = Deno.env.get("JWT_SECRET")!;
        const token = await signJwt({ id, phone: phone ?? "", email: emailLc }, JWT_SECRET, 30 * 24 * 60 * 60);
        return json({ token, user: { _id: id, id, phone: phone ?? "", email: emailLc, name: name ?? "", phoneVerified: true, emailVerified: true, kyc: { status: "pending" } } });
      }
      if (!isTestOtp && (u.otp !== otp || !u.otp_expiry || new Date(u.otp_expiry as string) < new Date()))
        return json({ error: "Invalid or expired OTP" }, 400);

      const updates: Record<string, unknown> = { otp: "", otp_expiry: null, phone_verified: true };
      if (name && !u.name) updates.name = name;
      if (phone && !u.phone) updates.phone = phone;
      await sb.from("profiles").update(updates).eq("id", u.id);

      const JWT_SECRET = Deno.env.get("JWT_SECRET")!;
      const finalPhone = (updates.phone as string) ?? (u.phone as string) ?? "";
      const token = await signJwt({ id: u.id, phone: finalPhone, email: emailLc }, JWT_SECRET, 30 * 24 * 60 * 60);
      return json({ token, user: await signProfileKyc(mapProfile({ ...u, ...updates })) });
    }

    // GET /profile
    if (req.method === "GET" && path === "/profile") {
      const user = await getUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "User not found" }, 404);
      return json(await signProfileKyc(mapProfile(data as Record<string, unknown>)));
    }

    // POST /profile — KYC with file uploads
    if (req.method === "POST" && path === "/profile") {
      // Try JWT auth first; fallback to phone from form data
      let profileId: string | null = null;
      const jwtUser = await getUser(req);
      if (jwtUser) {
        profileId = jwtUser.id;
      } else {
        // Clone request body to read form data for phone lookup
        const tempForm = await req.clone().formData().catch(() => null);
        const phone = tempForm?.get("phone") as string | null;
        if (phone) {
          const { data: byPhone } = await sb.from("profiles").select("id").eq("phone", phone).maybeSingle();
          if (byPhone) profileId = (byPhone as Record<string, string>).id;
        }
      }
      if (!profileId) return json({ error: "Unauthorized" }, 401);

      const { data: existing } = await sb.from("profiles").select("*").eq("id", profileId).maybeSingle();
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
        const path = `${profileId}/aadhaar.${ext}`;
        const { error } = await sb.storage.from("kyc").upload(path, buf, { contentType: aadhaarFile.type, upsert: true });
        if (error) throw error;
        updates.aadhaar_url      = sb.storage.from("kyc").getPublicUrl(path).data.publicUrl;
        updates.aadhaar_uploaded = true;
        updates.kyc_status       = "uploaded";
      }

      const photoFile = formData.get("profile_photo") as File | null;
      if (photoFile) {
        const buf   = new Uint8Array(await photoFile.arrayBuffer());
        const ppath = `${profileId}/profile.jpg`;
        const { error: perr } = await sb.storage.from("kyc").upload(ppath, buf, { contentType: "image/jpeg", upsert: true });
        if (!perr) updates.profile_photo_url = sb.storage.from("kyc").getPublicUrl(ppath).data.publicUrl;
      }

      const dlFile = formData.get("dl") as File | null;
      if (dlFile) {
        const ext  = dlFile.type.includes("pdf") ? "pdf" : "jpg";
        const buf  = new Uint8Array(await dlFile.arrayBuffer());
        const path = `${profileId}/dl.${ext}`;
        const { error } = await sb.storage.from("kyc").upload(path, buf, { contentType: dlFile.type, upsert: true });
        if (error) throw error;
        updates.dl_url     = sb.storage.from("kyc").getPublicUrl(path).data.publicUrl;
        updates.kyc_status = "uploaded";
      }

      await sb.from("profiles").update(updates).eq("id", profileId);
      const { data: updated } = await sb.from("profiles").select("*").eq("id", profileId).maybeSingle();
      // Issue fresh token so frontend session is renewed
      const freshToken = jwtUser ? null : await signJwt({ id: profileId, phone: (existing as Record<string,unknown>).phone }, Deno.env.get("JWT_SECRET")!, 30 * 24 * 60 * 60);
      return json({ success: true, user: await signProfileKyc(mapProfile(updated as Record<string, unknown>)), ...(freshToken ? { token: freshToken } : {}) });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
