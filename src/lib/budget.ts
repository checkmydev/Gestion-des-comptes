import type { Ledger } from './api'
import { addMonths, currentPeriod, cycleDays } from './period'

export interface MonthSummary {
  period: string
  /** Solde du compte à la fin du mois précédent (automatique ou forcé). */
  previousBalance: number
  previousBalanceForced: boolean
  revenus: number
  /** Revenus + solde précédent = « Solde début de mois » de l'Excel. */
  opening: number
  fixes: number
  fuel: number
  /** Total des blocs du détail (alimentaire, divers, médocs…). */
  courant: number
  courantByCategory: Map<number, number>
  /** Solde en fin de mois. */
  end: number
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + Number(b), 0)

function earliestPeriod(ledger: Ledger): string | null {
  return [
    ...ledger.months.map((m) => m.period),
    ...ledger.lines.map((l) => l.period),
    ...ledger.totals.map((t) => t.period),
  ].reduce<string | null>((min, p) => (min === null || p < min ? p : min), null)
}

// ---------------------------------------------------------------------------
// Début des statistiques (Paramètres) : les mois plus anciens restent consultables
// mais ne comptent plus dans les moyennes, tendances, inflation et liste de courses.
// ---------------------------------------------------------------------------
let STATS_FROM: string | null = null
export function setStatsFrom(p: string | null) { STATS_FROM = p && /^\d{4}-\d{2}-01$/.test(p) ? p : null }
export const statsFrom = () => STATS_FROM
/** Ce mois compte-t-il dans les statistiques ? */
export const inStats = (period: string) => STATS_FROM === null || period >= STATS_FROM

/** Premier mois pris en compte par les statistiques. */
export function statsStart(ledger: Ledger): string | null {
  const first = earliestPeriod(ledger)
  if (first === null) return null
  return STATS_FROM && STATS_FROM > first ? STATS_FROM : first
}

export function summarize(ledger: Ledger, period: string): MonthSummary {
  const first = earliestPeriod(ledger)
  const memo = new Map<string, MonthSummary>()
  const compute = (p: string): MonthSummary => {
    const cached = memo.get(p)
    if (cached) return cached
    const month = ledger.months.find((m) => m.period === p)
    const forced = month?.opening_balance != null
    const previousBalance = forced
      ? Number(month!.opening_balance)
      : first && p > first ? compute(addMonths(p, -1)).end : 0
    const lines = ledger.lines.filter((l) => l.period === p)
    const revenus = sum(lines.filter((l) => l.section === 'revenu').map((l) => l.amount))
    const fixes = sum(lines.filter((l) => l.section === 'fixe').map((l) => l.amount))
    const fuel = sum(ledger.fuel.filter((f) => f.period === p).map((f) => f.total))
    const courantByCategory = new Map<number, number>()
    for (const t of ledger.totals) if (t.period === p) courantByCategory.set(t.category_id, t.total)
    const courant = sum([...courantByCategory.values()])
    const opening = previousBalance + revenus
    const s: MonthSummary = {
      period: p, previousBalance, previousBalanceForced: forced, revenus, opening,
      fixes, fuel, courant, courantByCategory, end: opening - fixes - fuel - courant,
    }
    memo.set(p, s)
    return s
  }
  return compute(period)
}

/** Total d'une catégorie pour un mois. */
export function categoryTotal(ledger: Ledger, categoryId: number, period: string): number {
  return ledger.totals.find((t) => t.period === period && t.category_id === categoryId)?.total ?? 0
}

/**
 * Moyenne mensuelle d'une catégorie sur les `n` mois précédant `period`
 * (les mois sans achat comptent pour 0, mais on ne remonte pas avant le
 * premier mois encodé).
 */
export function categoryAverage(ledger: Ledger, categoryId: number, period: string, n = 3): number | null {
  const first = statsStart(ledger)
  const periods = Array.from({ length: n }, (_, i) => addMonths(period, -(i + 1)))
    .filter((p) => first !== null && p >= first)
  if (!periods.length) return null
  return sum(periods.map((p) => categoryTotal(ledger, categoryId, p))) / periods.length
}

/**
 * Part du mois comptable (du 26 au 25) qui reste à venir : 0 pour un mois
 * terminé, 1 pour un mois futur, entre les deux pour le mois en cours.
 */
export function remainingShare(period: string, today = new Date()): number {
  const current = currentPeriod(today)
  if (period < current) return 0
  if (period > current) return 1
  const { total, left } = cycleDays(period, today)
  return (left - 1) / total
}

/**
 * Projection de fin de mois : ce qui est déjà dépensé + la moyenne habituelle
 * pour les jours restants. Plus prudente qu'une simple extrapolation linéaire,
 * qui exagère en début de mois (achats de fin de mois précédent comptés sur
 * le mois en cours, gros achat ponctuel…). Sans historique, on extrapole.
 */
export function projectSpending(spent: number, average: number | null, period: string, today = new Date()): number {
  const rest = remainingShare(period, today)
  if (rest === 0) return spent
  if (average != null) return spent + average * rest
  const elapsed = 1 - rest
  return elapsed > 0.1 ? spent / elapsed : spent
}

export type BudgetLevel = 'ok' | 'warn' | 'over'

export function budgetStatus(spent: number, budget: number | null): BudgetLevel | null {
  if (!budget) return null
  if (spent > budget) return 'over'
  if (spent > budget * 0.85) return 'warn'
  return 'ok'
}
