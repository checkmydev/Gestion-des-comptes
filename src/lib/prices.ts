import type { PriceReference, Purchase } from './types'

export type Unit = 'kg' | 'piece' | 'l'

export const UNIT_LABEL: Record<Unit, string> = { kg: '€/kg', piece: '€/pièce', l: '€/l' }

/**
 * Prix de comparaison d'un achat, hors promo :
 *  - €/kg s'il est connu, ou calculé à partir du poids (montant ÷ kg) ;
 *  - sinon le prix d'une unité : montant ÷ nombre d'unités (2 Edam à 6,50 € → 3,25 €).
 */
export function unitPrice(p: Purchase): { value: number; unit: Unit } {
  const promo = Number(p.promo_pct ?? 0)
  const gross = promo > 0 && promo < 100 ? Number(p.amount) / (1 - promo / 100) : Number(p.amount)
  if (p.price_per_kg != null) return { value: Number(p.price_per_kg), unit: 'kg' }
  if (p.quantity_g) return { value: Math.round((gross / (Number(p.quantity_g) / 1000)) * 100) / 100, unit: 'kg' }
  const units = Number(p.units ?? 1) || 1
  return { value: Math.round((gross / units) * 100) / 100, unit: 'piece' }
}

/**
 * Un achat peut-il servir à comparer des prix ? Dans une catégorie pesée
 * (Légumes), un montant sans poids ni €/kg ne dit rien du prix (une salade,
 * « quelques carottes ») : il compte dans le budget, pas dans les prix.
 */
export function isComparable(p: Purchase, weighed: boolean): boolean {
  if (!p.purchased_on) return false
  return !weighed || p.price_per_kg != null || Boolean(p.quantity_g)
}

export interface PricePoint {
  date: string
  value: number
  unit: Unit
  storeId: number | null
  storeName: string
  kind: 'paid' | 'reference'
  promo: boolean
  source?: string | null
}

export function pointsFromPurchases(
  purchases: Purchase[],
  storeName: (id: number | null) => string,
  isWeighed: (itemId: number) => boolean = () => false,
): PricePoint[] {
  return purchases
    .filter((p) => isComparable(p, isWeighed(p.item_id)))
    .map((p) => {
      const u = unitPrice(p)
      return {
        date: p.purchased_on!, value: u.value, unit: u.unit, storeId: p.store_id,
        storeName: storeName(p.store_id), kind: 'paid' as const, promo: Boolean(p.promo_pct),
      }
    })
}

export function pointsFromReferences(refs: PriceReference[], storeIdByName: (n: string) => number | null): PricePoint[] {
  return refs.map((r) => ({
    date: r.observed_on, value: Number(r.price), unit: r.unit, storeId: storeIdByName(r.store_name),
    storeName: r.store_name, kind: 'reference' as const, promo: r.is_promo, source: r.source,
  }))
}

export interface StoreTrend {
  storeId: number | null
  storeName: string
  unit: Unit
  points: PricePoint[]
  first: PricePoint
  last: PricePoint
  /** Variation entre le premier et le dernier prix relevé dans ce magasin. */
  changePct: number
  /** Variation entre les deux derniers prix. */
  lastChangePct: number | null
}

/** Évolution par magasin (et par unité) à partir des achats d'un article. */
export function trendsByStore(points: PricePoint[]): StoreTrend[] {
  const groups = new Map<string, PricePoint[]>()
  for (const p of points.filter((x) => x.kind === 'paid')) {
    const key = `${p.storeId ?? p.storeName}|${p.unit}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  const out: StoreTrend[] = []
  for (const pts of groups.values()) {
    const sorted = [...pts].sort((a, b) => a.date.localeCompare(b.date))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const beforeLast = sorted.length > 1 ? sorted[sorted.length - 2] : null
    out.push({
      storeId: first.storeId, storeName: first.storeName, unit: first.unit, points: sorted, first, last,
      changePct: first.value ? ((last.value - first.value) / first.value) * 100 : 0,
      lastChangePct: beforeLast && beforeLast.value ? ((last.value - beforeLast.value) / beforeLast.value) * 100 : null,
    })
  }
  return out.sort((a, b) => b.points.length - a.points.length)
}

/**
 * Couleur fixe par magasin : les 8 premiers magasins (ordre de création)
 * ont chacun leur teinte ; au-delà, gris « autres » (jamais de teinte générée).
 */
export function storeColor(storeId: number | null, storeIds: number[]): string {
  const idx = storeId == null ? -1 : storeIds.indexOf(storeId)
  return idx >= 0 && idx < 8 ? `var(--s${idx + 1})` : 'var(--other)'
}
