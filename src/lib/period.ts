import { MONTHS } from './format'

/**
 * Le mois comptable commence le 26 (jour de paiement de la pension) :
 * « octobre » va du 26 septembre au 25 octobre. Un mois est stocké comme
 * « AAAA-MM-01 » (ici 2026-10-01).
 */
export const CYCLE_START_DAY = 26

export function makePeriod(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

export function parsePeriod(p: string): { year: number; month: number } {
  const [y, m] = p.split('-').map(Number)
  return { year: y, month: m }
}

export function addMonths(p: string, delta: number): string {
  const { year, month } = parsePeriod(p)
  const idx = year * 12 + (month - 1) + delta
  return makePeriod(Math.floor(idx / 12), (idx % 12) + 1)
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Mois comptable d'une date : à partir du 26, c'est déjà le mois suivant. */
export function periodForDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const p = makePeriod(y, m)
  return d >= CYCLE_START_DAY ? addMonths(p, 1) : p
}

export function currentPeriod(today = new Date()): string {
  return periodForDate(isoOf(today))
}

/** Premier et dernier jour du mois comptable (ex. octobre : 2026-09-26 → 2026-10-25). */
export function cycleBounds(p: string): { start: string; end: string } {
  const prev = parsePeriod(addMonths(p, -1))
  const cur = parsePeriod(p)
  return {
    start: `${prev.year}-${pad(prev.month)}-${pad(CYCLE_START_DAY)}`,
    end: `${cur.year}-${pad(cur.month)}-${pad(CYCLE_START_DAY - 1)}`,
  }
}

/** « du 26/9 au 25/10 » */
export function cycleLabel(p: string): string {
  const { start, end } = cycleBounds(p)
  const short = (iso: string) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`
  return `du ${short(start)} au ${short(end)}`
}

export function periodLabel(p: string): string {
  const { year, month } = parsePeriod(p)
  return `${MONTHS[month - 1]} ${year}`
}

const DAY = 864e5
const dayNumber = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY

/** Nombre de jours du mois comptable, et jours restants (aujourd'hui compris). */
export function cycleDays(p: string, today = new Date()): { total: number; left: number } {
  const { start, end } = cycleBounds(p)
  const total = dayNumber(end) - dayNumber(start) + 1
  const t = dayNumber(isoOf(today))
  const left = t < dayNumber(start) ? total : t > dayNumber(end) ? 0 : dayNumber(end) - t + 1
  return { total, left }
}
