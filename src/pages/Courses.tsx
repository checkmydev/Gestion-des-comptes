import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loading } from '../components/Layout'
import { loadLedger, loadPurchasesSince, loadReferencesSince, type Ledger } from '../lib/api'
import { useApp } from '../lib/app'
import { categoryAverage, categoryTotal } from '../lib/budget'
import { eur, todayIso } from '../lib/format'
import { currentPeriod, periodLabel } from '../lib/period'
import { planShopping, type Suggestion } from '../lib/shopping'
import type { PriceReference, Purchase } from '../lib/types'
import { CoursesTabs } from './MeilleursPrix'

type Horizon = 7 | 'mois'
type Grouping = 'categorie' | 'magasin'

const CHECK_KEY = (p: string) => `comptes.courses.${p}`

function readChecks(p: string): Set<number> {
  try { return new Set(JSON.parse(localStorage.getItem(CHECK_KEY(p)) ?? '[]') as number[]) } catch { return new Set() }
}

/** Liste de courses proposée selon les habitudes d'achat, dans les limites du budget. */
export default function Courses() {
  const { categories, items, storeById } = useApp()
  // La liste concerne toujours le mois en cours (c'est là que se font les courses).
  const period = currentPeriod()
  const today = todayIso()
  const [data, setData] = useState<{ ledger: Ledger; purchases: Purchase[]; refs: PriceReference[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [horizon, setHorizon] = useState<Horizon>(7)
  const [grouping, setGrouping] = useState<Grouping>('categorie')
  const [checked, setChecked] = useState<Set<number>>(() => readChecks(period))
  const [showExtra, setShowExtra] = useState(false)

  useEffect(() => {
    const since = new Date(Date.now() - 183 * 864e5).toISOString().slice(0, 10)
    const refSince = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)
    Promise.all([loadLedger(), loadPurchasesSince(since), loadReferencesSince(refSince)])
      .then(([ledger, purchases, refs]) => setData({ ledger, purchases, refs }))
      .catch((e) => setError((e as Error).message))
  }, [])

  const d = new Date()
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  const daysLeft = daysInMonth - d.getDate() + 1
  const horizonDays = horizon === 'mois' ? daysLeft : Math.min(7, daysLeft)

  const plans = useMemo(() => {
    if (!data) return []
    return planShopping({
      categories, items, purchases: data.purchases, references: data.refs,
      storeName: (id) => storeById(id)?.name ?? null,
      spentThisMonth: (cid) => categoryTotal(data.ledger, cid, period),
      averageMonth: (cid) => categoryAverage(data.ledger, cid, period, 3),
      today, daysLeftInMonth: daysLeft, daysInMonth, horizonDays,
    })
  }, [data, categories, items, storeById, period, today, daysLeft, daysInMonth, horizonDays])

  if (error) return <p className="error">{error}</p>
  if (!data) return <Loading />

  function toggle(id: number) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try { localStorage.setItem(CHECK_KEY(period), JSON.stringify([...next])) } catch { /* ignoré */ }
      return next
    })
  }

  const fits = plans.flatMap((p) => p.fits)
  const extra = plans.flatMap((p) => p.extra)
  const total = fits.reduce((a, s) => a + s.estimate, 0)
  const available = plans.reduce((a, p) => a + (Number.isFinite(p.available) ? p.available : 0), 0)
  const remainingToBuy = fits.filter((s) => !checked.has(s.item.id)).reduce((a, s) => a + s.estimate, 0)

  const row = (s: Suggestion, muted = false) => (
    <label key={s.item.id} className="row" style={{ flexWrap: 'nowrap', padding: '10px 0', borderBottom: '1px solid var(--grid)', opacity: muted ? 0.75 : 1 }}>
      <input type="checkbox" checked={checked.has(s.item.id)} onChange={() => toggle(s.item.id)} />
      <span className="grow" style={{ textDecoration: checked.has(s.item.id) ? 'line-through' : undefined }}>
        <strong>{s.item.name}</strong>
        {(() => {
          const where = grouping === 'magasin' ? s.category.name : s.bestStore?.name ?? s.lastStore
          return where ? <span className="muted small"> · {where}</span> : null
        })()}
        <div className="muted small">
          {s.daysSinceLast >= s.interval ? `dernier achat il y a ${s.daysSinceLast} j` : `d'habitude tous les ${Math.round(s.interval)} j`}
          {s.bestStore && <> · moins cher : {s.bestStore.name} {eur(s.bestStore.price)}{s.bestStore.unit === '€/kg' ? '/kg' : ''}{s.bestStore.reference ? ' (relevé)' : ''}</>}
        </div>
      </span>
      <span className="num">≈ {eur(s.estimate)}</span>
    </label>
  )

  const byStore = new Map<string, Suggestion[]>()
  for (const s of fits) {
    const k = s.bestStore?.name ?? s.lastStore ?? 'Magasin indifférent'
    byStore.set(k, [...(byStore.get(k) ?? []), s])
  }

  return (
    <div className="stack">
      <CoursesTabs />
      <h1>Liste de courses</h1>
      <p className="muted small">
        Proposée d'après les achats des 6 derniers mois : articles réguliers dont le délai habituel est atteint,
        dans la limite du budget restant de {periodLabel(period)} (budget fixé ou, à défaut, moyenne des 3 derniers mois).
      </p>

      <div className="card stack" style={{ gap: 10 }}>
        <div className="chips">
          <button className={`chip ${horizon === 7 ? 'selected' : ''}`} onClick={() => setHorizon(7)}>Cette semaine</button>
          <button className={`chip ${horizon === 'mois' ? 'selected' : ''}`} onClick={() => setHorizon('mois')}>Jusqu'à la fin du mois</button>
        </div>
        <div className="chips">
          <button className={`chip ${grouping === 'categorie' ? 'selected' : ''}`} onClick={() => setGrouping('categorie')}>Par catégorie</button>
          <button className={`chip ${grouping === 'magasin' ? 'selected' : ''}`} onClick={() => setGrouping('magasin')}>Par magasin</button>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><div className="label">Liste estimée</div><div className="value">{eur(total)}</div><div className="hint">{fits.length} article{fits.length > 1 ? 's' : ''}</div></div>
        <div className="kpi"><div className="label">Budget disponible</div><div className="value">{eur(available)}</div><div className="hint">{horizon === 7 ? 'pour 7 jours' : `pour les ${daysLeft} jours restants`}</div></div>
        <div className="kpi"><div className="label">Reste à acheter</div><div className="value">{eur(remainingToBuy)}</div></div>
      </div>

      {!fits.length && !extra.length && (
        <p className="alert info">Rien à proposer pour l'instant : il faut au moins deux achats d'un même article pour connaître son rythme.</p>
      )}

      {grouping === 'categorie'
        ? plans.filter((p) => p.fits.length).map((p) => (
          <section key={p.category.id} className="card">
            <div className="spread">
              <h2>{p.category.name}</h2>
              <span className="small ink2 num">
                {eur(p.total)}{Number.isFinite(p.available) && <> / {eur(p.available)}</>}
              </span>
            </div>
            {p.fits.map((s) => row(s))}
          </section>
        ))
        : [...byStore].sort((a, b) => b[1].length - a[1].length).map(([store, list]) => (
          <section key={store} className="card">
            <div className="spread"><h2>{store}</h2><span className="small ink2 num">{eur(list.reduce((a, s) => a + s.estimate, 0))}</span></div>
            {list.map((s) => row(s))}
          </section>
        ))}

      {extra.length > 0 && (
        <section className="card">
          <button className="btn-ghost" style={{ padding: 0 }} onClick={() => setShowExtra((v) => !v)}>
            {showExtra ? '▾' : '▸'} Si le budget le permet ({extra.length} article{extra.length > 1 ? 's' : ''}, ≈ {eur(extra.reduce((a, s) => a + s.estimate, 0))})
          </button>
          {showExtra && extra.map((s) => row(s, true))}
        </section>
      )}

      {checked.size > 0 && (
        <button className="btn-ghost" onClick={() => { setChecked(new Set()); try { localStorage.removeItem(CHECK_KEY(period)) } catch { /* ignoré */ } }}>
          Tout décocher
        </button>
      )}
      <Link to="/saisie" className="btn btn-primary btn-big btn-block">+ Encoder un achat</Link>
    </div>
  )
}
