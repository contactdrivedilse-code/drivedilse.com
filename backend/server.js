require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();

const allowedOrigins = [
  process.env.FRONTEND_URL || "https://contactdrivedilse-code.github.io",
  "https://contactdrivedilse-code.github.io",
  "https://contact-drivedilse.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
];

app.use(cors({
  origin: function (origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("CORS: origin not allowed"));
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api/fleet",    require("./routes/fleet"));
app.use("/api/auth",     require("./routes/auth"));
app.use("/api/payment",  require("./routes/payment"));
app.use("/api/bookings", require("./routes/bookings"));
app.use("/api/admin",    require("./routes/admin"));

app.get("/", (req, res) => res.json({ status: "DriveDilSe API running", ts: Date.now() }));
app.get("/health", (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("MongoDB connected");
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
