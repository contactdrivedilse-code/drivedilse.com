const router  = require("express").Router();
const Booking = require("../models/Booking");
const { protect } = require("../middleware/auth");

// GET /api/bookings — user's own bookings
router.get("/", protect, async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.user.id })
      .populate("car", "name category image")
      .sort({ createdAt: -1 });
    res.json(bookings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
