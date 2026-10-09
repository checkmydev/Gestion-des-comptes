import { useCallback, useEffect, useState, type ComponentProps } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Loading } from '../components/Layout'
import { FormModal } from '../components/Modal'
import { deleteRow, ensureMonth, loadLedger, saveRow, setOpeningBalance, type Ledger } from '../lib/api'
import { useApp } from '../lib/app'
import { budgetStatus, categoryAverage, categoryTotal, projectSpending, remainingShare, summarize } from '../lib/budget'
import { eur } from '../lib/format'
import { addMonths, cycleLabel, periodLabel } from '../lib/period'
import type { MonthlyLine, Section } from '../lib/types'
import { AnnualTab, FuelTab, SavingsTab } from './GlobalTabs'

export type FormSpec = Omit<ComponentProps<typeof FormModal>, 'onClose'>

const TABS = [
  { id: 'mois', label: 'Mois' },
  { id: 'essence', label: 'Essence' },
  { id: 'annuels', label: 'Annuels' },
  { id: 'epargne', label: 'Épargne' },
] as const

export default function Global() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'mois'
  const [form, setForm] = useState<FormSpec | null>(null)

  return (
    <div className="stack">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''}
            onClick={() => setParams({ tab: t.id }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'mois' && <MonthTab openForm={setForm} />}
      {tab === 'essence' && <FuelTab openForm={setForm} />}
      {tab === 'annuels' && <AnnualTab openForm={setForm} />}
      {tab === 'epargne' && <SavingsTab openForm={setForm} />}
      {form && <FormModal {...form} onClose={() => setForm(null)} />}
    </div>
  )
}

const lineFields = (section: Section): FormSpec['fields'] => [
  { key: 'label', label: 'Libellé', type: 'text', required: true },
  { key: 'amount', label: 'Montant (€)', type: 'amount', required: true },
  { key: 'note', label: section === 'revenu' ? 'Motif / remarque' : 'Remarque', type: 'text' },
  { key: 'carry_over', label: 'Recopier ce montant le mois suivant', type: 'checkbox' },
]

function MonthTab({ openForm }: { openForm: (f: FormSpec) => void }) {
  const { period, categories } = useApp()
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      let l = await loadLedger()
      if (await ensureMonth(period, l)) l = await loadLedger()
      setLedger(l)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [period])

  useEffect(() => { setLedger(null); void refresh() }, [refresh])

  if (error) return <p className="error">{error}</p>
  if (!ledger) return <Loading />

  const s = summarize(ledger, period)
  const prev = summarize(ledger, addMonths(period, -1))
  const lines = ledger.lines.filter((l) => l.period === period)
  const inProgress = remainingShare(period) > 0
  const projected = (categoryId: number) =>
    projectSpending(s.courantByCategory.get(categoryId) ?? 0, categoryAverage(ledger, categoryId, period), period)

  const editLine = (section: Section, line?: MonthlyLine) => openForm({
    title: line ? line.label : section === 'revenu' ? 'Nouvelle rentrée' : 'Nouvelle dépense fixe',
    fields: lineFields(section),
    initial: line ?? { carry_over: section === 'fixe' },
    onSave: async (v) => {
      await saveRow('monthly_lines', { ...v, period, section, sort_order: line?.sort_order ?? lines.length }, line?.id)
      await refresh()
    },
    onDelete: line ? async () => { await deleteRow('monthly_lines', line.id); await refresh() } : undefined,
  })

  const editOpening = () => openForm({
    title: `Solde fin ${periodLabel(addMonths(period, -1))}`,
    fields: [
      { key: 'opening_balance', label: 'Montant (€)', type: 'amount', hint: 'Laisser vide pour reprendre automatiquement le solde calculé du mois précédent.' },
    ],
    initial: { opening_balance: s.previousBalanceForced ? s.previousBalance : null },
    onSave: async (v) => { await setOpeningBalance(period, v.opening_balance as number | null); await refresh() },
  })

  const section = (sec: Section) => lines.filter((l) => l.section === sec).map((l) => (
    <tr key={l.id} className="clickable" onClick={() => editLine(sec, l)}>
      <td>{l.label}{l.note && <div className="muted small">{l.note}</div>}</td>
      <td className="num">{eur(l.amount)}</td>
    </tr>
  ))

  const courantCats = categories.filter((c) => !c.archived || s.courantByCategory.has(c.id))

  return (
    <>
      <div>
        <h1 className="capitalize">Global — {periodLabel(period)}</h1>
        <div className="muted small">{cycleLabel(period)}</div>
      </div>

      <section className="card">
        <h2>Rentrées</h2>
        <table>
          <tbody>
            {section('revenu')}
            <tr className="clickable" onClick={editOpening}>
              <td>
                Solde fin {periodLabel(addMonths(period, -1))}
                <div className="muted small">{s.previousBalanceForced ? 'saisi manuellement' : 'automatique'}</div>
              </td>
              <td className="num">{eur(s.previousBalance)}</td>
            </tr>
          </tbody>
          <tfoot><tr><td>Solde début de mois</td><td className="num">{eur(s.opening)}</td></tr></tfoot>
        </table>
        <button className="btn-ghost" onClick={() => editLine('revenu')}>+ Ajouter une rentrée</button>
      </section>

      <section className="card">
        <h2>Dépenses fixes</h2>
        <table>
          <tbody>
            {section('fixe')}
            <tr>
              <td><Link to="/global?tab=essence">Essence</Link> <span className="muted small">(pleins du mois)</span></td>
              <td className="num">{eur(s.fuel)}</td>
            </tr>
          </tbody>
          <tfoot><tr><td>Total fixes</td><td className="num">{eur(s.fixes + s.fuel)}</td></tr></tfoot>
        </table>
        <button className="btn-ghost" onClick={() => editLine('fixe')}>+ Ajouter une dépense fixe</button>
      </section>

      <section className="card">
        <h2>Dépenses courantes</h2>
        <p className="muted small">Totaux de chaque catégorie du <Link to="/detail">détail du mois</Link>.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Catégorie</th><th className="num">Ce mois</th><th className="num">Mois préc.</th></tr></thead>
            <tbody>
              {courantCats.map((c) => {
                const v = s.courantByCategory.get(c.id) ?? 0
                const st = budgetStatus(projected(c.id), c.monthly_budget)
                return (
                  <tr key={c.id}>
                    <td>
                      {c.name}{' '}
                      {st && st !== 'ok' && <span className={`badge ${st}`}>{st === 'over' ? 'dépasse le budget' : 'proche du budget'}</span>}
                    </td>
                    <td className="num">{eur(v)}</td>
                    <td className="num muted">{eur(categoryTotal(ledger, c.id, addMonths(period, -1)))}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot><tr><td>Total</td><td className="num">{eur(s.courant)}</td><td className="num muted">{eur(prev.courant)}</td></tr></tfoot>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="muted small">Solde en fin de mois{inProgress ? ' (à ce jour)' : ''}</div>
        <div className={`hero ${s.end < 0 ? 'up' : ''}`}>{eur(s.end)}</div>
        {inProgress && (
          <p className="small ink2">
            En ajoutant les dépenses habituelles des jours restants (moyenne des 3 derniers mois), le solde en fin de mois serait d'environ{' '}
            <strong>{eur(s.opening - s.fixes - s.fuel - courantCats.reduce((a, c) => a + projected(c.id), 0))}</strong>.
          </p>
        )}
      </section>
    </>
  )
}
