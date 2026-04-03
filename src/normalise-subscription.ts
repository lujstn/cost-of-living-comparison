import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { FinalCityResult } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface SpotifyEntry {
  country: string;
  price: string;
  currency_code: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function recalcIndex(
  city: FinalCityResult,
  musicCostForIndex?: number,
): number {
  const musicCost = musicCostForIndex ?? city.music_subscription.cost;

  const luxMonthly =
    15 * city.oat_latte.cost +
    4 * city.nice_dinner.cost +
    15 * city.lime_bike.cost +
    30 * city.metro_ride.cost +
    4 * city.phv_ride.cost +
    8 * city.food_delivery.cost +
    1 * musicCost +
    1 * city.gym.cost;

  const rentShare = city.monthly_rent_share.cost;
  const rentProp = city.rent_proportion_of_salary;

  return round2(rentProp * rentShare + (1 - rentProp) * luxMonthly);
}

async function fetchFxRate(base: string, quote: string): Promise<number> {
  const url = `https://api.frankfurter.dev/v2/rates?base=${base}&quotes=${quote}`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      `Frankfurter API error: ${res.status} for ${base}→${quote}`,
    );
  const data = (await res.json()) as Array<{ rate: number }>;
  return data[0].rate;
}

export async function normaliseSubscriptions() {
  const rootDir = path.resolve(__dirname, "..");
  const finalPath = path.join(rootDir, "output/final/cost_of_living.json");
  const spotifyPath = path.join(rootDir, "input/spotify-prices.json");

  const cities: FinalCityResult[] = JSON.parse(
    fs.readFileSync(finalPath, "utf-8"),
  );
  const spotifyRaw: SpotifyEntry[] = JSON.parse(
    fs.readFileSync(spotifyPath, "utf-8"),
  );

  // Build Spotify lookup (lowercase country → { price, currency })
  const spotifyLookup = new Map<string, { price: number; currency: string }>();
  for (const entry of spotifyRaw) {
    spotifyLookup.set(entry.country.toLowerCase(), {
      price: parseFloat(entry.price.replace(/,/g, "")),
      currency: entry.currency_code,
    });
  }

  // Group cities by country
  const byCountry = new Map<string, FinalCityResult[]>();
  for (const city of cities) {
    const group = byCountry.get(city.country) || [];
    group.push(city);
    byCountry.set(city.country, group);
  }

  // Pre-fetch FX rates for all currency mismatches
  const fxCache = new Map<string, number>();
  for (const [country, countryCities] of byCountry) {
    const spotify = spotifyLookup.get(country.toLowerCase());
    if (!spotify) continue;
    const localCurrency = countryCities[0].oat_latte.currency;
    if (spotify.currency === localCurrency) continue;
    const key = `${spotify.currency}→${localCurrency}`;
    if (!fxCache.has(key)) {
      const rate = await fetchFxRate(spotify.currency, localCurrency);
      fxCache.set(key, rate);
      console.log(
        `  FX fetched: 1 ${spotify.currency} = ${rate} ${localCurrency}`,
      );
    }
  }
  if (fxCache.size > 0) console.log();

  let spotifyMatches = 0;
  let medianFallbacks = 0;
  let fxConversions = 0;

  for (const [country, countryCities] of byCountry) {
    const spotify = spotifyLookup.get(country.toLowerCase());
    const beforeValues = countryCities.map(
      (c) => `${c.city}=${c.music_subscription.cost}`,
    );

    let newCost: number;
    let newCurrency: string;
    let source: string;
    let musicCostForIndex: number | undefined;

    if (spotify) {
      newCost = spotify.price;
      newCurrency = spotify.currency;
      source = `Spotify (${newCost} ${newCurrency})`;
      spotifyMatches++;

      // Check for currency mismatch
      const localCurrency = countryCities[0].oat_latte.currency;
      if (newCurrency !== localCurrency) {
        const fxKey = `${newCurrency}→${localCurrency}`;
        const rate = fxCache.get(fxKey)!;
        musicCostForIndex = round2(newCost * rate);
        fxConversions++;
      }
    } else {
      const costs = countryCities.map((c) => c.music_subscription.cost);
      newCost = Math.round(median(costs));
      newCurrency = countryCities[0].music_subscription.currency;
      source = `Median → ${newCost} ${newCurrency}`;
      medianFallbacks++;
    }

    console.log(
      `\n=== ${country} (${countryCities.length} ${countryCities.length === 1 ? "city" : "cities"}) ===`,
    );
    console.log(`  Source: ${source}`);
    if (musicCostForIndex !== undefined) {
      const localCurrency = countryCities[0].oat_latte.currency;
      const fxKey = `${newCurrency}→${localCurrency}`;
      console.log(
        `  FX: 1 ${newCurrency} = ${fxCache.get(fxKey)} ${localCurrency} → index uses ${musicCostForIndex} ${localCurrency}`,
      );
    }
    console.log(`  Before: ${beforeValues.join(", ")}`);

    const indexChanges: string[] = [];

    for (const city of countryCities) {
      const oldIndex = city.cost_of_living_index;

      city.music_subscription.cost = newCost;
      city.music_subscription.currency = newCurrency;

      // If we matched Spotify, this IS Spotify — remove name_of_equivalent
      if (spotify) {
        delete city.music_subscription.name_of_equivalent;
      }

      const newIndex = recalcIndex(city, musicCostForIndex);
      const diff = round2(newIndex - oldIndex);
      city.cost_of_living_index = newIndex;

      const sign = diff > 0 ? "+" : "";
      indexChanges.push(`${city.city} ${sign}${diff}`);
    }

    const afterValues = countryCities.map(
      (c) =>
        `${c.city}=${c.music_subscription.cost} ${c.music_subscription.currency}`,
    );
    console.log(`  After:  ${afterValues.join(", ")}`);
    console.log(`  Index:  ${indexChanges.join(" | ")}`);
  }

  // Write back
  fs.writeFileSync(finalPath, JSON.stringify(cities, null, 2));

  console.log(`\n--- Summary ---`);
  console.log(
    `${byCountry.size} countries: ${spotifyMatches} Spotify (${fxConversions} with FX conversion), ${medianFallbacks} median`,
  );
  console.log(`Written to ${finalPath}`);
}
