import { supabase } from './supabase'
import type {
  Category, CategoryMonthTotal, FuelFill, Item, MonthRow, MonthlyLine, PriceReference, Purchase, Store, UserSettings,
} from './types'

type Result<T> = { data: T | null; error: { message: string } | null }

/** Traduit en français les messages techniques les plus courants de Supabase. */
export function frenchError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('failed to fetch') || m.includes('network')) return 'Pas de connexion internet. Réessayez dans un instant.'
  if (m.includes('duplicate key')) return 'Cet élément existe déjà.'
  if (m.includes('violates foreign key')) return 'Impossible : cet élément est encore utilisé ailleurs.'
  if (m.includes('row-level security') || m.includes('permission denied')) return 'Accès refusé. Reconnectez-vous.'
  if (m.includes('jwt') || m.includes('token')) return 'Votre session a expiré. Reconnectez-vous.'
  if (m.includes('invalid input syntax')) return 'Une valeur saisie n\'est pas valide.'
  if (m.includes('does not exist')) return 'La base de données n\'est pas encore installée (voir le README).'
  return message
}

/** Lève une erreur lisible si Supabase renvoie une erreur. */
export function must<T>(res: Result<T>): T {
  if (res.error) throw new Error(frenchError(res.error.message))
  return res.data as T
}

export type Row = Record<string, unknown>

export async function insertRow<T>(table: string, row: Row): Promise<T> {
  return must(await supabase.from(table).insert(row).select().single()) as T
}

export async function updateRow<T>(table: string, id: number, row: Row): Promise<T> {
  return must(await supabase.from(table).update(row).eq('id', id).select().single()) as T
}

export async function saveRow<T>(table: string, row: Row, id?: number | null): Promise<T> {
  return id ? updateRow<T>(table, id, row) : insertRow<T>(table, row)
}

export async function deleteRow(table: string, id: number): Promise<void> {
  must(await supabase.from(table).delete().eq('id', id))
}

export const DEFAULT_SETTINGS: UserSettings = { annual_budget: 2000, emergency_target: 3000 }

export async function loadRefs() {
  const [categories, items, stores, settings] = await Promise.all([
    supabase.from('categories').select('*').order('sort_order').order('name'),
    supabase.from('items').select('*').order('name'),
    supabase.from('stores').select('*').order('name'),
    supabase.from('user_settings').select('annual_budget, emergency_target').maybeSingle(),
  ])
  return {
    categories: must(categories) as Category[],
    items: must(items) as Item[],
    stores: must(stores) as Store[],
    settings: (must(settings) as UserSettings | null) ?? DEFAULT_SETTINGS,
  }
}

export async function saveSettings(s: UserSettings): Promise<void> {
  const { data } = await supabase.auth.getUser()
  must(await supabase.from('user_settings').upsert({ user_id: data.user?.id, ...s }))
}

export async function loadPurchases(period: string): Promise<Purchase[]> {
  return must(await supabase.from('purchases').select('*').eq('period', period)
    .order('purchased_on', { ascending: true, nullsFirst: true }).order('id')) as Purchase[]
}

const PAGE = 1000 // limite par défaut de l'API Supabase

/** Récupère toutes les lignes d'une requête, page par page. */
async function fetchAll<T>(query: (from: number, to: number) => PromiseLike<Result<T[]>>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const rows = must(await query(from, from + PAGE - 1))
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

/** Tous les achats des articles donnés (statistiques d'inflation). */
export async function loadPurchasesForItems(itemIds: number[]): Promise<Purchase[]> {
  const out: Purchase[] = []
  // Découpage pour ne pas dépasser la longueur d'URL de l'API REST.
  for (let i = 0; i < itemIds.length; i += 150) {
    const chunk = itemIds.slice(i, i + 150)
    out.push(...await fetchAll<Purchase>((from, to) => supabase.from('purchases').select('*').in('item_id', chunk)
      .order('purchased_on', { ascending: true, nullsFirst: true }).order('id').range(from, to)))
  }
  return out
}

/** Achats datés depuis une date (habitudes d'achat pour la liste de courses). */
export async function loadPurchasesSince(isoDate: string): Promise<Purchase[]> {
  return fetchAll<Purchase>((from, to) => supabase.from('purchases').select('*').gte('purchased_on', isoDate)
    .order('purchased_on').order('id').range(from, to))
}

export async function loadReferencesSince(isoDate: string): Promise<PriceReference[]> {
  return fetchAll<PriceReference>((from, to) => supabase.from('price_references').select('*').gte('observed_on', isoDate)
    .order('observed_on').order('id').range(from, to))
}

export async function lastPurchaseOf(itemId: number): Promise<Purchase | null> {
  return must(await supabase.from('purchases').select('*').eq('item_id', itemId)
    .order('purchased_on', { ascending: false, nullsFirst: false }).order('id', { ascending: false })
    .limit(1).maybeSingle()) as Purchase | null
}

/** Données nécessaires au calcul des soldes de tous les mois. */
export interface Ledger {
  months: MonthRow[]
  lines: MonthlyLine[]
  totals: CategoryMonthTotal[]
  fuel: FuelFill[]
}

export async function loadLedger(): Promise<Ledger> {
  const [months, lines, totals, fuel] = await Promise.all([
    fetchAll<MonthRow>((a, b) => supabase.from('months').select('*').order('period').range(a, b)),
    fetchAll<MonthlyLine>((a, b) => supabase.from('monthly_lines').select('*').order('period').order('sort_order').order('id').range(a, b)),
    fetchAll<CategoryMonthTotal>((a, b) => supabase.from('category_month_totals').select('period, category_id, total')
      .order('period').order('category_id').range(a, b)),
    fetchAll<FuelFill>((a, b) => supabase.from('fuel_fills').select('*')
      .order('filled_on', { ascending: true, nullsFirst: false }).order('id').range(a, b)),
  ])
  return {
    months,
    lines: lines.map((l) => ({ ...l, amount: Number(l.amount) })),
    totals: totals.map((t) => ({ ...t, total: Number(t.total) })),
    fuel: fuel.map((f) => ({ ...f, total: Number(f.total) })),
  }
}

/**
 * À la première ouverture d'un mois dans le Global, recopie les lignes
 * (revenus / dépenses fixes) du dernier mois connu. Les montants marqués
 * « recopier » sont repris, les autres sont remis à zéro.
 */
export async function ensureMonth(period: string, ledger: Ledger): Promise<boolean> {
  if (ledger.months.some((m) => m.period === period)) return false
  const previous = ledger.lines
    .filter((l) => l.period < period)
    .reduce<string | null>((max, l) => (max === null || l.period > max ? l.period : max), null)
  const hasLines = ledger.lines.some((l) => l.period === period)
  // « on conflict do nothing » : si deux ouvertures simultanées initialisent le
  // même mois, seule la première (celle qui crée la ligne) recopie les lignes.
  const created = must(await supabase.from('months')
    .upsert({ period }, { onConflict: 'user_id,period', ignoreDuplicates: true }).select()) as MonthRow[]
  if (!created.length) return false
  if (previous && !hasLines) {
    const copies = ledger.lines.filter((l) => l.period === previous).map((l) => ({
      period, section: l.section, label: l.label, amount: l.carry_over ? l.amount : 0,
      carry_over: l.carry_over, sort_order: l.sort_order,
    }))
    if (copies.length) must(await supabase.from('monthly_lines').insert(copies))
  }
  return true
}

export async function setOpeningBalance(period: string, value: number | null): Promise<void> {
  must(await supabase.from('months').upsert({ period, opening_balance: value }, { onConflict: 'user_id,period' }))
}
