import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const url  = new URL(req.url);
  const path = url.pathname.replace("/support", "") || "/";

  try {
    // POST /tickets — raise a support ticket from the chat widget (no auth required)
    if (req.method === "POST" && path === "/tickets") {
      const { name, phone, email, message } = await req.json();
      if (!name || !String(name).trim()) return json({ error: "Name is required" }, 400);
      if (!phone || !/^[6-9]\d{9}$/.test(phone)) return json({ error: "Valid 10-digit phone number is required" }, 400);
      if (!message || !String(message).trim()) return json({ error: "Message is required" }, 400);

      const { data, error } = await sb.from("support_tickets").insert({
        name: String(name).trim(),
        phone: String(phone).trim(),
        email: email ? String(email).trim() : null,
        message: String(message).trim(),
      }).select().single();
      if (error) throw error;

      return json({ success: true, ticketId: data.id });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
