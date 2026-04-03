# Changelog

## [v3] - 2026-04-03

### Changed

- Cost of living index formula: replaced static 60/5/15/10/10 weighted formula with frequency-based dynamic index
- Index weighting now uses LLM-estimated rent proportion of salary per city, producing more accurate cross-city ratios
- Living prompt now asks for rent proportion of salary (9th question)
- Spotify normalisation recalculates the new index formula

### Removed

- Old `cost_of_living_city_index` field from output
- `annual_net_salary` and `salary_currency` fields from output
- Temporary investigation scripts (validate-ratios, compare-approaches, compare-dynamic, compare-frequency)

## [v2] - 2026-04-02

### Added

- Spotify subscription normalisation using PPP-adjusted pricing
- Subscription cost integration into the comparison pipeline

## [v1] - 2026-04-01

### Added

- Cost of living comparison pipeline using Claude API
- Living cost and rental prompt templates for per-city data extraction
- JSON output with structured cost breakdowns across cities and countries
