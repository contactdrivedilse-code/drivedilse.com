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
    coverPhoto: c.cover_photo ?? "", exteriorPhotos: c.exterior_photos ?? [], interiorPhotos: c.interior_photos ?? [],
    active: c.active, createdAt: c.created_at,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight(req);

  const url  = new URL(req.url);
  const path = url.pathname.replace("/fleet", "") || "/";

  try {
    // GET /available?pickup=&drop=&session=
    if (req.method === "GET" && path.startsWith("/available")) {
      const pickup  = url.searchParams.get("pickup");
      const drop    = url.searchParams.get("drop");
      const session = url.searchParams.get("session") || "";
      if (!pickup || !drop) return json({ error: "pickup and drop required" }, 400);

      const pISO   = new Date(pickup).toISOString();
      const dISO   = new Date(drop).toISOString();
      const nowISO = new Date().toISOString();

      // Build hold query â€” exclude the requesting customer's own hold so they
      // aren't blocked by their own reservation.
      let holdsQ = sb.from("car_holds").select("car_id")
        .lt("pickup_date", dISO).gt("drop_date", pISO).gt("expires_at", nowISO);
      if (session) holdsQ = holdsQ.neq("session_id", session);

      const [{ data: cars }, { data: pauses }, { data: booked }, { data: held }] = await Promise.all([
        sb.from("cars").select("*").eq("active", true),
        sb.from("car_pauses").select("car_id").lt("from_date", dISO).gt("to_date", pISO),
        sb.from("bookings").select("car_id")
          .in("status", ["confirmed", "active", "pending_kyc", "pending"])
          .lt("pickup_date", dISO).gt("drop_date", pISO),
        holdsQ,
      ]);

      const blocked = new Set([
        ...(pauses ?? []).map((p: Record<string, string>) => p.car_id),
        ...(booked  ?? []).map((b: Record<string, string>) => b.car_id),
        ...(held    ?? []).map((h: Record<string, string>) => h.car_id),
      ]);

      return json((cars ?? []).filter((c: Record<string, unknown>) => !blocked.has(c.id as string)).map(mapCar));
    }

    // GET /holds?pickup=&drop=&session= â€” returns active holds by OTHER sessions
    // so the fleet page can show "On Hold â€” check back in X min" on car cards.
    if (req.method === "GET" && path === "/holds") {
      const pickup  = url.searchParams.get("pickup");
      const drop    = url.searchParams.get("drop");
      const session = url.searchParams.get("session") || "";
      if (!pickup || !drop) return json([]);

      const pISO   = new Date(pickup).toISOString();
      const dISO   = new Date(drop).toISOString();
      const nowISO = new Date().toISOString();

      let q = sb.from("car_holds").select("car_id, expires_at")
        .lt("pickup_date", dISO).gt("drop_date", pISO).gt("expires_at", nowISO);
      if (session) q = q.neq("session_id", session);

      const { data } = await q;
      const now = Date.now();
      return json((data ?? []).map((h: Record<string, unknown>) => ({
        carId: h.car_id,
        minutesLeft: Math.max(1, Math.ceil((new Date(h.expires_at as string).getTime() - now) / 60000)),
      })));
    }

    // GET /:id/next-available?from=ISO â€” when a car is booked/paused over the
    // requested dates, tells the customer the earliest moment it's free again.
    const nextAvailMatch = path.match(/^\/([^/]+)\/next-available$/);
    if (req.method === "GET" && nextAvailMatch) {
      const fromParam = url.searchParams.get("from");
      const from = fromParam ? new Date(fromParam) : new Date();
      const fromISO = from.toISOString();

      const [{ data: pauses }, { data: booked }] = await Promise.all([
        sb.from("car_pauses").select("from_date, to_date").eq("car_id", nextAvailMatch[1]).gt("to_date", fromISO),
        sb.from("bookings").select("pickup_date, drop_date").eq("car_id", nextAvailMatch[1])
          .in("status", ["confirmed", "active"]).gt("drop_date", fromISO),
      ]);

      const intervals = [
        ...(pauses ?? []).map((p: Record<string, string>) => ({ start: new Date(p.from_date), end: new Date(p.to_date) })),
        ...(booked ?? []).map((b: Record<string, string>) => ({ start: new Date(b.pickup_date), end: new Date(b.drop_date) })),
      ].sort((a, b) => a.start.getTime() - b.start.getTime());

      // Walk forward from `from`, extending past any interval that covers
      // the current candidate moment, until we land in a free gap.
      let candidate = from;
      let movedForward = true;
      while (movedForward) {
        movedForward = false;
        for (const iv of intervals) {
          if (iv.start <= candidate && iv.end > candidate) {
            candidate = iv.end;
            movedForward = true;
          }
        }
      }

      const isFree = candidate.getTime() === from.getTime();
      return json({ nextAvailable: isFree ? null : candidate.toISOString() });
    }

    // GET /coupons â€” active, publicly-visible offers for guests. Exclusive/
    // one-time codes (is_public = false) are intentionally left out here â€”
    // they only work if the customer types the exact code in at checkout.
    if (req.method === "GET" && path === "/coupons") {
      const { data, error } = await sb.from("coupons").select("*").eq("active", true).eq("is_public", true).order("created_at", { ascending: false });
      if (error) throw error;
      return json((data ?? []).map((c: Record<string, unknown>) => ({
        code: c.code, title: c.title, description: c.description ?? "",
        type: c.type, value: c.value, minAmount: c.min_amount ?? 0,
        newCustomerOnly: c.new_customer_only ?? false,
      })));
    }

    // GET / â€” all active cars
    if (req.method === "GET" && (path === "/" || path === "")) {
      const { data, error } = await sb.from("cars").select("*").eq("active", true);
      if (error) throw error;
      return json((data ?? []).map(mapCar));
    }

    // GET /reviews/latest?limit=12 â€” latest customer reviews across all cars,
    // shown automatically in the homepage reviews marquee
    if (req.method === "GET" && path === "/reviews/latest") {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 12));
      const { data, error } = await sb.from("car_reviews")
        .select("customer_name, rating, review_text, created_at, car_id, cars(name)")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return json((data ?? []).map((r: Record<string, unknown>) => ({
        customerName: r.customer_name, rating: r.rating, reviewText: r.review_text,
        carName: (r.cars as Record<string, unknown> | null)?.name ?? "",
        createdAt: r.created_at,
      })));
    }

    // GET /:carId/reviews?limit=5 â€” reviews + average rating for one car,
    // shown automatically on that car's detail page
    const carReviewsMatch = path.match(/^\/([^/]+)\/reviews$/);
    if (req.method === "GET" && carReviewsMatch) {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 5));
      const { data, error } = await sb.from("car_reviews")
        .select("customer_name, rating, review_text, created_at")
        .eq("car_id", carReviewsMatch[1])
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      const reviews = data ?? [];
      const avg = reviews.length ? reviews.reduce((s: number, r: Record<string, unknown>) => s + (r.rating as number), 0) / reviews.length : 0;
      return json({
        average: Math.round(avg * 10) / 10,
        count: reviews.length,
        reviews: reviews.map((r: Record<string, unknown>) => ({
          customerName: r.customer_name, rating: r.rating, reviewText: r.review_text, createdAt: r.created_at,
        })),
      });
    }

    // GET /car-docs/:carId — public endpoint, returns signed doc URLs + expiry dates
    // Used by the public car-docs.html page (no auth required).
    const carDocsMatch = path.match(/^\/car-docs\/([^/]+)$/);
    if (req.method === "GET" && carDocsMatch) {
      const carId = carDocsMatch[1];
      const { data, error } = await sb.from("cars")
        .select("id, name, rc_expiry, insurance_expiry, puc_expiry, fitness_expiry, rc_doc_url, insurance_doc_url, puc_doc_url, fitness_doc_url")
        .eq("id", carId).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Car not found" }, 404);
      const c = data as Record<string, unknown>;

      // Sign each doc URL (1-hour expiry) so docs are viewable without making
      // the car-docs bucket public. Non-uploaded docs return "".
      async function signDoc(url: unknown): Promise<string> {
        if (!url || typeof url !== "string") return "";
        // Accept either a bare storage path ("carId/rc.pdf") or a legacy full public URL.
        const fullUrlMatch = url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
        let bucket: string, path: string;
        if (fullUrlMatch) {
          bucket = fullUrlMatch[1];
          path   = decodeURIComponent(fullUrlMatch[2].split("?")[0]);
        } else {
          bucket = "car-docs";
          path   = decodeURIComponent(url.split("?")[0]);
        }
        // 15-minute signed URL — short enough to limit damage if intercepted.
        const { data: sd } = await sb.storage.from(bucket).createSignedUrl(path, 15 * 60);
        return sd?.signedUrl ?? "";
      }

      const [rcUrl, insUrl, pucUrl, fitUrl] = await Promise.all([
        signDoc(c.rc_doc_url), signDoc(c.insurance_doc_url),
        signDoc(c.puc_doc_url), signDoc(c.fitness_doc_url),
      ]);

      return json({
        carId: c.id, carName: c.name,
        docs: [
          { type: "rc",        label: "Registration Certificate (RC)", expiry: c.rc_expiry,        url: rcUrl  },
          { type: "insurance", label: "Insurance",                      expiry: c.insurance_expiry, url: insUrl },
          { type: "puc",       label: "PUC Certificate",                expiry: c.puc_expiry,       url: pucUrl },
          { type: "fitness",   label: "Fitness Certificate",            expiry: c.fitness_expiry,   url: fitUrl },
        ],
        generatedAt: new Date().toISOString(),
      });
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
    console.error("[500]", (e as Error).message);
    return json({ error: "Internal server error" }, 500);
  }
});

