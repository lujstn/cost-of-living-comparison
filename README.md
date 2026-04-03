# cost-of-living-comparison

A rough, vibes-based cost of living comparison across 100 cities to give somebody a quick gut-check before deciding where to live next.

Uses Claude's Batch API with extended thinking to estimate everyday costs in local currency, then rolls them up into a single per-city index.

## What this project is and isn't

Most cost-of-living indices do a decent job of reflecting essential living costs for a broad demographic. They usually rely on average values for things like a mixed-brand grocery shop or monthly utility bills.

That said, I think they’re often a better reflection of a family of four living in the suburbs than a single young professional living in the city. What if you don’t eat breakfast? What if you get a Lime bike home? Sweet treats and convenience culture are a very real, very dominant part of how a lot of young people live, and they’re barely reflected in most cost-of-living indices.

**I’d argue those costs aren’t just worth including... I think they can serve as anchors for the whole shape of your lifestyle.**

If groceries are cheaper, your oat latte is probably cheaper too. If petrol costs more, your Uber probably does as well. Your gym is probably charging what it thinks it can get away with in that city, based on the local economic climate.

So this takes a different approach.

Instead of trying to build a full budget, it uses a small number of benchmarks that capture the texture of a very specific kind of life: someone in tech, in their mid-twenties, sharing a flat in a good neighbourhood, eating out at nice places, and getting around by a mix of metro, bike and Uber.

The theory is that these benchmarks are correlated. If rent is cheaper, your oat latte probably is too. Your Uber is cheaper. Your gym is cheaper. The whole cost surface tends to move together, and a handful of well-chosen data points can capture the shape of it without pretending to be comprehensive.

The benchmarks are chosen to map to real moments in your week:

- **Rent** is the big one. Each city’s rent weight is set dynamically using the LLM’s estimate of what share of net salary goes to rent in that city.
- **Coffee** and a **nice dinner** capture the daily and weekly rituals.
- **Getting across town** covers the full spread: metro, bike, Uber home late.
- **The niceties** are the things that round out the lifestyle: Spotify, ordering food in, going to the gym.

The index is frequency-based: each item’s monthly cost (unit cost × typical frequency) is summed, with rent weighted by its estimated proportion of salary. This means the index naturally adapts to each city’s cost structure rather than applying a fixed global weighting.

The goal isn’t to build a budget planner, it’s to give a feel for what life costs in a given city.

## Measurements

The persona is a 27-year-old L4 Software Engineer at Google from _"a good family"_ in a middle class background.

> [!NOTE]
> Our goal here is to **explicitly introduce bias**. This isn't an oversight!
>
> Why? _LLMs with extended thinking often try to actively remove bias / assumptions from their responses, which is probably a good thing, but also causes massive variance in our outputs. To counter this, we skew the results to reflect a life that is more expensive than the average person's, but not outrageously so._

For each city, Claude estimates:

**Living costs** (min/max range + weighting)

- Oat latte from a good speciality roastery (or local area equivalent like Maté)
- Nice dinner for one (upper-mid-range)
- Lime bike (or local equivalent) for 10 min
- Metro ride for 20 min
- Private-hire taxi (Uber-style) for 30 min at night
- Premium fast food delivery (Uber Eats-style)
- Spotify Premium equivalent (one-off)
- Middle-upper tier gym membership (one-off)

**Rental costs** across three neighbourhood tiers

- Tier 1: _very_ central districts (e.g. Soho)
- Tier 2: trendy central districts (e.g. Shoreditch)
- Tier 3: further out but still trendy (e.g. Dalston)

Everything is in **local currency**. The index doesn't normalise across currencies (use a library like Frankfurter in your end project for this!).

Claude also estimates the percentage of this persona's salary that likely goes towards rent in each city (e.g. "45%") which is used to weight the index. This helps us balance out the fact that rent is generally the biggest driver of cost of living in Western countries but more variable in LEDCs.

## How it works

1. Reads `input/cities.json` (100 cities across 58 countries)
2. Builds batch requests from two prompt templates (`living_prompt.txt`, `rental_prompt.txt`)
3. Submits to Claude Batch API with extended thinking enabled
4. Polls until complete, then validates every response against the expected schema
5. Failed validations get two retry passes:
   - **Pass 1**: re-ask with thinking + a stern "ATTEMPT 3/3" diagnostic prompt
   - **Pass 2**: forced tool_choice with no thinking (schema-enforced, guaranteed structure)
6. Calculates a frequency-based cost-of-living index per city, dynamically weighted by rent proportion
7. Writes raw, marshalled, and final outputs to `output/`

## Running it

```bash
# Install deps
npm install

# Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# Run the pipeline
npm start
```

The batch takes a few minutes to process. You can safely Ctrl+C during polling; re-running will resume from the saved batch ID.

### Testing with one city

Swap `input/cities.json` to a single entry first:

```bash
cp input/cities.json input/cities_full.json
echo '[{"country": "Germany", "cities": ["Berlin"]}]' > input/cities.json
npm start
```

Then restore the full list when you're happy:

```bash
cp input/cities_full.json input/cities.json
rm -rf output/
npm start
```

## Output

```
output/
  raw/llm_responses/        # Raw JSON from Claude per city
  marshalled/llm_responses/  # Processed costs per city
  final/cost_of_living.json  # The final ranked dataset
```

Each city in the final output looks like:

```json
{
  "country": "Germany",
  "city": "Berlin",
  "oat_latte": { "cost": 4.9, "currency": "EUR" },
  "nice_dinner": { "cost": 66, "currency": "EUR" },
  "monthly_rent_share": { "cost": 905, "currency": "EUR" },
  "effective_tax_rate_percentage": 42.4,
  "rent_proportion_of_salary": 0.38,
  "cost_of_living_index": 1412.7
}
```

## Caveats

- All estimates come from Claude's training data, not live prices. Treat them as educated guesses, not gospel.
- Costs are in local currency. The index is only meaningful when comparing cities that share the same currency (e.g. EUR-zone cities against each other). Comparing London (GBP) to Tokyo (JPY) by raw index value is nonsensical.
- The persona matters. A different age, job level, or lifestyle would shift the estimates.

## License

[MIT](LICENSE)
