import { MONTHS } from './format'

/** Un mois comptable est stocké comme « AAAA-MM-01 ». */
export function makePeriod(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

export function currentPeriod(): string {
  const d = new Date()
  return makePeriod(d.getFullYear(), d.getMonth() + 1)
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

export function periodLabel(p: string): string {
  const { year, month } = parsePeriod(p)
  return `${MONTHS[month - 1]} ${year}`
}

export function periodEnd(p: string): string {
  const next = addMonths(p, 1)
  const d = new Date(`${next}T00:00:00Z`)
  d.setUTCDate(0)
  return d.toISOString().slice(0, 10)
}

export function periodOf(isoDate: string): string {
  return isoDate.slice(0, 7) + '-01'
}
