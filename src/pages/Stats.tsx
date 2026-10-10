import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ColumnChart } from '../components/ColumnChart'
import { Loading } from '../components/Layout'
import { loadLedger, must, updateRow, type Ledger } from '../lib/api'
import { useApp } from '../lib/app'
import { categoryAverage, categoryTotal, statsStart, summarize } from '../lib/budget'
import { eur, MONTHS, parseAmount, pct } from '../lib/format'
import { addMonths, parsePeriod, periodLabel } from '../lib/period'
import { supabase } from '../lib/supabase'

/** Arrondi d'une moyenne à 5 € au-dessus : base de budget proposée. */
const suggest = (avg: number | null) => (avg ? Math.ceil(avg / 5) * 5 : null)

export default function Stats() {
  const { period, categories, reload } = useApp()
  const { year } = parsePeriod(period)
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [annualEstimate, setAnnualEstimate] = useState(0)
  const [selected, setSelected] = useState<number | 'all'>('all')
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([loadLedger(), supabase.from('annual_provisions').select('annual_amount').eq('year', year)])
      .then(([l, prov]) => {
        setLedger(l)
        setAnnualEstimate((must(prov) as { annual_amount: number }[]).reduce((a, p) => a + Number(p.annual_amount), 0))
      })
      .catch((e) => setError((e as Error).message))
  }, [year])

  if (error) return <p className="error">{error}</p>
  if (!ledger) return <Loading />

  const active = categories.filter((c) => !c.archived)
  const months = Array.from({ length: 12 }, (_, i) => addMonths(period, i - 11))
  // Premier mois des statistiques (réglage « Statistiques à partir de »)
  const firstData = statsStart(ledger)
  const visibleMonths = months.filter((p) => firstData !== null && p >= firstData)
  const selCat = selected === 'all' ? null : categories.find((c) => c.id === selected)
  const valueOf = (p: string) => (selCat ? categoryTotal(ledger, selCat.id, p) : summarize(ledger, p).courant)
  const columns = visibleMonths.map((p) => {
    const { month, year: y } = parsePeriod(p)
    return { key: periodLabel(p), label: `${MONTHS[month - 1].slice(0, 3)}${month === 1 ? ` ${String(y).slice(2)}` : ''}`, value: valueOf(p), highlight: p === period }
  })
  const reference = selCat
    ? selCat.monthly_budget
    : active.reduce((a, c) => a + Number(c.monthly_budget ?? 0), 0) || null

  // Prévision annuelle : moyennes des 6 derniers mois complets + provisions annuelles.
  const last6 = Array.from({ length: 6 }, (_, i) => addMonths(period, -(i + 1))).filter((p) => firstData !== null && p >= firstData)
  const avg = (f: (p: string) => number) => (last6.length ? last6.reduce((a, p) => a + f(p), 0) / last6.length : 0)
  const avgCourant = avg((p) => summarize(ledger, p).courant)
  const avgFuel = avg((p) => summarize(ledger, p).fuel)
  // Rentrées et dépenses fixes reviennent chaque mois : on prend le dernier mois où elles sont encodées.
  const linesPeriod = ledger.lines.filter((l) => l.period <= period)
    .reduce<string | null>((m, l) => (m === null || l.period > m ? l.period : m), null)
  const ref = linesPeriod ? summarize(ledger, linesPeriod) : null
  const monthlyRevenus = ref?.revenus ?? 0
  const monthlyFixes = ref?.fixes ?? 0
  const yearlyOut = (avgCourant + monthlyFixes + avgFuel) * 12 + annualEstimate
  const yearlyIn = monthlyRevenus * 12
  const margin = yearlyIn - yearlyOut

  async function saveBudget(categoryId: number, value: number | null) {
    try {
      await updateRow('categories', categoryId, { monthly_budget: value })
      setDrafts((d) => { const n = { ...d }; delete n[categoryId]; return n })
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="stack">
      <div className="spread">
        <h1>Analyses</h1>
        <Link to="/inflation" className="btn">Inflation des prix →</Link>
      </div>

      <section className="card">
        <h2>{selCat ? selCat.name : 'Dépenses courantes'} : 12 derniers mois</h2>
        <div className="chips" style={{ marginBottom: 12 }}>
          <button className={`chip ${selected === 'all' ? 'selected' : ''}`} onClick={() => setSelected('all')}>Toutes</button>
          {active.map((c) => (
            <button key={c.id} className={`chip ${selected === c.id ? 'selected' : ''}`} onClick={() => setSelected(c.id)}>{c.name}</button>
          ))}
        </div>
        {columns.length ? <ColumnChart columns={columns} reference={reference} referenceLabel="budget" /> : <p className="muted">Pas encore de données.</p>}
      </section>

      <section className="card">
        <h2>Orienter le budget</h2>
        <p className="muted small">Moyennes des mois précédant {periodLabel(period)}. La suggestion arrondit la moyenne sur 3 mois aux 5 € supérieurs.</p>
        <div className="list">
          {active.map((c) => {
            const a3 = categoryAverage(ledger, c.id, period, 3)
            const a6 = categoryAverage(ledger, c.id, period, 6)
            const cur = categoryTotal(ledger, c.id, period)
            const sug = suggest(a3)
            const draft = drafts[c.id] ?? (c.monthly_budget != null ? String(c.monthly_budget).replace('.', ',') : '')
            const commit = () => {
              if (drafts[c.id] === undefined) return
              const v = drafts[c.id].trim() ? parseAmount(drafts[c.id]) : null
              if (v !== (c.monthly_budget == null ? null : Number(c.monthly_budget))) void saveBudget(c.id, v)
            }
            return (
              <div key={c.id} className="stack" style={{ gap: 6 }}>
                <div className="spread">
                  <strong>{c.name}</strong>
                  {a3 != null && a6 != null && a6 > 0 && Math.abs(a3 / a6 - 1) > 0.1 && (
                    <span className={`small ${a3 > a6 ? 'up' : 'down'}`}>tendance {pct((a3 / a6 - 1) * 100)}</span>
                  )}
                </div>
                <div className="small ink2">
                  Ce mois {eur(cur)} · moy. 3 mois {a3 == null ? '—' : eur(a3)} · moy. 6 mois {a6 == null ? '—' : eur(a6)}
                </div>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <label className="small ink2" htmlFor={`budget-${c.id}`} style={{ whiteSpace: 'nowrap' }}>Budget / mois</label>
                  <input
                    id={`budget-${c.id}`} inputMode="decimal" value={draft} placeholder="aucun"
                    style={{ textAlign: 'right', minHeight: 40, padding: '6px 10px', maxWidth: 120 }}
                    onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                    onBlur={commit}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  />
                  {sug != null && sug !== Number(c.monthly_budget) && (
                    <button className="btn-ghost small" style={{ minHeight: 40, padding: '4px 6px' }} onClick={() => saveBudget(c.id, sug)}>
                      {eur(sug)} ?
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="card">
        <h2>Prévision sur 12 mois</h2>
        <p className="muted small">
          Rentrées et dépenses fixes de {linesPeriod ? periodLabel(linesPeriod) : '—'} (× 12), moyenne des {last6.length} derniers mois pour les dépenses courantes et l'essence, postes annuels {year}.
        </p>
        <table>
          <tbody>
            <tr><td>Rentrées</td><td className="num">{eur(yearlyIn)}</td></tr>
            <tr><td>Dépenses courantes</td><td className="num">{eur(avgCourant * 12)}</td></tr>
            <tr><td>Dépenses fixes et essence</td><td className="num">{eur((monthlyFixes + avgFuel) * 12)}</td></tr>
            <tr><td>Dépenses annuelles estimées</td><td className="num">{eur(annualEstimate)}</td></tr>
          </tbody>
          <tfoot>
            <tr>
              <td>Marge prévue sur l'année</td>
              <td className={`num ${margin < 0 ? 'up' : 'down'}`}>{eur(margin)}</td>
            </tr>
          </tfoot>
        </table>
        <p className="small ink2" style={{ marginTop: 8 }}>
          {margin < 0
            ? <>À ce rythme, il manquerait environ <strong>{eur(-margin / 12)}</strong> par mois : à prendre sur l'épargne ou à économiser.</>
            : <>À ce rythme, environ <strong>{eur(margin / 12)}</strong> par mois peuvent aller à la réserve « imprévus ».</>}
        </p>
      </section>
    </div>
  )
}
