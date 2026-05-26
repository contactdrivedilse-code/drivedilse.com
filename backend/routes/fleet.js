const router = require("express").Router();
const sb     = require("../db");

function mapCar(c) {
  return {
    _id:          c.id,
    id:           c.id,
    name:         c.name,
    category:     c.category,
    fuel:         c.fuel,
    seats:        c.seats,
    transmission: c.transmission,
    pricePerDay:  c.price_per_day,
    deposit:      c.deposit,
    features:     c.features || [],
    image:        c.image || "",
    active:       c.active,
    createdAt:    c.created_at,
  };
}

// GET /api/fleet
router.get("/", async (req, res) => {
  try {
    const { data, error } = await sb.from("cars").select("*").eq("active", true);
    if (error) throw error;
    res.json(data.map(mapCar));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fleet/available?pickup=ISO&drop=ISO
router.get("/available", async (req, res) => {
  try {
    const { pickup, drop } = req.query;
    if (!pickup || !drop) return res.status(400).json({ error: "pickup and drop required" });

    const pickupISO = new Date(pickup).toISOString();
    const dropISO   = new Date(drop).toISOString();

    const [{ data: cars }, { data: pauses }, { data: booked }] = await Promise.all([
      sb.from("cars").select("*").eq("active", true),
      sb.from("car_pauses").select("car_id").lt("from_date", dropISO).gt("to_date", pickupISO),
      sb.from("bookings").select("car_id").in("status", ["confirmed", "active"])
        .lt("pickup_date", dropISO).gt("drop_date", pickupISO),
    ]);

    const blocked = new Set([
      ...(pauses || []).map(p => p.car_id),
      ...(booked  || []).map(b => b.car_id),
    ]);

    res.json((cars || []).filter(c => !blocked.has(c.id)).map(mapCar));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fleet/:id
router.get("/:id", async (req, res) => {
  try {
    const { data, error } = await sb.from("cars").select("*").eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Car not found" });
    res.json(mapCar(data));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
