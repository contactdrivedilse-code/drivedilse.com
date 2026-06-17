import { createClient } from "npm:@supabase/supabase-js@2";
import { json, preflight } from "../_shared/cors.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function mapCar(c: Record<string, unknown>) {
  return {
    _id: c.id, id: c.id, name: c.name, category: c.category,
    fuel: c.fuel, seats: c.seats, transmission: c.transmission,
    pricePerDay: c.price_per_day, deposit: c.deposit,
    features: c.features ?? [], image: c.image_url ?? "", images: c.images ?? [],
    active: c.active, createdAt: c.created_at,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const url  = new URL(req.url);
  const path = url.pathname.replace("/fleet", "") || "/";

  try {
    // GET /available?pickup=&drop=
    if (req.method === "GET" && path.startsWith("/available")) {
      const pickup = url.searchParams.get("pickup");
      const drop   = url.searchParams.get("drop");
      if (!pickup || !drop) return json({ error: "pickup and drop required" }, 400);

      const pISO = new Date(pickup).toISOString();
      const dISO = new Date(drop).toISOString();

      const [{ data: cars }, { data: pauses }, { data: booked }] = await Promise.all([
        sb.from("cars").select("*").eq("active", true),
        sb.from("car_pauses").select("car_id").lt("from_date", dISO).gt("to_date", pISO),
        sb.from("bookings").select("car_id").in("status", ["confirmed", "active"])
          .lt("pickup_date", dISO).gt("drop_date", pISO),
      ]);

      const blocked = new Set([
        ...(pauses ?? []).map((p: Record<string, string>) => p.car_id),
        ...(booked  ?? []).map((b: Record<string, string>) => b.car_id),
      ]);

      return json((cars ?? []).filter((c: Record<string, unknown>) => !blocked.has(c.id as string)).map(mapCar));
    }

    // GET /coupons — active offers for guests
    if (req.method === "GET" && path === "/coupons") {
      const { data, error } = await sb.from("coupons").select("*").eq("active", true).order("created_at", { ascending: false });
      if (error) throw error;
      return json((data ?? []).map((c: Record<string, unknown>) => ({
        code: c.code, title: c.title, description: c.description ?? "",
        type: c.type, value: c.value, minAmount: c.min_amount ?? 0,
      })));
    }

    // GET / — all active cars
    if (req.method === "GET" && (path === "/" || path === "")) {
      const { data, error } = await sb.from("cars").select("*").eq("active", true);
      if (error) throw error;
      return json((data ?? []).map(mapCar));
    }

    // GET /:id
    const idMatch = path.match(/^\/([^/]+)$/);
    if (req.method === "GET" && idMatch) {
      const { data, error } = await sb.from("cars").select("*").eq("id", idMatch[1]).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Car not found" }, 404);
      return json(mapCar(data as Record<string, unknown>));
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
