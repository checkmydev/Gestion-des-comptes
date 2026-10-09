export type Section = 'revenu' | 'fixe'

export interface Category {
  id: number
  name: string
  sort_order: number
  weighed: boolean
  /** Colonne « Nombre » (1 par défaut) dans la saisie et le détail. */
  counted: boolean
  track_inflation: boolean
  archived: boolean
  monthly_budget: number | null
}

export interface Item {
  id: number
  category_id: number
  name: string
  /** Émoji choisi à la main (sinon déduit du nom). */
  icon?: string | null
}

export interface Store {
  id: number
  name: string
}

export interface Purchase {
  id: number
  period: string
  item_id: number
  store_id: number | null
  purchased_on: string | null
  quantity_g: number | null
  price_per_kg: number | null
  promo_pct: number | null
  /** Nombre d'unités achetées (vide = 1). */
  units: number | null
  amount: number
  note: string | null
}

export interface MonthRow {
  period: string
  opening_balance: number | null
  notes: string | null
}

export interface MonthlyLine {
  id: number
  period: string
  section: Section
  label: string
  amount: number
  note: string | null
  carry_over: boolean
  sort_order: number
}

export interface AnnualProvision {
  id: number
  year: number
  label: string
  annual_amount: number
  due_month: number | null
  sort_order: number
}

export interface AnnualPayment {
  id: number
  provision_id: number
  paid_on: string
  amount: number
  note: string | null
}

export interface SavingsMovement {
  id: number
  moved_on: string
  label: string
  amount: number
  note: string | null
}

export interface FuelFill {
  id: number
  period: string
  station: string
  filled_on: string | null
  price_per_litre: number | null
  km: number | null
  total: number
}

export interface Trip {
  id: number
  period: string
  label: string
  trip_date: string | null
  km_round_trip: number
}

export interface CategoryMonthTotal {
  period: string
  category_id: number
  total: number
}

export interface UserSettings {
  annual_budget: number
  emergency_target: number
}

export interface PriceReference {
  id: number
  item_id: number
  store_name: string
  price: number
  unit: 'piece' | 'kg' | 'l'
  label: string | null
  is_promo: boolean
  observed_on: string
  source: string | null
}
