// Competitor price scraper for DriveDilSe smart pricing.
//
// Run daily by .github/workflows/competitor-pricing.yml. Scrapes a fixed
// set of city/category searches on competitor self-drive rental sites,
// writes raw prices to `competitor_prices`, then derives per-category
// `pricing_suggestions` (admin approves/dismisses in the panel — this
// script never writes to `cars.price_per_day` directly).
//
// IMPORTANT: the competitor sites are JS-rendered SPAs. The CSS
// selectors in each adapter below are placeholders based on the site's
// robots.txt shape, not verified against the live DOM (this script was
// written without live browser access to those sites). Before enabling
// the scheduled run, run `node scrape.mjs --dry-run --site=<name>` and
// fix the selectors in that adapter until it prints real prices.
//
// robots.txt rules honored (checked 2026-07-12):
//   - zoomcar.com disallows `/search?` and other query-param paths ->
//     ZOOMCAR_ADAPTER must reach prices via UI navigation/clicks, never
//     by loading a disallowed URL directly.
//   - revv.co.in: no disallow rules found (Allow: /).
//   - myles.com: disallows only tracking/sort/filter query params and
//     `/search`; category/city landing pages are fine.
//   - 4th competitor: NOT YET CONFIGURED. The "selfspin.com" domain
//     given for this had an expired TLS cert at plan time, so its
//     robots.txt could not be checked -- confirm the real URL and
//     re-check robots.txt before adding it here.

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const DRY_RUN = process.argv.includes("--dry-run");
const SITE_FILTER = process.argv.find((a) => a.startsWith("--site="))?.split("=")[1];

const CITY = "Pune";
const CATEGORIES = ["Hatchback", "Sedan", "SUV", "MPV"];
const REQUEST_DELAY_MS = 4000; // be a polite, rate-limited scraper
const USER_AGENT = "DriveDilSePricingBot/1.0 (+https://drivedilse.com; contact.drivedilse@gmail.com)";
const SUGGESTION_THRESHOLD = 0.05; // only suggest if delta > 5%
const MAX_SUGGESTED_CHANGE = 0.15; // clamp suggestions to +/-15% of current price

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- per-competitor adapters -------------------------------------------
// Each adapter takes a Playwright page + category, returns an array of
// { price_per_day: number } for that category in CITY, or [] if it
// couldn't find anything (never throw on "no results" -- only on
// actual navigation/parse errors, so one broken site doesn't kill the run).

const adapters = {
  zoomcar: async (page, category) => {
    // Disallowed: any `/search?...` URL. Land on the homepage and drive
    // the city + category search through the UI instead.
    await page.goto("https://www.zoomcar.com/", { waitUntil: "domcontentloaded" });
    // PLACEHOLDER SELECTORS -- verify against the live site:
    // await page.fill('[data-testid="city-input"]', CITY);
    // await page.click(`[data-testid="category-filter-${category.toLowerCase()}"]`);
    // const cards = await page.$$('[data-testid="car-price"]');
    // return Promise.all(cards.map(async (c) => ({ price_per_day: parsePrice(await c.innerText()) })));
    return [];
  },

  revv: async (page, category) => {
    await page.goto(`https://www.revv.co.in/self-drive-cars/${CITY.toLowerCase()}`, {
      waitUntil: "domcontentloaded",
    });
    // PLACEHOLDER SELECTORS -- verify against the live site:
    // await page.click(`text=${category}`);
    // const cards = await page.$$(".car-card__price");
    // return Promise.all(cards.map(async (c) => ({ price_per_day: parsePrice(await c.innerText()) })));
    return [];
  },

  myles: async (page, category) => {
    await page.goto(`https://myles.com/self-drive-cars-${CITY.toLowerCase()}`, {
      waitUntil: "domcontentloaded",
    });
    // PLACEHOLDER SELECTORS -- verify against the live site:
    // await page.selectOption('[name="carType"]', category);
    // const cards = await page.$$(".vehicle-price");
    // return Promise.all(cards.map(async (c) => ({ price_per_day: parsePrice(await c.innerText()) })));
    return [];
  },

  // Add the 4th competitor here once its real URL + robots.txt are confirmed.
};

function parsePrice(text) {
  const digits = text.replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

async function scrapeCompetitor(browser, name, adapter) {
  const results = [];
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  for (const category of CATEGORIES) {
    try {
      const prices = await adapter(page, category);
      for (const p of prices) {
        if (p.price_per_day) {
          results.push({ competitor: name, category, city: CITY, price_per_day: p.price_per_day });
        }
      }
    } catch (err) {
      console.error(`[${name}] failed for category ${category}:`, err.message);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  await context.close();
  return results;
}

function computeSuggestions(competitorRows, cars) {
  const byCategory = new Map();
  for (const row of competitorRows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(row.price_per_day);
  }

  const carsByCategory = new Map();
  for (const car of cars) {
    if (!carsByCategory.has(car.category)) carsByCategory.set(car.category, []);
    carsByCategory.get(car.category).push(car);
  }

  const suggestions = [];
  for (const [category, prices] of byCategory) {
    if (prices.length === 0) continue;
    const competitorAvg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const carsInCategory = carsByCategory.get(category) || [];
    for (const car of carsInCategory) {
      const current = car.price_per_day;
      const delta = (competitorAvg - current) / current;
      if (Math.abs(delta) <= SUGGESTION_THRESHOLD) continue;
      const clampedDelta = Math.max(-MAX_SUGGESTED_CHANGE, Math.min(MAX_SUGGESTED_CHANGE, delta));
      const suggestedPrice = Math.round(current * (1 + clampedDelta));
      suggestions.push({
        category,
        current_price: current,
        competitor_avg: competitorAvg,
        suggested_price: suggestedPrice,
        status: "pending",
      });
    }
  }
  return suggestions;
}

async function main() {
  const targets = Object.entries(adapters).filter(([name]) => !SITE_FILTER || name === SITE_FILTER);
  const browser = await chromium.launch({ headless: true });
  let allRows = [];
  for (const [name, adapter] of targets) {
    console.log(`Scraping ${name}...`);
    const rows = await scrapeCompetitor(browser, name, adapter);
    console.log(`  -> ${rows.length} prices`);
    allRows = allRows.concat(rows);
  }
  await browser.close();

  if (DRY_RUN) {
    console.log("DRY RUN -- not writing to Supabase. Rows:", JSON.stringify(allRows, null, 2));
    return;
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (allRows.length > 0) {
    const { error } = await sb.from("competitor_prices").insert(allRows);
    if (error) throw error;
  }

  const { data: cars, error: carsErr } = await sb.from("cars").select("category, price_per_day").eq("active", true);
  if (carsErr) throw carsErr;

  const suggestions = computeSuggestions(allRows, cars);
  if (suggestions.length > 0) {
    const { error } = await sb.from("pricing_suggestions").insert(suggestions);
    if (error) throw error;
  }
  console.log(`Wrote ${allRows.length} competitor prices, ${suggestions.length} pricing suggestions.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
