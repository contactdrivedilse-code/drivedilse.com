require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const https  = require("https");

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SCHEMA_SQL = `
create extension if not exists "pgcrypto";

create table if not exists profiles (
  id text primary key,
  phone text unique not null,
  name text default '',
  dob text default '',
  email text default '',
  aadhaar_url text default '',
  dl_url text default '',
  aadhaar_uploaded boolean default false,
  dl_verified boolean default false,
  kyc_status text default 'pending',
  otp text default '',
  otp_expiry timestamptz,
  phone_verified boolean default false,
  created_at timestamptz default now()
);

create table if not exists cars (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  category text not null,
  fuel text default 'Petrol',
  seats int default 5,
  transmission text default 'Manual',
  price_per_day int not null,
  deposit int default 0,
  features text[] default '{}',
  image text default '',
  active boolean default true,
  created_at timestamptz default now()
);

create table if not exists car_pauses (
  id text primary key default gen_random_uuid()::text,
  car_id text references cars(id) on delete cascade,
  from_date timestamptz not null,
  to_date timestamptz not null,
  note text default ''
);

create table if not exists bookings (
  id text primary key default gen_random_uuid()::text,
  booking_id text unique not null,
  car_id text references cars(id),
  car_name text default '',
  user_id text references profiles(id),
  customer text default '',
  phone text default '',
  pickup_date timestamptz not null,
  pickup_location text default 'Pune',
  drop_date timestamptz not null,
  drop_location text default 'Pune',
  days int not null,
  price_per_day int not null,
  total int not null,
  deposit int default 0,
  discount int default 0,
  razorpay_order_id text default '',
  razorpay_payment_id text default '',
  razorpay_signature text default '',
  payment_status text default 'pending',
  paid_at timestamptz,
  checkin_front text default '',
  checkin_rear text default '',
  checkin_passenger_side text default '',
  checkin_driver_side text default '',
  checkin_photos_at timestamptz,
  checkin_otp text default '',
  checkin_otp_verified boolean default false,
  checked_in_at timestamptz,
  checkout_otp text default '',
  checkout_otp_verified boolean default false,
  checked_out_at timestamptz,
  status text default 'pending',
  cancelled_at timestamptz,
  notes text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists extensions (
  id text primary key default gen_random_uuid()::text,
  booking_id text references bookings(id) on delete cascade,
  hours int,
  cost int,
  razorpay_order_id text default '',
  razorpay_payment_id text default '',
  razorpay_signature text default '',
  extended_at timestamptz default now()
);

alter table profiles disable row level security;
alter table cars disable row level security;
alter table car_pauses disable row level security;
alter table bookings disable row level security;
alter table extensions disable row level security;
`;

const CARS = [
  { name:"Maruti Swift",       category:"Hatchback", fuel:"Petrol", seats:5, transmission:"Manual",    price_per_day:1299, deposit:5000,  features:["AC","Music System","Power Steering","Power Windows"] },
  { name:"Hyundai Grand i10",  category:"Hatchback", fuel:"Petrol", seats:5, transmission:"Manual",    price_per_day:1199, deposit:5000,  features:["AC","Music System","Power Steering"] },
  { name:"Honda City",         category:"Sedan",     fuel:"Petrol", seats:5, transmission:"Manual",    price_per_day:1799, deposit:7000,  features:["AC","Music System","Power Steering","Reverse Camera"] },
  { name:"Mahindra Thar",      category:"SUV",       fuel:"Diesel", seats:4, transmission:"Manual",    price_per_day:3999, deposit:10000, features:["4WD","AC","Music System","Sunroof"] },
  { name:"Toyota Innova Crysta",category:"MPV",      fuel:"Diesel", seats:7, transmission:"Manual",    price_per_day:3499, deposit:10000, features:["AC","7 Seats","Music System","Power Windows"] },
  { name:"Hyundai Creta",      category:"SUV",       fuel:"Petrol", seats:5, transmission:"Automatic", price_per_day:2799, deposit:8000,  features:["AC","Sunroof","Music System","Reverse Camera","Cruise Control"] },
  { name:"Kia Carens",         category:"MPV",       fuel:"Petrol", seats:7, transmission:"Automatic", price_per_day:2999, deposit:8000,  features:["AC","7 Seats","Sunroof","Music System","ADAS"] },
];

function runSql(sql) {
  return new Promise((resolve, reject) => {
    const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/)[1];
    const body = JSON.stringify({ query: sql });
    const req = https.request({
      hostname: "api.supabase.com",
      path: `/v1/projects/${projectRef}/database/query`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function createBucket(name) {
  const { data, error } = await sb.storage.createBucket(name, { public: true });
  if (error && !error.message.includes("already exists")) throw error;
  console.log(`  Bucket "${name}": ${error ? "already exists" : "created"}`);
}

async function seedCars() {
  const { data: existing } = await sb.from("cars").select("id").limit(1);
  if (existing && existing.length > 0) {
    console.log("  Cars: already seeded, skipping");
    return;
  }
  const rows = CARS.map(c => ({ ...c, id: crypto.randomUUID(), image: "", active: true }));
  const { error } = await sb.from("cars").insert(rows);
  if (error) throw error;
  console.log(`  Cars: seeded ${rows.length} cars`);
}

async function main() {
  console.log("\nDriveDilSe — Supabase Setup\n");

  console.log("1/3  Running SQL schema...");
  const result = await runSql(SCHEMA_SQL);
  if (result.status === 200 || result.status === 201) {
    console.log("     Schema created successfully");
  } else {
    // Management API returned 401 — service role key not accepted there, need PAT
    // Fall back: try inserting into cars to see if tables already exist
    const { error: testErr } = await sb.from("cars").select("id").limit(1);
    if (testErr && testErr.message.includes("does not exist")) {
      console.log("\n  MANUAL STEP REQUIRED:");
      console.log("  The Supabase Management API needs a Personal Access Token to run SQL.");
      console.log("  Please do this ONE time (30 seconds):");
      console.log("  1. In your Supabase dashboard, click 'SQL Editor' in the left sidebar");
      console.log("  2. Click 'New query'");
      console.log("  3. Paste the entire contents of backend/supabase-schema.sql");
      console.log("  4. Click 'Run'");
      console.log("  5. Then run this script again: node setup.js\n");
      process.exit(1);
    } else {
      console.log("     Tables already exist, continuing...");
    }
  }

  console.log("2/3  Creating storage buckets...");
  await createBucket("kyc");
  await createBucket("checkin");

  console.log("3/3  Seeding car fleet...");
  await seedCars();

  console.log("\nSetup complete! Your Supabase database is ready.\n");
  console.log("Next step: Deploy to Railway");
  console.log("  1. Push this folder to GitHub");
  console.log("  2. Go to railway.app, connect the repo");
  console.log("  3. Add the .env variables in Railway dashboard\n");
}

main().catch(e => { console.error("Setup failed:", e.message); process.exit(1); });
