import { useCallback, useEffect, useState } from 'react'
import { Loading } from '../components/Layout'
import { deleteRow, insertRow, must, saveRow } from '../lib/api'
import { useApp } from '../lib/app'
import { eur, longDate, MONTHS, num, shortDate, todayIso } from '../lib/format'
import { parsePeriod, periodForDate, periodLabel } from '../lib/period'
import { supabase } from '../lib/supabase'
import type { AnnualPayment, AnnualProvision, FuelFill, SavingsMovement, Trip } from '../lib/types'
import type { FormSpec } from './Global'

type TabProps = { openForm: (f: FormSpec) => void }

function useLoader<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try { setData(await load()) } catch (e) { setError((e as Error).message) }
  }, [load])
  useEffect(() => { setData(null); void refresh() }, [refresh])
  return { data, error, refresh }
}

// ---------------------------------------------------------------------------
// Essence : pleins et trajets extra
// ---------------------------------------------------------------------------

export function FuelTab({ openForm }: TabProps) {
  const { period } = useApp()
  const load = useCallback(async () => {
    const [fills, trips] = await Promise.all([
      supabase.from('fuel_fills').select('*').order('filled_on', { ascending: true, nullsFirst: false }).order('id'),
      supabase.from('trips').select('*').eq('period', period).order('trip_date').order('id'),
    ])
    return { fills: must(fills) as FuelFill[], trips: must(trips) as Trip[] }
  }, [period])
  const { data, error, refresh } = useLoader(load)

  if (error) return <p className="error">{error}</p>
  if (!data) return <Loading />

  // Δ km et consommation : comparés au plein précédent (tous mois confondus).
  const enriched = data.fills.map((f, i) => {
    const prev = data.fills.slice(0, i).reverse().find((x) => x.km != null)
    const delta = f.km != null && prev?.km != null ? Number(f.km) - Number(prev.km) : null
    const litres = f.price_per_litre ? Number(f.total) / Number(f.price_per_litre) : null
    const per100 = delta && delta > 0 && litres ? (litres / delta) * 100 : null
    return { ...f, delta, per100 }
  })
  const fills = enriched.filter((f) => f.period === period)
  const stations = [...new Set(data.fills.map((f) => f.station))]
  const totalKm = data.trips.reduce((a, t) => a + Number(t.km_round_trip), 0)

  const editFill = (f?: FuelFill) => openForm({
    title: f ? 'Plein d\'essence' : 'Nouveau plein',
    fields: [
      { key: 'station', label: 'Station', type: 'text', required: true, placeholder: stations[0] ?? 'Shell Bierges' },
      { key: 'filled_on', label: 'Date', type: 'date' },
      { key: 'price_per_litre', label: '€/litre', type: 'amount' },
      { key: 'km', label: 'Compteur (km)', type: 'number' },
      { key: 'total', label: 'Total payé (€)', type: 'amount', required: true },
    ],
    initial: f ?? { filled_on: todayIso(), station: stations[stations.length - 1] ?? '' },
    // le plein est compté dans le mois de sa date (le mois commence le 26)
    onSave: async (v) => { await saveRow('fuel_fills', { ...v, period: v.filled_on ? periodForDate(String(v.filled_on)) : period }, f?.id); await refresh() },
    onDelete: f ? async () => { await deleteRow('fuel_fills', f.id); await refresh() } : undefined,
  })

  const editTrip = (t?: Trip) => openForm({
    title: t ? 'Trajet' : 'Nouveau trajet extra',
    fields: [
      { key: 'label', label: 'Où & quoi ?', type: 'text', required: true },
      { key: 'trip_date', label: 'Quand', type: 'date' },
      { key: 'km_round_trip', label: 'Km aller-retour', type: 'number', required: true },
    ],
    initial: t ?? { trip_date: todayIso() },
    onSave: async (v) => { await saveRow('trips', { ...v, period: v.trip_date ? periodForDate(String(v.trip_date)) : period }, t?.id); await refresh() },
    onDelete: t ? async () => { await deleteRow('trips', t.id); await refresh() } : undefined,
  })

  return (
    <>
      <section className="card">
        <h2 className="capitalize">Pleins d'essence — {periodLabel(period)}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Station</th><th>Date</th><th className="num">€/l</th><th className="num">km</th><th className="num">Δ km</th><th className="num">Total</th></tr>
            </thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => editFill(f)}>
                  <td>{f.station}</td>
                  <td>{shortDate(f.filled_on)}</td>
                  <td className="num">{num(f.price_per_litre)}</td>
                  <td className="num">{num(f.km)}</td>
                  <td className="num">
                    {f.delta != null && num(f.delta)}
                    {f.per100 != null && <div className="muted small">{num(Math.round(f.per100 * 10) / 10)} l/100</div>}
                  </td>
                  <td className="num">{eur(f.total)}</td>
                </tr>
              ))}
              {!fills.length && <tr><td colSpan={6} className="muted">Aucun plein ce mois-ci.</td></tr>}
            </tbody>
            <tfoot>
              <tr><td colSpan={5}>Total essence (repris dans le Global)</td><td className="num">{eur(fills.reduce((a, f) => a + Number(f.total), 0))}</td></tr>
            </tfoot>
          </table>
        </div>
        <button className="btn-ghost" onClick={() => editFill()}>+ Ajouter un plein</button>
      </section>

      <section className="card">
        <h2>Essence : trajets extra</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Où & quoi ?</th><th>Quand</th><th className="num">Km A/R</th></tr></thead>
            <tbody>
              {data.trips.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => editTrip(t)}>
                  <td>{t.label}</td><td>{shortDate(t.trip_date)}</td><td className="num">{num(t.km_round_trip)}</td>
                </tr>
              ))}
              {!data.trips.length && <tr><td colSpan={3} className="muted">Aucun trajet extra ce mois-ci.</td></tr>}
            </tbody>
            <tfoot><tr><td colSpan={2}>Total km</td><td className="num">{num(totalKm)}</td></tr></tfoot>
          </table>
        </div>
        <button className="btn-ghost" onClick={() => editTrip()}>+ Ajouter un trajet</button>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Provisions pour dépenses annuelles
