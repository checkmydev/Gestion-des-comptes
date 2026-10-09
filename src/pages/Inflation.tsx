import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loading } from '../components/Layout'
import { loadPurchasesForItems } from '../lib/api'
import { useApp } from '../lib/app'
import { eur, longDate, pct } from '../lib/format'
import { pointsFromPurchases, trendsByStore, UNIT_LABEL, type StoreTrend } from '../lib/prices'
import type { Purchase } from '../lib/types'

type Row = StoreTrend & { itemId: number; itemName: string; categoryName: string }

/**
 * Statistiques d'inflation : pour chaque article et chaque magasin, compare
 * les prix (forfaitaire ou €/kg, hors promo) dans le temps.
 */
export default function Inflation() {
  const { categories, items, storeById } = useApp()
  const navigate = useNavigate()
  const tracked = useMemo(() => categories.filter((c) => c.track_inflation), [categories])
  const [catFilter, setCatFilter] = useState<number | 'all'>('all')
  const [search, setSearch] = useState('')
  const [onlyComparable, setOnlyComparable] = useState(true)
  const [purchases, setPurchases] = useState<Purchase[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Clé texte stable : évite de recharger à chaque rendu.
  const trackedKey = useMemo(() => {
    const ids = new Set(tracked.map((c) => c.id))
    return items.filter((i) => ids.has(i.category_id)).map((i) => i.id).join(',')
  }, [items, tracked])

  useEffect(() => {
    const ids = trackedKey ? trackedKey.split(',').map(Number) : []
    loadPurchasesForItems(ids).then(setPurchases).catch((e) => setError((e as Error).message))
  }, [trackedKey])

  const rows = useMemo<Row[]>(() => {
    if (!purchases) return []
    const byItem = new Map<number, Purchase[]>()
    for (const p of purchases) byItem.set(p.item_id, [...(byItem.get(p.item_id) ?? []), p])
    const out: Row[] = []
    for (const [itemId, ps] of byItem) {
      const item = items.find((i) => i.id === itemId)
      if (!item) continue
      const cat = categories.find((c) => c.id === item.category_id)
      for (const t of trendsByStore(pointsFromPurchases(ps, (id) => storeById(id)?.name ?? 'Sans magasin'))) {
        out.push({ ...t, itemId, itemName: item.name, categoryName: cat?.name ?? '' })
      }
    }
    return out
  }, [purchases, items, categories, storeById])

  if (error) return <p className="error">{error}</p>
  if (!purchases) return <Loading />

  const q = search.trim().toLocaleLowerCase('fr')
  const shown = rows
    .filter((r) => catFilter === 'all' || items.find((i) => i.id === r.itemId)?.category_id === catFilter)
    .filter((r) => !q || r.itemName.toLocaleLowerCase('fr').includes(q))
    .filter((r) => !onlyComparable || r.points.length > 1)
    .sort((a, b) => b.changePct - a.changePct)

  const comparable = rows.filter((r) => r.points.length > 1)
  const ups = comparable.filter((r) => r.changePct > 0.05).length
  const downs = comparable.filter((r) => r.changePct < -0.05).length
  const sorted = comparable.map((r) => r.changePct).sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null

  return (
    <div className="stack">
      <h1>Inflation des prix</h1>
      <p className="muted small">
        Catégories suivies : {tracked.map((c) => c.name).join(', ') || 'aucune (à choisir dans les paramètres)'}.
        Prix comparés hors promo, par magasin. Touchez une ligne pour voir le graphique.
      </p>

      <div className="kpis">
        <div className="kpi"><div className="label">Prix en hausse</div><div className="value up">{ups}</div></div>
        <div className="kpi"><div className="label">Prix en baisse</div><div className="value down">{downs}</div></div>
        <div className="kpi"><div className="label">Variation médiane</div><div className="value">{median == null ? '—' : pct(median)}</div><div className="hint">sur {comparable.length} article·magasin comparables</div></div>
      </div>

      <div className="card stack">
        <input placeholder="Rechercher un article…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="chips">
          <button className={`chip ${catFilter === 'all' ? 'selected' : ''}`} onClick={() => setCatFilter('all')}>Toutes</button>
          {tracked.map((c) => (
            <button key={c.id} className={`chip ${catFilter === c.id ? 'selected' : ''}`} onClick={() => setCatFilter(c.id)}>{c.name}</button>
          ))}
        </div>
        <label className="field check">
          <input type="checkbox" checked={onlyComparable} onChange={(e) => setOnlyComparable(e.target.checked)} />
          Seulement les articles achetés au moins 2 fois dans le même magasin
        </label>
      </div>

      <section className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Article</th><th>Magasin</th><th className="num">Premier</th><th className="num">Dernier</th><th className="num">Évol.</th></tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.itemId}-${r.storeName}-${r.unit}`} className="clickable" onClick={() => navigate(`/article/${r.itemId}`)}>
                  <td>{r.itemName}<div className="muted small">{r.categoryName} · {UNIT_LABEL[r.unit]}</div></td>
                  <td>{r.storeName}</td>
                  <td className="num">{eur(r.first.value)}<div className="muted small">{longDate(r.first.date)}</div></td>
                  <td className="num">{eur(r.last.value)}<div className="muted small">{longDate(r.last.date)}</div></td>
                  <td className={`num strong ${r.changePct > 0.05 ? 'up' : r.changePct < -0.05 ? 'down' : ''}`}>
                    {r.points.length > 1 ? pct(r.changePct) : '—'}
                  </td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={5} className="muted">Rien à comparer pour l'instant.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
