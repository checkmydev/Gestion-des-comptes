import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loading } from '../components/Layout'
import { PriceChart } from '../components/PriceChart'
import { loadPurchasesForItems, must } from '../lib/api'
import { useApp } from '../lib/app'
import { eur, longDate, pct, storeDate } from '../lib/format'
import { pointsFromPurchases, pointsFromReferences, storeColor, trendsByStore, UNIT_LABEL, type Unit } from '../lib/prices'
import { supabase } from '../lib/supabase'
import type { PriceReference, Purchase } from '../lib/types'

/** Évolution du prix d'un produit (tous magasins), avec les prix relevés. */
export default function Article() {
  const { id } = useParams()
  const itemId = Number(id)
  const { itemById, categoryById, storeById, stores, isWeighedItem } = useApp()
  const item = itemById(itemId)
  const [data, setData] = useState<{ purchases: Purchase[]; refs: PriceReference[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unit, setUnit] = useState<Unit | null>(null)

  useEffect(() => {
    setData(null)
    Promise.all([
      loadPurchasesForItems([itemId]),
      supabase.from('price_references').select('*').eq('item_id', itemId).order('observed_on'),
    ]).then(([purchases, refs]) => setData({ purchases, refs: must(refs) as PriceReference[] }))
      .catch((e) => setError((e as Error).message))
  }, [itemId])

  const storeIds = useMemo(() => stores.map((s) => s.id).sort((a, b) => a - b), [stores])
  const storeIdByName = (n: string) => stores.find((s) => s.name.toLocaleLowerCase('fr') === n.toLocaleLowerCase('fr'))?.id ?? null

  if (error) return <p className="error">{error}</p>
  if (!item) return <p className="muted">Article introuvable.</p>
  if (!data) return <Loading />

  const points = [
    ...pointsFromPurchases(data.purchases, (sid) => storeById(sid)?.name ?? 'Sans magasin', isWeighedItem),
    ...pointsFromReferences(data.refs, storeIdByName),
  ]
  const units = [...new Set(points.map((p) => p.unit))]
  const activeUnit = unit && units.includes(unit) ? unit : units[0]
  const shown = points.filter((p) => p.unit === activeUnit)

  const seriesMap = new Map<string, { key: string; label: string; color: string; points: typeof shown }>()
  for (const p of shown) {
    const key = p.storeId != null ? `s${p.storeId}` : `n${p.storeName}`
    if (!seriesMap.has(key)) seriesMap.set(key, { key, label: p.storeName, color: storeColor(p.storeId, storeIds), points: [] })
    seriesMap.get(key)!.points.push(p)
  }
  const trends = trendsByStore(shown)
  const lastPaid = [...shown].filter((p) => p.kind === 'paid').sort((a, b) => b.date.localeCompare(a.date))[0]
  const recentRefs = data.refs.filter((r) => r.unit === activeUnit)
  const bestRef = [...recentRefs].sort((a, b) => b.observed_on.localeCompare(a.observed_on) || a.price - b.price)
    .filter((r, _, arr) => r.observed_on === arr[0].observed_on)
    .sort((a, b) => Number(a.price) - Number(b.price))[0]

  return (
    <div className="stack">
      <div>
        <div className="muted small">{categoryById(item.category_id)?.name}</div>
        <h1>{item.name}</h1>
      </div>

      {units.length > 1 && (
        <div className="tabs">
          {units.map((u) => (
            <button key={u} className={u === activeUnit ? 'active' : ''} onClick={() => setUnit(u)}>{UNIT_LABEL[u]}</button>
          ))}
        </div>
      )}

      <section className="card">
        <h2>Évolution du prix ({UNIT_LABEL[activeUnit ?? 'piece']}, hors promo)</h2>
        {isWeighedItem(itemId) && data.purchases.some((p) => p.price_per_kg == null && !p.quantity_g) && (
          <p className="muted small" style={{ marginTop: -6 }}>Les achats encodés sans poids ni €/kg ne sont pas repris dans le graphique (ils restent dans l'historique).</p>
        )}
        <PriceChart series={[...seriesMap.values()]} />
      </section>

      {lastPaid && bestRef && (
        <div className={`alert ${Number(bestRef.price) < lastPaid.value ? '' : 'info'}`}>
          Dernier prix payé : <strong>{eur(lastPaid.value)}</strong> ({lastPaid.storeName}, {longDate(lastPaid.date)}).
          {' '}Meilleur prix relevé le {longDate(bestRef.observed_on)} : <strong>{eur(bestRef.price)}</strong> chez {bestRef.store_name}
          {bestRef.is_promo && ' (promo)'}
          {Number(bestRef.price) < lastPaid.value && <> — soit {pct(((Number(bestRef.price) - lastPaid.value) / lastPaid.value) * 100)}.</>}
        </div>
      )}

      {trends.length > 0 && (
        <section className="card">
          <h2>Par magasin</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Magasin</th><th className="num">Premier</th><th className="num">Dernier</th><th className="num">Évolution</th></tr></thead>
              <tbody>
                {trends.map((t) => (
                  <tr key={`${t.storeName}${t.unit}`}>
                    <td>{t.storeName}<div className="muted small">{t.points.length} achat{t.points.length > 1 ? 's' : ''}</div></td>
                    <td className="num">{eur(t.first.value)}<div className="muted small">{longDate(t.first.date)}</div></td>
                    <td className="num">{eur(t.last.value)}<div className="muted small">{longDate(t.last.date)}</div></td>
                    <td className={`num ${t.changePct > 0.05 ? 'up' : t.changePct < -0.05 ? 'down' : ''}`}>
                      {t.points.length > 1 ? pct(t.changePct) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data.refs.length > 0 && (
        <section className="card">
          <h2>Prix relevés</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Enseigne</th><th className="num">Prix</th></tr></thead>
              <tbody>
                {[...data.refs].reverse().map((r) => (
                  <tr key={r.id}>
                    <td>{longDate(r.observed_on)}</td>
                    <td>
                      {r.store_name}{r.is_promo && <span className="badge plain">promo</span>}
                      {r.label && <div className="muted small">{r.label}</div>}
                      {r.source && /^https?:/.test(r.source) && <div className="small"><a href={r.source} target="_blank" rel="noreferrer">source</a></div>}
                    </td>
                    <td className="num">{eur(r.price)} <span className="muted small">{UNIT_LABEL[r.unit]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Historique des achats</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Mois</th><th>Magasin + date</th><th className="num">Payé</th></tr></thead>
            <tbody>
              {[...data.purchases].reverse().map((p) => (
                <tr key={p.id}>
                  <td>{p.period.slice(5, 7)}/{p.period.slice(0, 4)}</td>
                  <td>{storeDate(storeById(p.store_id)?.name, p.purchased_on)}</td>
                  <td className="num">{eur(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Link to="/inflation">← Statistiques d'inflation</Link>
    </div>
  )
}
