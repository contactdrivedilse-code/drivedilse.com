import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);

  // Simple secret check so it can't be called publicly without auth
  const secret = req.headers.get("x-cleanup-secret");
  if (!secret || secret !== Deno.env.get("CLEANUP_SECRET"))
    return json({ error: "Unauthorized" }, 401);

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Find bookings completed more than 24 hours ago
    const { data: completed } = await sb
      .from("bookings")
      .select("id")
      .eq("status", "completed")
      .lt("updated_at", cutoff);

    if (!completed || completed.length === 0)
      return json({ success: true, deleted: 0, message: "No photos to clean up" });

    let deleted = 0;
    for (const b of completed) {
      const id = b.id as string;

      // List all files in the checkin bucket for this booking
      const { data: files } = await sb.storage.from("checkin").list(id);
      if (files && files.length > 0) {
        const paths = files.map((f) => `${id}/${f.name}`);
        const { error } = await sb.storage.from("checkin").remove(paths);
        if (!error) deleted += paths.length;
      }
    }

    return json({ success: true, deleted, bookings: completed.length });
  } catch (e) {
    console.error("[500]", (e as Error).message);
    return json({ error: "Internal server error" }, 500);
  }
});

