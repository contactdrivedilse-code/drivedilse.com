require("dotenv").config();
const mongoose = require("mongoose");
const Car = require("./models/Car");

const cars = [
  {
    name: "Maruti Swift",
    category: "Hatchback",
    fuel: "Petrol",
    seats: 5,
    transmission: "Manual",
    pricePerDay: 1299,
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
    pricePerDay: 1199,
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
    pricePerDay: 1799,
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
    pricePerDay: 3999,
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
    pricePerDay: 3499,
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
    pricePerDay: 2799,
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
    pricePerDay: 2999,
    deposit: 8000,
    features: ["AC", "7 Seats", "Sunroof", "Music System", "ADAS"],
    image: "",
  },
];

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");
  await Car.deleteMany({});
  const inserted = await Car.insertMany(cars);
  console.log(`Seeded ${inserted.length} cars`);
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
