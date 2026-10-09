import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { InstallPrompt } from '../components/InstallPrompt'
import { Loading } from '../components/Layout'
import { loadLedger, must, type Ledger } from '../lib/api'
import { useApp } from '../lib/app'
import { budgetStatus, categoryAverage, projectSpending, remainingShare, summarize } from '../lib/budget'
import { eur, MONTHS, pct } from '../lib/format'
import { addMonths, parsePeriod, periodLabel } from '../lib/period'
import { supabase } from '../lib/supabase'
import type { AnnualPayment, AnnualProvision } from '../lib/types'

interface Extra {
  savings: number
  provisions: AnnualProvision[]
  payments: AnnualPayment[]
}

interface Alert { level: 'over' | 'warn' | 'info'; text: string; to?: string }

/** Tableau de bord : où en est le mois, et ce qu'il faut anticiper. */
export default function Accueil() {
  const { period, categories, settings } = useApp()
  const { year, month } = parsePeriod(period)
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [extra, setExtra] = useState<Extra | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLedger(null)
    Promise.all([
      loadLedger(),
      supabase.from('savings_movements').select('amount'),
      supabase.from('annual_provisions').select('*').eq('year', year),
      supabase.from('annual_payments').select('*').gte('paid_on', `${year}-01-01`).lte('paid_on', `${year}-12-31`),
    ]).then(([l, sav, prov, pay]) => {
      setLedger(l)
      setExtra({
        savings: (must(sav) as { amount: number }[]).reduce((a, m) => a + Number(m.amount), 0),
        provisions: must(prov) as AnnualProvision[],
        payments: must(pay) as AnnualPayment[],
      })
    }).catch((e) => setError((e as Error).message))
  }, [year])

  if (error) return <p className="error">{error}</p>
  if (!ledger || !extra) return <Loading />

  const s = summarize(ledger, period)
  const inProgress = remainingShare(period) > 0
  const active = categories.filter((c) => !c.archived)
  const byCategory = active.map((c) => {
    const spent = s.courantByCategory.get(c.id) ?? 0
    const avg = categoryAverage(ledger, c.id, period)
    return { c, spent, avg, projected: projectSpending(spent, avg, period) }
  })
  const projectedCourant = byCategory.reduce((a, x) => a + x.projected, 0)
  const projectedEnd = s.opening - s.fixes - s.fuel - projectedCourant
  const budgetTotal = active.reduce((a, c) => a + Number(c.monthly_budget ?? 0), 0)

  const paidYear = extra.payments.reduce((a, p) => a + Number(p.amount), 0)
  const paidFor = (id: number) => extra.payments.filter((p) => p.provision_id === id).reduce((a, p) => a + Number(p.amount), 0)
  // Échéances annuelles des 3 prochains mois, pas encore (entièrement) payées
  const soon = extra.provisions
    .filter((p) => p.due_month != null && p.due_month >= month && p.due_month <= month + 2)
    .map((p) => ({ ...p, rest: Number(p.annual_amount) - paidFor(p.id) }))
    .filter((p) => p.rest > 0.5)
  const soonTotal = soon.reduce((a, p) => a + p.rest, 0)

  const alerts: Alert[] = []
  for (const { c, spent, avg, projected } of byCategory) {
    const st = budgetStatus(projected, c.monthly_budget)
    if (st === 'over') {
      alerts.push({ level: 'over', text: spent > Number(c.monthly_budget)
        ? `${c.name} : budget de ${eur(c.monthly_budget)} déjà dépassé (${eur(spent)}).`
        : `${c.name} : ${eur(spent)} dépensés, environ ${eur(projected)} prévus en fin de mois (budget ${eur(c.monthly_budget)}).`, to: '/detail' })
    } else if (st === 'warn') {
      alerts.push({ level: 'warn', text: `${c.name} : proche du budget de ${eur(c.monthly_budget)}.`, to: '/detail' })
    } else if (!c.monthly_budget && avg && avg > 10 && spent > avg * 1.1) {
      // Sans budget : on ne signale que le réel, déjà au-dessus de la moyenne habituelle.
      alerts.push({ level: 'warn', text: `${c.name} : déjà ${eur(spent)} dépensés, ${pct((spent / avg - 1) * 100)} par rapport à la moyenne des 3 derniers mois (${eur(avg)}).`, to: '/stats' })
    }
  }
  if (inProgress && projectedEnd < 0) alerts.unshift({ level: 'over', text: `Le solde de fin de mois risque d'être négatif (environ ${eur(projectedEnd)}).`, to: '/global' })
  else if (!inProgress && s.end < 0) alerts.unshift({ level: 'over', text: `Le mois s'est terminé avec un solde négatif (${eur(s.end)}).`, to: '/global' })
  if (soon.length) alerts.push({ level: 'info', text: `À prévoir d'ici ${MONTHS[Math.min(month + 1, 11)]} : ${soon.map((p) => `${p.label} (~${eur(p.rest)})`).join(', ')}.`, to: '/global?tab=annuels' })
  if (extra.savings < settings.emergency_target) alerts.push({ level: 'warn', text: `Épargne sous la réserve « imprévus » visée : il manque ${eur(settings.emergency_target - extra.savings)}.`, to: '/global?tab=epargne' })
  if (paidYear > settings.annual_budget) alerts.push({ level: 'over', text: `Dépenses annuelles ${year} au-delà du plafond de ${eur(settings.annual_budget)} (${eur(paidYear)}).`, to: '/global?tab=annuels' })

  return (
    <div className="stack">
      <InstallPrompt />
      <div className="grid2">
        <Link to="/saisie" className="btn btn-primary btn-big">+ Encoder une dépense</Link>
        <Link to="/courses" className="btn btn-big">🛒 Liste de courses</Link>
      </div>

      <h1 className="capitalize">{periodLabel(period)}</h1>

      <div className="kpis">
        <div className="kpi">
          <div className="label">Dépenses courantes</div>
          <div className="value">{eur(s.courant)}</div>
          <div className="hint">
            {inProgress ? <>≈ {eur(projectedCourant)} prévus en fin de mois</> : <>mois précédent : {eur(summarize(ledger, addMonths(period, -1)).courant)}</>}
          </div>
          {budgetTotal > 0 && (
            <div className="meter" title={`Budget ${eur(budgetTotal)}`}>
              <span className={budgetStatus(projectedCourant, budgetTotal) ?? ''} style={{ width: `${Math.min(100, (s.courant / budgetTotal) * 100)}%` }} />
            </div>
          )}
        </div>
        <div className="kpi">
          <div className="label">Solde fin de mois{inProgress ? ' (prévision)' : ''}</div>
          <div className={`value ${(inProgress ? projectedEnd : s.end) < 0 ? 'up' : ''}`}>{eur(inProgress ? projectedEnd : s.end)}</div>
          <div className="hint">début de mois : {eur(s.opening)}</div>
        </div>
        <div className="kpi">
          <div className="label">Épargne</div>
          <div className="value">{eur(extra.savings)}</div>
          <div className="hint">réserve visée : {eur(settings.emergency_target)}</div>
          <div className="meter"><span className={extra.savings < settings.emergency_target ? 'warn' : ''} style={{ width: `${Math.max(0, Math.min(100, (extra.savings / settings.emergency_target) * 100))}%` }} /></div>
        </div>
        <div className="kpi">
          <div className="label">Dépenses annuelles {year}</div>
          <div className="value">{eur(paidYear)}</div>
          <div className="hint">plafond {eur(settings.annual_budget)}{soonTotal > 0 && <> · {eur(soonTotal)} à venir</>}</div>
          <div className="meter"><span className={budgetStatus(paidYear, settings.annual_budget) ?? ''} style={{ width: `${Math.min(100, (paidYear / settings.annual_budget) * 100)}%` }} /></div>
        </div>
      </div>

      {alerts.length > 0 && (
        <section className="stack" aria-label="Alertes">
          {alerts.map((a, i) => (
            <div key={i} className={`alert ${a.level}`}>
              {a.text} {a.to && <Link to={a.to}>Voir →</Link>}
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <div className="spread"><h2>Par catégorie</h2><Link to="/stats" className="small">Tendances →</Link></div>
        <div className="stack" style={{ gap: 12 }}>
          {byCategory.map(({ c, spent, avg, projected }) => {
            const ref = c.monthly_budget ?? avg
            const st = budgetStatus(projected, c.monthly_budget)
            return (
              <div key={c.id}>
                <div className="spread small">
                  <span>{c.name} {st && st !== 'ok' && <span className={`badge ${st}`}>{st === 'over' ? 'dépassé' : 'attention'}</span>}</span>
                  <span className="num">
                    <strong>{eur(spent)}</strong>
                    {ref ? <span className="muted"> / {eur(ref)}{c.monthly_budget ? '' : ' moy.'}</span> : null}
                  </span>
                </div>
                <div className="meter"><span className={st ?? ''} style={{ width: `${ref ? Math.min(100, (spent / ref) * 100) : spent > 0 ? 100 : 0}%` }} /></div>
              </div>
            )
          })}
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          Barre = dépensé / budget (ou / moyenne des 3 derniers mois si aucun budget n'est fixé). Budgets à régler dans <Link to="/stats">Analyses</Link>.
        </p>
      </section>
    </div>
  )
}
