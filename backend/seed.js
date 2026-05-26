require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const cars = [
  {
    name: "Maruti Swift",
    category: "Hatchback",
    fuel: "Petrol",
    seats: 5,
    transmission: "Manual",
    price_per_day: 1299,
    deposit: 5000,
    features: ["AC", "Music System", "Power Steering", "Power Windows"],
    image: "",
  },
  {
    name: "Hyundai Grand i10",
    category: "Hatchback",
    fuel: "Petrol",
    seats: 5,
    transmission: "Manual",
    price_per_day: 1199,
    deposit: 5000,
    features: ["AC", "Music System", "Power Steering"],
    image: "",
  },
  {
    name: "Honda City",
    category: "Sedan",
    fuel: "Petrol",
    seats: 5,
    transmission: "Manual",
    price_per_day: 1799,
    deposit: 7000,
    features: ["AC", "Music System", "Power Steering", "Reverse Camera"],
    image: "",
  },
  {
    name: "Mahindra Thar",
    category: "SUV",
    fuel: "Diesel",
    seats: 4,
    transmission: "Manual",
    price_per_day: 3999,
    deposit: 10000,
    features: ["4WD", "AC", "Music System", "Sunroof"],
    image: "",
  },
  {
    name: "Toyota Innova Crysta",
    category: "MPV",
    fuel: "Diesel",
    seats: 7,
    transmission: "Manual",
    price_per_day: 3499,
    deposit: 10000,
    features: ["AC", "7 Seats", "Music System", "Power Windows"],
    image: "",
  },
  {
    name: "Hyundai Creta",
    category: "SUV",
    fuel: "Petrol",
    seats: 5,
    transmission: "Automatic",
    price_per_day: 2799,
    deposit: 8000,
    features: ["AC", "Sunroof", "Music System", "Reverse Camera", "Cruise Control"],
    image: "",
  },
  {
    name: "Kia Carens",
    category: "MPV",
    fuel: "Petrol",
    seats: 7,
    transmission: "Automatic",
    price_per_day: 2999,
    deposit: 8000,
    features: ["AC", "7 Seats", "Sunroof", "Music System", "ADAS"],
    image: "",
  },
];

async function seed() {
  console.log("Seeding cars into Supabase...");
  await sb.from("cars").delete().neq("id", "0"); // clear all

  const rows = cars.map(c => ({ ...c, id: crypto.randomUUID(), active: true }));
  const { error } = await sb.from("cars").insert(rows);
  if (error) throw error;
  console.log(`Seeded ${rows.length} cars successfully.`);
}

seed().catch(err => { console.error(err.message); process.exit(1); });
