const router  = require("express").Router();
const Car     = require("../models/Car");
const { protect } = require("../middleware/auth");

// GET /api/fleet — all active cars
router.get("/", async (req, res) => {
  try {
    const cars = await Car.find({ active: true }).select("-pauses");
    res.json(cars);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fleet/available?pickup=ISO&drop=ISO
router.get("/available", async (req, res) => {
  try {
    const { pickup, drop } = req.query;
    if (!pickup || !drop) return res.status(400).json({ error: "pickup and drop required" });
    const cars = await Car.find({ active: true });
    const available = cars.filter(c => c.isAvailable(pickup, drop));
    res.json(available.map(c => ({ ...c.toObject(), pauses: undefined })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fleet/:id
router.get("/:id", async (req, res) => {
  try {
    const car = await Car.findById(req.params.id);
    if (!car) return res.status(404).json({ error: "Car not found" });
    res.json(car);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
