import { useEffect, useState, type ReactNode } from 'react'
import { parseAmount } from '../lib/format'
import type { Row } from '../lib/api'

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="spread" style={{ marginBottom: 12 }}>
          <h2>{title}</h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export interface Field {
  key: string
  label: string
  type: 'text' | 'amount' | 'number' | 'date' | 'checkbox' | 'select' | 'textarea'
  options?: { value: string; label: string }[]
  required?: boolean
  placeholder?: string
  hint?: string
}

interface FormModalProps {
  title: string
  fields: Field[]
  initial?: object
  onSave: (values: Row) => Promise<void>
  onDelete?: () => Promise<void>
  onClose: () => void
}

function toText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'number') return String(v).replace('.', ',')
  return String(v)
}

/** Formulaire générique en fenêtre modale (lignes du Global, essence, épargne…). */
export function FormModal({ title, fields, initial: init = {}, onSave, onDelete, onClose }: FormModalProps) {
  const initial = init as Row
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.type === 'checkbox' ? Boolean(initial[f.key]) : toText(initial[f.key])])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (k: string, v: string | boolean) => setValues((s) => ({ ...s, [k]: v }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const out: Row = {}
    for (const f of fields) {
      const v = values[f.key]
      if (f.type === 'checkbox') { out[f.key] = v; continue }
      const s = String(v).trim()
      if (f.required && !s) { setError(`« ${f.label} » est obligatoire.`); return }
      if (f.type === 'amount' || f.type === 'number') {
        const n = s ? parseAmount(s) : null
        if (s && n === null) { setError(`« ${f.label} » n'est pas un nombre valide.`); return }
        out[f.key] = n
      } else {
        out[f.key] = s || null
      }
    }
    setBusy(true)
    try {
      await onSave(out)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  async function remove() {
    if (!onDelete || !confirm('Supprimer cette ligne ?')) return
    setBusy(true)
    try {
      await onDelete()
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {fields.map((f) => (
          f.type === 'checkbox' ? (
            <label key={f.key} className="field check">
              <input type="checkbox" checked={Boolean(values[f.key])} onChange={(e) => set(f.key, e.target.checked)} />
              <span>{f.label}{f.hint && <span className="muted small"> — {f.hint}</span>}</span>
            </label>
          ) : (
            <label key={f.key} className="field">
              {f.label}
              {f.type === 'select' ? (
                <select value={String(values[f.key])} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea rows={3} value={String(values[f.key])} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <input
                  type={f.type === 'date' ? 'date' : 'text'}
                  inputMode={f.type === 'amount' || f.type === 'number' ? 'decimal' : undefined}
                  value={String(values[f.key])}
                  placeholder={f.placeholder}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
              {f.hint && <span className="muted small">{f.hint}</span>}
            </label>
          )
        ))}
        {error && <p className="error">{error}</p>}
        <button className="btn-primary btn-big" disabled={busy}>Enregistrer</button>
        {onDelete && <button type="button" className="btn-danger" onClick={remove} disabled={busy}>Supprimer</button>}
      </form>
    </Modal>
  )
}
