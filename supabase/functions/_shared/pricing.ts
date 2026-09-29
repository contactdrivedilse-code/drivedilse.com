// Marginal bracket rates (₹/hr, excl GST) — must stay in sync with CAT_BRACKETS in index.html.
// Brackets: [0-12hr, 12-24hr, 24-168hr, 168hr+]
const CAT_BRACKETS: Record<string, number[]> = {
  compact: [ 96, 60, 39, 48],
  premium: [105, 65, 43, 54],
  MPV:     [130, 81, 45, 64],
  SUV:     [156, 97, 54, 73],
};
const HATCH_PPD_SPLIT = 1580;
const BRACKET_CUTS = [0, 12, 24, 168, Infinity];

function getCatBrackets(category: string, pricePerDay: number): number[] {
  const cat = (category || "").toLowerCase();
  if (cat === "mpv") return CAT_BRACKETS.MPV;
  if (cat === "compact suv" || cat === "suv") return CAT_BRACKETS.SUV;
  if (cat === "premium hatchback" || cat === "sedan") return CAT_BRACKETS.premium;
  if (cat === "compact hatchback") return CAT_BRACKETS.compact;
  return pricePerDay < HATCH_PPD_SPLIT ? CAT_BRACKETS.compact : CAT_BRACKETS.premium;
}

function getMarginalBase(rates: number[], fromHr: number, toHr: number): number {
  let cost = 0;
  for (let i = 0; i < rates.length; i++) {
    const s = Math.max(fromHr, BRACKET_CUTS[i]);
    const e = Math.min(toHr, BRACKET_CUTS[i + 1]);
    if (e > s) cost += (e - s) * rates[i];
  }
  return cost;
}

// Indian national / public holidays — update annually.
// Dates that are also weekends get the HIGHER of the two rates (holiday wins if >= weekend).
const HOLIDAYS = new Set([
  // 2026
  "2026-01-01","2026-01-14","2026-01-26",
  "2026-03-23","2026-03-30","2026-04-02","2026-04-03","2026-04-06","2026-04-14",
  "2026-05-01","2026-05-23",
  "2026-06-07","2026-07-27",
  "2026-08-15","2026-08-19",
  "2026-09-04","2026-09-18",
  "2026-10-02","2026-10-21",
  "2026-11-08","2026-11-26",
  "2026-12-25",
  // 2027
  "2027-01-01","2027-01-14","2027-01-26",
  "2027-03-12","2027-03-19","2027-03-31","2027-04-14","2027-04-26",
  "2027-05-01","2027-05-13",
  "2027-06-27",
  "2027-08-15","2027-08-28",
  "2027-09-24",
  "2027-10-02","2027-10-10","2027-10-28",
  "2027-11-18",
  "2027-12-25",
]);

function getDayType(dateStr: string): "holiday" | "weekend" | "weekday" {
  if (HOLIDAYS.has(dateStr)) return "holiday";
  const dow = new Date(dateStr + "T00:00:00Z").getUTCDay();
  if (dow === 0 || dow === 6) return "weekend";
  return "weekday";
}

function getDayMultiplier(type: "holiday" | "weekend" | "weekday"): number {
  if (type === "holiday") return 1.10;
  if (type === "weekend") return 1.20;
  return 1.0;
}

// Converts a UTC ms timestamp to an IST calendar date string "YYYY-MM-DD".
function toISTDate(ms: number): string {
  const ist = new Date(ms + 5.5 * 3600000);
  return ist.toISOString().slice(0, 10);
}

export function calcPrice(pricePerDay: number, pickup: Date, drop: Date, category = "") {
  const hours = (drop.getTime() - pickup.getTime()) / 3600000;
  if (hours <= 0) return { base: 0, gst: 0, total: 0, discount: 0, days: 0 };

  const rates = getCatBrackets(category, pricePerDay);
  let rawBase = 0, elapsed = 0, cur = pickup.getTime();
  while (cur < drop.getTime()) {
    const chunkEnd = Math.min(cur + 24 * 3600000, drop.getTime());
    const chunkHrs = (chunkEnd - cur) / 3600000;
    const mult     = getDayMultiplier(getDayType(toISTDate(cur)));
    rawBase += getMarginalBase(rates, elapsed, elapsed + chunkHrs) * mult;
    elapsed += chunkHrs;
    cur = chunkEnd;
  }
  const base  = Math.round(rawBase);
  const gst   = Math.round(base * 0.18);
  const total = base + gst;
  const days  = Math.max(1, Math.ceil(hours / 24));
  return { base, gst, total, discount: 0, days };
}
