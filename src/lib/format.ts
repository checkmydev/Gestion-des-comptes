const eurFmt = new Intl.NumberFormat('fr-BE', { style: 'currency', currency: 'EUR' })
const numFmt = new Intl.NumberFormat('fr-BE', { maximumFractionDigits: 2 })

export const MONTHS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]

export function eur(n: number | null | undefined): string {
  return eurFmt.format(Number(n ?? 0))
}

export function num(n: number | null | undefined): string {
  return n == null ? '' : numFmt.format(Number(n))
}

export function pct(n: number): string {
  const s = new Intl.NumberFormat('fr-BE', { maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(n)
  return `${s} %`
}

/** Accepte « 1,72 », « 1.72 » ou « 2*2,15 » (petites opérations comme dans Excel). */
export function parseAmount(input: string): number | null {
  const s = input.trim().replace(/,/g, '.').replace(/\s/g, '')
  if (!s) return null
  if (!/^[0-9.+\-*/()]+$/.test(s)) return null
  try {
    const v = Function(`"use strict"; return (${s})`)() as unknown
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null
  } catch {
    return null
  }
}

/** « 2026-10-05 » → « 5/10 » (format utilisé dans les fichiers Excel). */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [, m, d] = iso.split('-')
  return `${Number(d)}/${Number(m)}`
}

export function longDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${Number(d)}/${Number(m)}/${y}`
}

export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Colonne « Magasin + date » demandée pour les statistiques (ex. « Delhaize 5/10 »). */
export function storeDate(store: string | undefined, date: string | null): string {
  return [store, shortDate(date)].filter(Boolean).join(' ')
}
