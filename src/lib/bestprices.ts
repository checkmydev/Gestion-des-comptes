import { unitPrice, type Unit } from './prices'
import type { Category, Item, PriceReference, Purchase } from './types'

export interface StorePrice {
  store: string
  price: number
  unit: Unit
  date: string
  promo: boolean
  label: string | null
  source: string | null
}

export interface ProductComparison {
  item: Item
  category: Category | undefined
  /** Dernier prix payé par l'utilisateur (hors promo), s'il existe. */
  paid: { price: number; unit: Unit; store: string | null; date: string | null } | null
  /** Dernier prix relevé dans chaque enseigne, du moins cher au plus cher. */
  stores: StorePrice[]
  best: StorePrice
  /** Écart entre le meilleur prix relevé et le dernier prix payé (négatif = économie possible). */
  diffPct: number | null
}

/**
 * Pour chaque article ayant des prix relevés : le dernier prix par enseigne,
 * la meilleure offre et la comparaison avec ce que l'utilisateur paie.
 * On ne compare que des prix dans la même unité (€/kg avec €/kg, etc.).
 */
export function compareProducts(
  items: Item[],
  categories: Category[],
  refs: PriceReference[],
  purchases: Purchase[],
  storeName: (id: number | null) => string | null,
): ProductComparison[] {
  const refsByItem = new Map<number, PriceReference[]>()
  for (const r of refs) refsByItem.set(r.item_id, [...(refsByItem.get(r.item_id) ?? []), r])

  const lastPaid = new Map<number, Purchase>()
  for (const p of purchases) {
    const cur = lastPaid.get(p.item_id)
    if (!cur || (p.purchased_on ?? '') > (cur.purchased_on ?? '') || ((p.purchased_on ?? '') === (cur.purchased_on ?? '') && p.id > cur.id)) {
      lastPaid.set(p.item_id, p)
    }
  }

  const out: ProductComparison[] = []
  for (const [itemId, list] of refsByItem) {
    const item = items.find((i) => i.id === itemId)
    if (!item) continue
    const p = lastPaid.get(itemId)
    const paidUnit = p ? unitPrice(p) : null
    // Unité de comparaison : celle du dernier achat si des relevés existent dans cette unité.
    const unit: Unit = paidUnit && list.some((r) => r.unit === paidUnit.unit) ? paidUnit.unit : list[0].unit

    // Dernier relevé par enseigne (dans l'unité choisie)
    const latest = new Map<string, PriceReference>()
    for (const r of list.filter((x) => x.unit === unit)) {
      const key = r.store_name.toLocaleLowerCase('fr')
      const cur = latest.get(key)
      if (!cur || r.observed_on > cur.observed_on || (r.observed_on === cur.observed_on && r.id > cur.id)) latest.set(key, r)
    }
    const stores = [...latest.values()]
      .map((r) => ({ store: r.store_name, price: Number(r.price), unit: r.unit, date: r.observed_on, promo: r.is_promo, label: r.label, source: r.source }))
      .sort((a, b) => a.price - b.price)
    if (!stores.length) continue
    const best = stores[0]
    const paid = paidUnit && paidUnit.unit === unit
      ? { price: paidUnit.value, unit, store: storeName(p!.store_id), date: p!.purchased_on }
      : null
    out.push({
      item, category: categories.find((c) => c.id === item.category_id), paid, stores, best,
      diffPct: paid && paid.price > 0 ? ((best.price - paid.price) / paid.price) * 100 : null,
    })
  }
  // D'abord les plus grosses économies possibles, puis les autres par nom
  return out.sort((a, b) => (a.diffPct ?? 0) - (b.diffPct ?? 0) || a.item.name.localeCompare(b.item.name, 'fr'))
}

/** Classement des enseignes : nombre de produits pour lesquels chacune est la moins chère. */
export function storeRanking(products: ProductComparison[]): { store: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const p of products) if (p.stores.length > 1) counts.set(p.best.store, (counts.get(p.best.store) ?? 0) + 1)
  return [...counts].map(([store, count]) => ({ store, count })).sort((a, b) => b.count - a.count)
}
