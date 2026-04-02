import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

import type {
  CityEntry,
  FlatCity,
  LivingResponse,
  RentalResponse,
  CostItem,
  FinalCityResult,
  LivingItemKey,
} from "./types.js";
import { LIVING_ITEMS } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(country: string, city: string): string {
  return `${country}-${city}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function parseJsonSafely(text: string): unknown | null {
  // Strategy 1: direct parse
  try {
    return JSON.parse(text);
  } catch {}

  // Strategy 2: strip markdown code fences
  const stripped = text
    .replace(/^```(?:json)?\s*\n?/m, "")
    .replace(/\n?\s*```\s*$/m, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {}

  // Strategy 3: regex extract outermost JSON object
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  return null;
}

function isNumeric(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function getItemIssues(key: string, obj: unknown): string[] {
  if (typeof obj !== "object" || obj === null)
    return [`"${key}" is missing or not an object`];
  const o = obj as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumeric(o.min))
    issues.push(`${key}.min must be a number, got ${JSON.stringify(o.min)}`);
  if (!isNumeric(o.max))
    issues.push(`${key}.max must be a number, got ${JSON.stringify(o.max)}`);
  if (typeof o.currency !== "string")
    issues.push(`${key}.currency must be a string`);
  if (!isNumeric(o.weighting))
    issues.push(
      `${key}.weighting must be a number, got ${JSON.stringify(o.weighting)}`,
    );
  return issues;
}

function getLivingIssues(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null)
    return ["Response is not an object"];
  const o = parsed as Record<string, unknown>;
  return LIVING_ITEMS.flatMap((key) => getItemIssues(key, o[key]));
}

function getRentalIssues(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null)
    return ["Response is not an object"];
  const o = parsed as Record<string, unknown>;
  const issues: string[] = [];
  for (const key of ["tier_1", "tier_2", "tier_3"]) {
    issues.push(...getItemIssues(key, o[key]));
  }
  if (typeof o.salary !== "object" || o.salary === null) {
    issues.push(`"salary" is missing or not an object`);
  } else {
    const s = o.salary as Record<string, unknown>;
    if (!isNumeric(s.expected_annual_gross_salary))
      issues.push("salary.expected_annual_gross_salary must be a number");
    if (!isNumeric(s.expected_annual_net_salary))
      issues.push("salary.expected_annual_net_salary must be a number");
    if (typeof s.currency !== "string")
      issues.push("salary.currency must be a string");
  }
  return issues;
}

function validateLivingResponse(parsed: unknown): parsed is LivingResponse {
  return getLivingIssues(parsed).length === 0;
}

function validateRentalResponse(parsed: unknown): parsed is RentalResponse {
  return getRentalIssues(parsed).length === 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Tool Schemas (for schema-enforced retry fallback) ──────────────────────

const LIVING_ITEM_SCHEMA = {
  type: "object" as const,
  required: ["min", "max", "currency", "weighting"],
  properties: {
    min: { type: "number" as const },
    max: { type: "number" as const },
    currency: { type: "string" as const },
    weighting: { type: "number" as const },
    name_of_equivalent: { type: "string" as const },
  },
};

const RENTAL_TIER_SCHEMA = {
  type: "object" as const,
  required: ["min", "max", "currency", "period", "weighting"],
  properties: {
    min: { type: "number" as const },
    max: { type: "number" as const },
    currency: { type: "string" as const },
    period: { type: "string" as const },
    weighting: { type: "number" as const },
  },
};

const LIVING_TOOL = {
  name: "submit_living_costs",
  description:
    "Submit the living cost estimates for the specified city. You MUST call this tool with your response.",
  input_schema: {
    type: "object" as const,
    required: [...LIVING_ITEMS],
    properties: Object.fromEntries(
      LIVING_ITEMS.map((key) => [key, LIVING_ITEM_SCHEMA]),
    ),
  },
};

const RENTAL_TOOL = {
  name: "submit_rental_costs",
  description:
    "Submit the rental cost and salary estimates for the specified city. You MUST call this tool with your response.",
  input_schema: {
    type: "object" as const,
    required: ["tier_1", "tier_2", "tier_3", "salary"],
    properties: {
      tier_1: RENTAL_TIER_SCHEMA,
      tier_2: RENTAL_TIER_SCHEMA,
      tier_3: RENTAL_TIER_SCHEMA,
      salary: {
        type: "object" as const,
        required: [
          "expected_annual_gross_salary",
          "expected_annual_net_salary",
          "currency",
        ],
        properties: {
          expected_annual_gross_salary: { type: "number" as const },
          expected_annual_net_salary: { type: "number" as const },
          currency: { type: "string" as const },
        },
      },
    },
  },
};

// ─── Main Pipeline ──────────────────────────────────────────────────────────

async function main() {
  const ROOT = process.cwd();

  // Step 1: Load data
  const citiesData: CityEntry[] = JSON.parse(
    fs.readFileSync(path.join(ROOT, "input/cities.json"), "utf-8"),
  );
  const livingTemplate = fs.readFileSync(
    path.join(ROOT, "living_prompt.txt"),
    "utf-8",
  );
  const rentalTemplate = fs.readFileSync(
    path.join(ROOT, "rental_prompt.txt"),
    "utf-8",
  );

  const flatCities: FlatCity[] = citiesData.flatMap((entry) =>
    entry.cities.map((city) => ({ country: entry.country, city })),
  );

  console.log(
    `Loaded ${flatCities.length} cities from ${citiesData.length} countries`,
  );

  // Create output directories
  const RAW_DIR = path.join(ROOT, "output/raw/llm_responses");
  const MARSHALLED_DIR = path.join(ROOT, "output/marshalled/llm_responses");
  const FINAL_DIR = path.join(ROOT, "output/final");
  ensureDir(RAW_DIR);
  ensureDir(MARSHALLED_DIR);
  ensureDir(FINAL_DIR);

  // Step 2: Build batch requests
  const anthropic = new Anthropic();

  const requests = flatCities.flatMap(({ country, city }, i) => {
    const cityLabel = `${city}, ${country}`;
    return [
      {
        custom_id: `living-${i}`,
        params: {
          model: "claude-opus-4-6" as const,
          max_tokens: 8192,
          thinking: {
            type: "enabled" as const,
            budget_tokens: 5000,
          },
          messages: [
            {
              role: "user" as const,
              content: livingTemplate.replace(/%CITY%/g, cityLabel),
            },
          ],
        },
      },
      {
        custom_id: `rental-${i}`,
        params: {
          model: "claude-opus-4-6" as const,
          max_tokens: 8192,
          thinking: {
            type: "enabled" as const,
            budget_tokens: 5000,
          },
          messages: [
            {
              role: "user" as const,
              content: rentalTemplate.replace(/%CITY%/g, cityLabel),
            },
          ],
        },
      },
    ];
  });

  console.log(`Built ${requests.length} batch requests`);

  // Step 3: Submit batch (or resume from existing batch ID)
  const batchIdFile = path.join(ROOT, "output/batch-id.txt");
  let batchId: string;

  if (fs.existsSync(batchIdFile)) {
    const savedId = fs.readFileSync(batchIdFile, "utf-8").trim();
    try {
      await anthropic.messages.batches.retrieve(savedId);
      batchId = savedId;
      console.log(`Resuming batch: ${batchId}`);
    } catch {
      console.log(
        `Stale batch ID ${savedId} (expired or deleted). Creating new batch.`,
      );
      fs.unlinkSync(batchIdFile);
      const batch = await anthropic.messages.batches.create({ requests });
      batchId = batch.id;
      ensureDir(path.dirname(batchIdFile));
      fs.writeFileSync(batchIdFile, batchId);
      console.log(`Batch created: ${batchId}`);
    }
  } else {
    const batch = await anthropic.messages.batches.create({ requests });
    batchId = batch.id;
    ensureDir(path.dirname(batchIdFile));
    fs.writeFileSync(batchIdFile, batchId);
    console.log(`Batch created: ${batchId}`);
  }

  // Step 4: Poll for completion
  console.log("Polling for batch completion...");
  while (true) {
    const status = await anthropic.messages.batches.retrieve(batchId);
    const { processing, succeeded, errored, expired } = status.request_counts;
    const ts = new Date().toISOString().slice(11, 19);
    process.stdout.write(
      `\r[${ts}] ${succeeded} succeeded | ${errored} errored | ${expired} expired | ${processing} processing   `,
    );

    if (status.processing_status === "ended") {
      console.log("\nBatch complete!");
      break;
    }

    await new Promise((r) => setTimeout(r, 60_000));
  }

  // Step 5: Retrieve results & save raw responses
  const livingResults = new Map<number, LivingResponse>();
  const rentalResults = new Map<number, RentalResponse>();
  const errors: string[] = [];
  const retryQueue: Array<{
    customId: string;
    index: number;
    type: "living" | "rental";
    issues: string[];
  }> = [];

  const resultsStream = await anthropic.messages.batches.results(batchId);
  for await (const entry of resultsStream) {
    const result = entry.result;

    if (result.type !== "succeeded") {
      errors.push(`${entry.custom_id}: ${result.type}`);
      continue;
    }

    // Extract text from content blocks (skip thinking blocks)
    const textBlock = result.message.content.find(
      (b: { type: string }) => b.type === "text",
    );
    if (!textBlock || textBlock.type !== "text") {
      errors.push(`${entry.custom_id}: no text block in response`);
      continue;
    }

    const parsed = parseJsonSafely(textBlock.text);
    if (!parsed) {
      errors.push(`${entry.custom_id}: JSON parse failed`);
      // Save the raw text for debugging
      const debugFile = path.join(RAW_DIR, `${entry.custom_id}_debug.txt`);
      fs.writeFileSync(debugFile, textBlock.text);
      continue;
    }

    // Parse custom_id: "living-42" or "rental-42"
    const dashIdx = entry.custom_id.indexOf("-");
    const type = entry.custom_id.slice(0, dashIdx);
    const index = parseInt(entry.custom_id.slice(dashIdx + 1), 10);
    const { country, city } = flatCities[index];
    const slug = slugify(country, city);

    // Save raw response
    fs.writeFileSync(
      path.join(RAW_DIR, `${slug}_${type}.json`),
      JSON.stringify(parsed, null, 2),
    );

    if (type === "living") {
      if (!validateLivingResponse(parsed)) {
        retryQueue.push({
          customId: entry.custom_id,
          index,
          type: "living",
          issues: getLivingIssues(parsed),
        });
        const debugFile = path.join(RAW_DIR, `${entry.custom_id}_debug.json`);
        fs.writeFileSync(debugFile, JSON.stringify(parsed, null, 2));
        continue;
      }
      livingResults.set(index, parsed);
    } else {
      if (!validateRentalResponse(parsed)) {
        retryQueue.push({
          customId: entry.custom_id,
          index,
          type: "rental",
          issues: getRentalIssues(parsed),
        });
        const debugFile = path.join(RAW_DIR, `${entry.custom_id}_debug.json`);
        fs.writeFileSync(debugFile, JSON.stringify(parsed, null, 2));
        continue;
      }
      rentalResults.set(index, parsed);
    }
  }

  // Retry validation failures (two-pass: thinking + diagnostics, then forced tool_choice)
  if (retryQueue.length > 0) {
    console.log(`\nRetrying ${retryQueue.length} failed response(s)...`);

    // Pass 1: retry with thinking + diagnostic prompt
    const toolRetryQueue: typeof retryQueue = [];

    for (const item of retryQueue) {
      const { customId, index, type, issues } = item;
      const { country, city } = flatCities[index];
      const cityLabel = `${city}, ${country}`;
      const template = type === "living" ? livingTemplate : rentalTemplate;

      const retryPrompt = `${template.replace(/%CITY%/g, cityLabel)}

IMPORTANT NOTE: ATTEMPT 3/3.
Your last result was rejected as it did not conform to our schema. Specifically:
${issues.map((i) => `- ${i}`).join("\n")}

YOU MUST ENSURE:
- Every numeric field (min, max, weighting, salary amounts) MUST be a number — NEVER null or omitted
- weighting MUST be a number between 0 and 1, even for one-off items
- Return ONLY the JSON object matching the schema above — no extra fields, no markdown fences`;

      try {
        console.log(`  [1/2] ${customId} — retrying with thinking...`);
        const response = await anthropic.messages.create({
          model: "claude-opus-4-6",
          max_tokens: 8192,
          thinking: { type: "enabled" as const, budget_tokens: 5000 },
          messages: [{ role: "user" as const, content: retryPrompt }],
        });

        const textBlock = response.content.find((b) => b.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          toolRetryQueue.push(item);
          continue;
        }

        const parsed = parseJsonSafely(textBlock.text);
        if (!parsed) {
          toolRetryQueue.push(item);
          continue;
        }

        const slug = slugify(country, city);

        if (type === "living") {
          if (!validateLivingResponse(parsed)) {
            toolRetryQueue.push({
              ...item,
              issues: getLivingIssues(parsed),
            });
            continue;
          }
          fs.writeFileSync(
            path.join(RAW_DIR, `${slug}_living.json`),
            JSON.stringify(parsed, null, 2),
          );
          livingResults.set(index, parsed);
        } else {
          if (!validateRentalResponse(parsed)) {
            toolRetryQueue.push({
              ...item,
              issues: getRentalIssues(parsed),
            });
            continue;
          }
          fs.writeFileSync(
            path.join(RAW_DIR, `${slug}_rental.json`),
            JSON.stringify(parsed, null, 2),
          );
          rentalResults.set(index, parsed);
        }

        console.log(`  Recovered: ${customId} (${city}, ${country})`);
      } catch (err) {
        toolRetryQueue.push(item);
      }
    }

    // Pass 2: retry with forced tool_choice (no thinking, schema-enforced)
    for (const { customId, index, type } of toolRetryQueue) {
      const { country, city } = flatCities[index];
      const cityLabel = `${city}, ${country}`;
      const template = type === "living" ? livingTemplate : rentalTemplate;
      const tool = type === "living" ? LIVING_TOOL : RENTAL_TOOL;

      try {
        console.log(
          `  [2/2] ${customId} — retrying with schema enforcement...`,
        );
        const response = await anthropic.messages.create({
          model: "claude-opus-4-6",
          max_tokens: 8192,
          tools: [tool],
          tool_choice: { type: "tool" as const, name: tool.name },
          messages: [
            {
              role: "user" as const,
              content: template.replace(/%CITY%/g, cityLabel),
            },
          ],
        });

        const toolBlock = response.content.find((b) => b.type === "tool_use");
        if (!toolBlock || toolBlock.type !== "tool_use") {
          errors.push(`${customId}: all retries failed — no tool_use block`);
          continue;
        }

        const retryParsed = toolBlock.input;
        const slug = slugify(country, city);

        fs.writeFileSync(
          path.join(RAW_DIR, `${slug}_${type}.json`),
          JSON.stringify(retryParsed, null, 2),
        );

        if (type === "living") {
          if (!validateLivingResponse(retryParsed)) {
            errors.push(
              `${customId}: all retries failed — still invalid shape`,
            );
            continue;
          }
          livingResults.set(index, retryParsed);
        } else {
          if (!validateRentalResponse(retryParsed)) {
            errors.push(
              `${customId}: all retries failed — still invalid shape`,
            );
            continue;
          }
          rentalResults.set(index, retryParsed);
        }

        console.log(`  Recovered: ${customId} (${city}, ${country})`);
      } catch (err) {
        errors.push(
          `${customId}: all retries failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  console.log(
    `\nResults: ${livingResults.size} living, ${rentalResults.size} rental`,
  );
  if (errors.length > 0) {
    console.log(`Errors (${errors.length}):`);
    errors.forEach((e) => console.log(`  - ${e}`));
  }

  // Steps 6-10: Process, marshall, calculate index, and save
  const finalResults: FinalCityResult[] = [];

  for (let i = 0; i < flatCities.length; i++) {
    const { country, city } = flatCities[i];
    const slug = slugify(country, city);
    const living = livingResults.get(i);
    const rental = rentalResults.get(i);

    if (!living || !rental) {
      console.warn(
        `Skipping ${city}, ${country}: missing ${!living ? "living" : ""}${!living && !rental ? " + " : ""}${!rental ? "rental" : ""} data`,
      );
      continue;
    }

    // Step 6: Process living items → expected cost at weighting within range
    const costItems: Record<LivingItemKey, CostItem> = {} as Record<
      LivingItemKey,
      CostItem
    >;
    for (const key of LIVING_ITEMS) {
      const item = living[key];
      const cost = item.min + item.weighting * (item.max - item.min);
      costItems[key] = {
        cost: round2(cost),
        currency: item.currency,
        ...(item.name_of_equivalent
          ? { name_of_equivalent: item.name_of_equivalent }
          : {}),
      };
    }

    // Step 7: Process rental → weighted tier midpoints / 2
    const tiers = [rental.tier_1, rental.tier_2, rental.tier_3];
    const expectedFullRent = tiers.reduce((sum, tier) => {
      const mid = (tier.min + tier.max) / 2;
      return sum + tier.weighting * mid;
    }, 0);
    const expectedRentShare = expectedFullRent / 2;

    // Effective tax rate
    const {
      expected_annual_gross_salary: gross,
      expected_annual_net_salary: net,
    } = rental.salary;
    const effectiveTaxRate = gross > 0 ? ((gross - net) / gross) * 100 : 0;

    // Step 8: Save marshalled output
    const marshalled = {
      country,
      city,
      ...costItems,
      monthly_rent_share: {
        cost: round2(expectedRentShare),
        currency: rental.tier_1.currency,
      },
      effective_tax_rate_percentage: round2(effectiveTaxRate),
    };
    fs.writeFileSync(
      path.join(MARSHALLED_DIR, `${slug}.json`),
      JSON.stringify(marshalled, null, 2),
    );

    // Step 9: Calculate Cost of Living City Index
    const tripGroup =
      0.3 * costItems.lime_bike.cost +
      0.3 * costItems.metro_ride.cost +
      0.3 * costItems.phv_ride.cost;

    const nicetiesGroup =
      0.2 * costItems.music_subscription.cost +
      0.4 * costItems.gym.cost +
      0.4 * costItems.food_delivery.cost;

    const index =
      0.6 * marshalled.monthly_rent_share.cost +
      0.05 * costItems.oat_latte.cost +
      0.15 * costItems.nice_dinner.cost +
      0.1 * tripGroup +
      0.1 * nicetiesGroup;

    // Step 10: Build final result
    finalResults.push({
      country,
      city,
      oat_latte: costItems.oat_latte,
      nice_dinner: costItems.nice_dinner,
      lime_bike: costItems.lime_bike,
      metro_ride: costItems.metro_ride,
      phv_ride: costItems.phv_ride,
      food_delivery: costItems.food_delivery,
      music_subscription: costItems.music_subscription,
      gym: costItems.gym,
      monthly_rent_share: marshalled.monthly_rent_share,
      effective_tax_rate_percentage: marshalled.effective_tax_rate_percentage,
      cost_of_living_city_index: round2(index),
    });
  }

  // Save final output
  fs.writeFileSync(
    path.join(FINAL_DIR, "cost_of_living.json"),
    JSON.stringify(finalResults, null, 2),
  );

  console.log(
    `\nDone! ${finalResults.length} cities written to output/final/cost_of_living.json`,
  );

  // Clean up batch ID file on full success
  if (errors.length === 0 && finalResults.length === flatCities.length) {
    fs.unlinkSync(batchIdFile);
    console.log("Batch ID file cleaned up (all requests succeeded).");
  }
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
