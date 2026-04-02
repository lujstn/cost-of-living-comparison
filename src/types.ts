// --- Input Types ---

export interface CityEntry {
  country: string;
  cities: string[];
}

export interface FlatCity {
  country: string;
  city: string;
}

// --- LLM Response Types ---

export interface LivingItem {
  min: number;
  max: number;
  currency: string;
  weighting: number;
  name_of_equivalent?: string;
}

export interface LivingResponse {
  oat_latte: LivingItem;
  nice_dinner: LivingItem;
  lime_bike: LivingItem;
  metro_ride: LivingItem;
  phv_ride: LivingItem;
  food_delivery: LivingItem;
  music_subscription: LivingItem;
  gym: LivingItem;
}

export interface RentalTier {
  min: number;
  max: number;
  currency: string;
  period: string;
  weighting: number;
}

export interface Salary {
  expected_annual_gross_salary: number;
  expected_annual_net_salary: number;
  currency: string;
}

export interface RentalResponse {
  tier_1: RentalTier;
  tier_2: RentalTier;
  tier_3: RentalTier;
  salary: Salary;
}

// --- Output Types ---

export interface CostItem {
  cost: number;
  currency: string;
  name_of_equivalent?: string;
}

export interface RentItem {
  cost: number;
  currency: string;
}

export interface FinalCityResult {
  country: string;
  city: string;
  oat_latte: CostItem;
  nice_dinner: CostItem;
  lime_bike: CostItem;
  metro_ride: CostItem;
  phv_ride: CostItem;
  food_delivery: CostItem;
  music_subscription: CostItem;
  gym: CostItem;
  monthly_rent_share: RentItem;
  effective_tax_rate_percentage: number;
  cost_of_living_city_index: number;
}

export const LIVING_ITEMS = [
  "oat_latte",
  "nice_dinner",
  "lime_bike",
  "metro_ride",
  "phv_ride",
  "food_delivery",
  "music_subscription",
  "gym",
] as const;

export type LivingItemKey = (typeof LIVING_ITEMS)[number];
