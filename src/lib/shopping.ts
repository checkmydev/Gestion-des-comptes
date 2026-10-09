import { unitPrice } from './prices'
import type { Category, Item, PriceReference, Purchase } from './types'

const DAY = 864e5
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0
}

export interface Suggestion {
  item: Item
  category: Category
  /** Prix estimé d'un achat (médiane des 3 derniers montants payés). */
  estimate: number
  /** Nombre moyen de jours entre deux achats. */
  interval: number
  daysSinceLast: number
  /** > 1 : l'article « devrait » déjà avoir été racheté. */
  dueRatio: number
  purchases: number
  bestStore: { name: string; price: number; unit: string; reference: boolean } | null
  lastStore: string | null
}

export interface CategoryPlan {
  category: Category
  /** Budget restant pour la période choisie. */
  available: number
  basis: 'budget' | 'moyenne' | 'aucun'
  fits: Suggestion[]
  extra: Suggestion[]
  total: number
}

interface Input {
  categories: Category[]
  items: Item[]
  purchases: Purchase[] // historique récent (≈ 6 mois)
  references: PriceReference[]
  storeName: (id: number | null) => string | null
  spentThisMonth: (categoryId: number) => number
  averageMonth: (categoryId: number) => number | null
  today: string
  daysLeftInMonth: number
  daysInMonth: number
  horizonDays: number
}

/**
 * Propose une liste de courses à partir des habitudes d'achat :
 * articles réguliers dont le délai habituel est écoulé (ou le sera dans
 * l'horizon choisi), ajoutés par ordre d'urgence tant que le budget restant
 * de la catégorie le permet.
 */
export function planShopping(input: Input): CategoryPlan[] {
  const { categories, items, purchases, references, today, horizonDays } = input
  const byItem = new Map<number, Purchase[]>()
  for (const p of purchases) if (p.purchased_on) byItem.set(p.item_id, [...(byItem.get(p.item_id) ?? []), p])

  const suggestions: Suggestion[] = []
  for (const [itemId, ps] of byItem) {
    const item = items.find((i) => i.id === itemId)
    const category = item && categories.find((c) => c.id === item.category_id && !c.archived)
    if (!item || !category) continue
    const dates = [...new Set(ps.map((p) => p.purchased_on!))].sort()
    if (dates.length < 2) continue // pas encore d'habitude
    const gaps = dates.slice(1).map((d, i) => days(dates[i], d)).filter((g) => g > 0)
    if (!gaps.length) continue
    const interval = Math.max(3, median(gaps))
    const last = dates[dates.length - 1]
    const daysSinceLast = days(last, today)
    // Dû si le délai habituel est atteint avant la fin de l'horizon.
    if (daysSinceLast + horizonDays < interval * 0.9) continue
    if (daysSinceLast > Math.max(interval * 3, 45)) continue // habitude abandonnée

    const sorted = [...ps].sort((a, b) => (a.purchased_on! < b.purchased_on! ? -1 : 1))
    const estimate = Math.round(median(sorted.slice(-3).map((p) => Number(p.amount))) * 100) / 100

    // Magasin le moins cher récemment (prix payés et prix relevés des 90 derniers jours, même unité).
    const lastUnit = unitPrice(sorted[sorted.length - 1]).unit
    const candidates = [
      ...sorted.filter((p) => days(p.purchased_on!, today) <= 90).map((p) => ({ ...unitPrice(p), name: input.storeName(p.store_id), reference: false })),
      ...references.filter((r) => r.item_id === itemId && days(r.observed_on, today) <= 90)
        .map((r) => ({ value: Number(r.price), unit: r.unit, name: r.store_name, reference: true })),
    ].filter((c) => c.name && c.unit === lastUnit)
    const best = candidates.sort((a, b) => a.value - b.value)[0]

    suggestions.push({
      item, category, estimate, interval, daysSinceLast,
      dueRatio: (daysSinceLast + horizonDays) / interval,
      purchases: dates.length,
      bestStore: best ? { name: best.name!, price: best.value, unit: best.unit === 'kg' ? '€/kg' : '€', reference: best.reference } : null,
      lastStore: input.storeName(sorted[sorted.length - 1].store_id),
    })
  }

  // Part du budget mensuel correspondant à l'horizon choisi.
  const share = Math.min(1, horizonDays / Math.max(input.daysLeftInMonth, 1))
  return categories.filter((c) => !c.archived).map((category) => {
    const budget = category.monthly_budget != null ? Number(category.monthly_budget) : input.averageMonth(category.id)
    const basis: CategoryPlan['basis'] = category.monthly_budget != null ? 'budget' : budget != null ? 'moyenne' : 'aucun'
    const remaining = budget == null ? Infinity : Math.max(0, budget - input.spentThisMonth(category.id))
    const available = remaining === Infinity ? Infinity : remaining * share
    // Priorité aux achats de base : fréquence d'achat × urgence (plafonnée, pour
    // qu'un article oublié depuis longtemps ne passe pas devant le quotidien).
    const score = (s: Suggestion) => s.purchases * Math.min(s.dueRatio, 1.5)
    const list = suggestions.filter((s) => s.category.id === category.id)
      .sort((a, b) => score(b) - score(a))
    const fits: Suggestion[] = []
    const extra: Suggestion[] = []
    let total = 0
    for (const s of list) {
      if (total + s.estimate <= available + 0.005) { fits.push(s); total += s.estimate }
      else extra.push(s)
    }
    return { category, available, basis, fits, extra, total: Math.round(total * 100) / 100 }
  }).filter((p) => p.fits.length || p.extra.length)
}