// ---------------------------------------------------------------------------

const MONTH_OPTIONS = [{ value: '', label: '—' }, ...MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))]

export function AnnualTab({ openForm }: TabProps) {
  const { period, settings } = useApp()
  const { year, month } = parsePeriod(period)
  const load = useCallback(async () => {
    const provisions = must(await supabase.from('annual_provisions').select('*').in('year', [year, year - 1])
      .order('sort_order').order('id')) as AnnualProvision[]
    const ids = provisions.filter((p) => p.year === year).map((p) => p.id)
    const payments = ids.length
      ? must(await supabase.from('annual_payments').select('*').in('provision_id', ids).order('paid_on')) as AnnualPayment[]
      : []
    return { provisions, payments }
  }, [year])
  const { data, error, refresh } = useLoader(load)

  if (error) return <p className="error">{error}</p>
  if (!data) return <Loading />

  const provisions = data.provisions.filter((p) => p.year === year)
  const lastYear = data.provisions.filter((p) => p.year === year - 1)
  const paidBy = (id: number, inMonth = false) => data.payments
    .filter((x) => x.provision_id === id && (!inMonth || periodForDate(x.paid_on) === period))
    .reduce((a, x) => a + Number(x.amount), 0)
  const estimated = provisions.reduce((a, p) => a + Number(p.annual_amount), 0)
  const paidYear = data.payments.reduce((a, x) => a + Number(x.amount), 0)
  const paidMonth = data.payments.filter((x) => periodForDate(x.paid_on) === period).reduce((a, x) => a + Number(x.amount), 0)
  const remainingBudget = settings.annual_budget - paidYear
  const upcoming = provisions.filter((p) => p.due_month != null && p.due_month >= month && paidBy(p.id) < Number(p.annual_amount))

  async function copyLastYear() {
    for (const p of lastYear) {
      await insertRow('annual_provisions', { year, label: p.label, annual_amount: p.annual_amount, due_month: p.due_month, sort_order: p.sort_order })
    }
    await refresh()
  }

  const editProvision = (p?: AnnualProvision) => openForm({
    title: p ? p.label : 'Nouveau poste annuel',
    fields: [
      { key: 'label', label: 'Poste', type: 'text', required: true },
      { key: 'annual_amount', label: 'Montant annuel estimé (€)', type: 'amount', required: true, hint: 'ex. 186*4 pour un trimestriel' },
      { key: 'due_month', label: 'Mois d\'échéance habituel', type: 'select', options: MONTH_OPTIONS },
    ],
    initial: p ? { ...p, due_month: p.due_month ?? '' } : {},
    onSave: async (v) => {
      await saveRow('annual_provisions', {
        ...v, year, due_month: v.due_month ? Number(v.due_month) : null, sort_order: p?.sort_order ?? provisions.length,
      }, p?.id)
      await refresh()
    },
    onDelete: p ? async () => { await deleteRow('annual_provisions', p.id); await refresh() } : undefined,
  })

  const editPayment = (prov: AnnualProvision, pay?: AnnualPayment) => openForm({
    title: `Paiement — ${prov.label}`,
    fields: [
      { key: 'paid_on', label: 'Date de paiement', type: 'date', required: true },
      { key: 'amount', label: 'Montant payé (€)', type: 'amount', required: true },
      { key: 'note', label: 'Remarque', type: 'text', placeholder: 'ex. Trim 4' },
      ...(pay ? [] : [{ key: 'from_savings', label: 'Payé depuis le compte épargne', type: 'checkbox' as const, hint: 'ajoute aussi la dépense dans l\'onglet Épargne' }]),
    ],
    initial: pay ?? { paid_on: todayIso(), from_savings: true },
    onSave: async ({ from_savings, ...v }) => {
      await saveRow('annual_payments', { ...v, provision_id: prov.id }, pay?.id)
      if (from_savings) {
        await insertRow('savings_movements', { moved_on: v.paid_on, label: prov.label, amount: -Number(v.amount), note: v.note })
      }
      await refresh()
    },
    onDelete: pay ? async () => { await deleteRow('annual_payments', pay.id); await refresh() } : undefined,
  })

  return (
    <>
      <div className="kpis">
        <div className="kpi"><div className="label">Total annuel estimé {year}</div><div className="value">{eur(estimated)}</div><div className="hint">soit {eur(estimated / 12)} à mettre de côté par mois</div></div>
        <div className="kpi"><div className="label">Payé ce mois-ci</div><div className="value">{eur(paidMonth)}</div></div>
        <div className="kpi"><div className="label">Payé depuis janvier</div><div className="value">{eur(paidYear)}</div></div>
        <div className="kpi">
          <div className="label">Reste sur le plafond de {eur(settings.annual_budget)}</div>
          <div className={`value ${remainingBudget < 0 ? 'up' : ''}`}>{eur(remainingBudget)}</div>
        </div>
      </div>

      {upcoming.length > 0 && (
        <div className="alert info">
          <strong>À venir :</strong>{' '}
          {upcoming.map((p) => `${p.label} (${MONTHS[p.due_month! - 1]}, ~${eur(Number(p.annual_amount) - paidBy(p.id))})`).join(' · ')}
        </div>
      )}

      <section className="card">
        <h2>Postes annuels {year}</h2>
        {!provisions.length && lastYear.length > 0 && (
          <button className="btn-primary" onClick={copyLastYear}>Reprendre les {lastYear.length} postes de {year - 1}</button>
        )}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Poste</th><th className="num">Annuel</th><th className="num">Payé {year}</th><th></th></tr></thead>
            <tbody>
              {provisions.map((p) => {
                const pays = data.payments.filter((x) => x.provision_id === p.id)
                return (
                  <tr key={p.id}>
                    <td>
                      <button className="btn-ghost" style={{ padding: 0, minHeight: 0 }} onClick={() => editProvision(p)}>{p.label}</button>
                      {p.due_month && <span className="muted small"> · {MONTHS[p.due_month - 1]}</span>}
                      {pays.map((x) => (
                        <div key={x.id} className="small ink2 clickable" style={{ cursor: 'pointer' }} onClick={() => editPayment(p, x)}>
                          {longDate(x.paid_on)} : {eur(x.amount)}{x.note && ` — ${x.note}`}
                        </div>
                      ))}
                    </td>
                    <td className="num">{eur(p.annual_amount)}</td>
                    <td className="num">{eur(paidBy(p.id))}</td>
                    <td className="num"><button className="btn-ghost small" onClick={() => editPayment(p)}>+ payé</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <button className="btn-ghost" onClick={() => editProvision()}>+ Ajouter un poste</button>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Compte épargne
// ---------------------------------------------------------------------------

export function SavingsTab({ openForm }: TabProps) {
  const { settings } = useApp()
  const load = useCallback(async () =>
    must(await supabase.from('savings_movements').select('*').order('moved_on').order('id')) as SavingsMovement[], [])
  const { data, error, refresh } = useLoader(load)

  if (error) return <p className="error">{error}</p>
  if (!data) return <Loading />

  let running = 0
  const rows = data.map((m) => ({ ...m, balance: (running += Number(m.amount)) })).reverse()
  const balance = running
  const target = settings.emergency_target

  const edit = (m?: SavingsMovement) => openForm({
    title: m ? m.label : 'Mouvement d\'épargne',
    fields: [
      { key: 'moved_on', label: 'Date', type: 'date', required: true },
      { key: 'label', label: 'Libellé', type: 'text', required: true, placeholder: 'ex. Transfert vers compte courant' },
      { key: 'amount', label: 'Montant (€)', type: 'amount', required: true, hint: 'positif = apport, négatif = dépense ou transfert vers le compte courant' },
      { key: 'note', label: 'Remarque', type: 'text' },
    ],
    initial: m ?? { moved_on: todayIso() },
    onSave: async (v) => { await saveRow('savings_movements', v, m?.id); await refresh() },
    onDelete: m ? async () => { await deleteRow('savings_movements', m.id); await refresh() } : undefined,
  })

  return (
    <>
      <section className="card">
        <div className="muted small">Solde du compte épargne</div>
        <div className="hero">{eur(balance)}</div>
        <div className="small ink2">
          Réserve « imprévus » visée : {eur(target)}
          <div className="meter"><span className={balance < target ? 'warn' : ''} style={{ width: `${Math.max(0, Math.min(100, (balance / target) * 100))}%` }} /></div>
        </div>
      </section>
      <section className="card">
        <div className="spread"><h2>Mouvements</h2><button className="btn-primary" onClick={() => edit()}>+ Ajouter</button></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Libellé</th><th className="num">Montant</th><th className="num">Solde</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="clickable" onClick={() => edit(m)}>
                  <td>{longDate(m.moved_on)}</td>
                  <td>{m.label}{m.note && <div className="muted small">{m.note}</div>}</td>
                  <td className={`num ${Number(m.amount) < 0 ? 'up' : 'down'}`}>{eur(m.amount)}</td>
                  <td className="num">{eur(m.balance)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={4} className="muted">Aucun mouvement.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
