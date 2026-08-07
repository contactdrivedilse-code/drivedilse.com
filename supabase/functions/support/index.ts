import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";
import { sendEmail, SUPPORT_INBOX, escapeHtml } from "../_shared/email.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);

  const url  = new URL(req.url);
  const path = url.pathname.replace("/support", "") || "/";

  try {
    // POST /tickets â€” raise a support ticket from the chat widget (no auth required)
    if (req.method === "POST" && path === "/tickets") {
      const { name, phone, email, message } = await req.json();
      if (!name || !String(name).trim()) return json({ error: "Name is required" }, 400);
      if (String(name).length > 100) return json({ error: "Name is too long" }, 400);
      if (!phone || !/^[6-9]\d{9}$/.test(phone)) return json({ error: "Valid 10-digit phone number is required" }, 400);
      if (!message || !String(message).trim()) return json({ error: "Message is required" }, 400);
      if (String(message).length > 2000) return json({ error: "Message is too long (max 2000 characters)" }, 400);
      if (email && String(email).length > 200) return json({ error: "Email is too long" }, 400);

      const { data, error } = await sb.from("support_tickets").insert({
        name: String(name).trim(),
        phone: String(phone).trim(),
        email: email ? String(email).trim() : null,
        message: String(message).trim(),
      }).select().single();
      if (error) throw error;

      await sendEmail(
        SUPPORT_INBOX,
        `New support ticket from ${data.name}`,
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#161616">New Support Ticket</h2>
          <p><strong>Name:</strong> ${escapeHtml(data.name)}<br/><strong>Phone:</strong> ${escapeHtml(data.phone)}<br/><strong>Email:</strong> ${escapeHtml(data.email) || "â€”"}</p>
          <p style="background:#f6f6f6;border-radius:8px;padding:12px">${escapeHtml(data.message)}</p>
          <p style="color:#666;font-size:13px">Ticket ID: ${data.id}</p>
        </div>`,
      ).catch((e) => console.error("Admin notify email failed:", e));

      if (data.email) {
        await sendEmail(
          data.email,
          "We've received your support ticket â€” DriveDilSe",
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#161616">DriveDilSe</h2>
            <p>Hi ${escapeHtml(data.name)}, thanks for reaching out!</p>
            <p>We've raised your ticket and our team will get back to you shortly.</p>
            <p style="background:#f6f6f6;border-radius:8px;padding:12px"><strong>Your message:</strong><br/>${escapeHtml(data.message)}</p>
            <p style="color:#666;font-size:13px">Ticket ID: ${data.id}</p>
          </div>`,
        ).catch((e) => console.error("Customer confirm email failed:", e));
      }

      return json({ success: true, ticketId: data.id });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

