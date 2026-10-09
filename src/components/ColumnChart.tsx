import { useState } from 'react'
import { eur } from '../lib/format'

export interface Column { key: string; label: string; value: number; highlight?: boolean }

const W = 360
const H = 200
const PAD = { left: 40, right: 8, top: 14, bottom: 24 }

/** Colonnes d'une seule série (totaux mensuels), avec ligne de référence facultative. */
export function ColumnChart({ columns, reference, referenceLabel }: { columns: Column[]; reference?: number | null; referenceLabel?: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...columns.map((c) => c.value), reference ?? 0, 1)
  const step = [1, 2, 2.5, 5].map((m) => m * 10 ** Math.floor(Math.log10(max / 4))).find((s) => s * 4 >= max) ?? max / 4
  const top = Math.ceil(max / step) * step
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
  const y = (v: number) => H - PAD.bottom - (v / top) * (H - PAD.top - PAD.bottom)
  const band = (W - PAD.left - PAD.right) / Math.max(columns.length, 1)
  const bw = Math.min(24, band * 0.6)

  return (
    <div style={{ position: 'relative' }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Totaux mensuels" onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end">{t.toLocaleString('fr-BE')}</text>
          </g>
        ))}
        {columns.map((c, i) => {
          const cx = PAD.left + band * i + band / 2
          const h = Math.max(0, H - PAD.bottom - y(c.value))
          const r = Math.min(4, h)
          const x0 = cx - bw / 2
          const yTop = y(c.value)
          // Barre arrondie en haut (4px), carrée à la ligne de base.
          const d = h > 0
            ? `M${x0},${H - PAD.bottom}V${yTop + r}Q${x0},${yTop} ${x0 + r},${yTop}H${x0 + bw - r}Q${x0 + bw},${yTop} ${x0 + bw},${yTop + r}V${H - PAD.bottom}Z`
            : ''
          return (
            <g key={c.key} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
              <rect x={cx - band / 2} y={PAD.top} width={band} height={H - PAD.top - PAD.bottom} fill="transparent" />
              {d && <path d={d} fill="var(--s1)" opacity={c.highlight || hover === i ? 1 : 0.5} />}
              <text x={cx} y={H - 8} textAnchor="middle" style={c.highlight ? { fill: 'var(--ink)', fontWeight: 700 } : undefined}>{c.label}</text>
            </g>
          )
        })}
        <line className="baseline" x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} />
        {reference ? (
          <g>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(reference)} y2={y(reference)} stroke="var(--ink-2)" strokeWidth={1.5} />
            <text x={W - PAD.right} y={y(reference) - 5} textAnchor="end" style={{ fill: 'var(--ink-2)' }}>{referenceLabel} {eur(reference)}</text>
          </g>
        ) : null}
      </svg>
      {hover != null && columns[hover] && (
        <div className="tooltip" style={{ left: `${Math.min(80, Math.max(0, ((PAD.left + band * hover) / W) * 100 - 10))}%`, top: 0 }}>
          <div className="muted capitalize">{columns[hover].key}</div>
          <strong>{eur(columns[hover].value)}</strong>
        </div>
      )}
    </div>
  )
}
