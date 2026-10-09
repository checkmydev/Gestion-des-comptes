import { useMemo, useRef, useState } from 'react'
import { eur, longDate } from '../lib/format'
import type { PricePoint } from '../lib/prices'

interface Series {
  key: string
  label: string
  color: string
  points: PricePoint[]
}

const W = 360
const H = 220
const PAD = { left: 40, right: 10, top: 12, bottom: 24 }

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) { min = min * 0.9; max = max * 1.1 || 1 }
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Math.round(v * 100) / 100)
  return ticks
}

const toTime = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime()
const monthTick = (t: number) => new Date(t).toLocaleDateString('fr-BE', { month: 'short', year: '2-digit', timeZone: 'UTC' })

/**
 * Évolution du prix d'un article : une ligne par magasin (prix payés),
 * des cercles creux pour les prix relevés (recherches de prix).
 */
export function PriceChart({ series }: { series: Series[] }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ p: PricePoint; s: Series; x: number; y: number } | null>(null)

  const all = series.flatMap((s) => s.points)
  const geom = useMemo(() => {
    if (!all.length) return null
    const times = all.map((p) => toTime(p.date))
    let t0 = Math.min(...times)
    let t1 = Math.max(...times)
    if (t0 === t1) { t0 -= 15 * 864e5; t1 += 15 * 864e5 }
    const ticks = niceTicks(Math.min(...all.map((p) => p.value)), Math.max(...all.map((p) => p.value)))
    const y0 = ticks[0]
    const y1 = ticks[ticks.length - 1]
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right)
    const y = (v: number) => H - PAD.bottom - ((v - y0) / (y1 - y0 || 1)) * (H - PAD.top - PAD.bottom)
    // Graduations mensuelles (au plus ~6 étiquettes)
    const months: number[] = []
    const d = new Date(t0)
    let m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    while (m <= t1) { months.push(m); const n = new Date(m); m = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1) }
    const every = Math.max(1, Math.ceil(months.length / 6))
    return { x, y, ticks, months: months.filter((_, i) => i % every === 0) }
  }, [all])

  if (!geom) return <p className="muted">Pas encore de prix daté pour cet article.</p>

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = e.currentTarget
    const r = svg.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const py = ((e.clientY - r.top) / r.height) * H
    let best: { p: PricePoint; s: Series; d: number } | null = null
    for (const s of series) for (const p of s.points) {
      const dx = geom!.x(toTime(p.date)) - px
      const dy = geom!.y(p.value) - py
      const dist = dx * dx + dy * dy * 0.25
      if (!best || dist < best.d) best = { p, s, d: dist }
    }
    if (!best) return
    const bx = (geom!.x(toTime(best.p.date)) / W) * r.width
    const by = (geom!.y(best.p.value) / H) * r.height
    setHover({ p: best.p, s: best.s, x: bx, y: by })
  }

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Évolution du prix"
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        {geom.ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={PAD.left} x2={W - PAD.right} y1={geom.y(t)} y2={geom.y(t)} />
            <text x={PAD.left - 6} y={geom.y(t) + 4} textAnchor="end">{t.toLocaleString('fr-BE')}</text>
          </g>
        ))}
        <line className="baseline" x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} />
        {geom.months.map((m) => (
          <text key={m} x={geom.x(m)} y={H - 8} textAnchor="middle">{monthTick(m)}</text>
        ))}
        {hover && <line className="crosshair" x1={geom.x(toTime(hover.p.date))} x2={geom.x(toTime(hover.p.date))} y1={PAD.top} y2={H - PAD.bottom} />}
        {series.map((s) => {
          const paid = s.points.filter((p) => p.kind === 'paid').sort((a, b) => a.date.localeCompare(b.date))
          const refs = s.points.filter((p) => p.kind === 'reference')
          const path = paid.map((p, i) => `${i ? 'L' : 'M'}${geom.x(toTime(p.date)).toFixed(1)},${geom.y(p.value).toFixed(1)}`).join('')
          return (
            <g key={s.key}>
              {paid.length > 1 && <path d={path} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
              {paid.map((p, i) => (
                <circle key={`p${i}`} cx={geom.x(toTime(p.date))} cy={geom.y(p.value)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
              ))}
              {refs.map((p, i) => (
                <circle key={`r${i}`} cx={geom.x(toTime(p.date))} cy={geom.y(p.value)} r={5} fill="var(--surface)" stroke={s.color} strokeWidth={2} />
              ))}
            </g>
          )
        })}
        {hover && (
          <circle cx={geom.x(toTime(hover.p.date))} cy={geom.y(hover.p.value)} r={7} fill="none" stroke="var(--ink)" strokeWidth={1.5} />
        )}
      </svg>
      {hover && (
        <div className="tooltip" style={{
          left: Math.min(Math.max(hover.x - 80, 0), (wrap.current?.clientWidth ?? 300) - 170),
          top: Math.max(hover.y - 78, 0),
        }}>
          <div className="muted">{longDate(hover.p.date)}</div>
          <div className="t-row">
            <span><span className="legend"><span className="key" style={{ background: hover.s.color, margin: 0 }} /></span> {hover.p.storeName}</span>
            <strong>{eur(hover.p.value)}</strong>
          </div>
          <div className="muted small">{hover.p.kind === 'reference' ? 'prix relevé' : 'prix payé'}{hover.p.promo ? ' · promo' : ''}</div>
        </div>
      )}
      <div className="legend">
        {series.map((s) => (
          <span key={s.key}><span className="key" style={{ background: s.color }} />{s.label}</span>
        ))}
        {all.some((p) => p.kind === 'reference') && (
          <span><span className="dot" style={{ borderColor: 'var(--muted)' }} />prix relevé</span>
        )}
      </div>
    </div>
  )
}
