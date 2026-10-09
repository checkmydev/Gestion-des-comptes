import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { deleteRow, lastPurchaseOf, saveRow } from '../lib/api'
import { useApp } from '../lib/app'
import { eur, num, parseAmount, storeDate, todayIso } from '../lib/format'
import type { Category, Item, Purchase } from '../lib/types'

const NEW_STORE = '__new__'

/** Montant payé = quantité (kg) × €/kg × (1 − promo %). Corrige la formule de l'Excel. */
export function computeAmount(quantityG: number | null, pricePerKg: number | null, promoPct: number | null): number | null {
  if (quantityG == null || pricePerKg == null) return null
  const v = (quantityG / 1000) * pricePerKg * (1 - (promoPct ?? 0) / 100)
  return Math.round(v * 100) / 100
}

const txt = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','))

interface Props {
  category: Category
  item: Item
  period: string
  purchase?: Purchase
  defaultStoreId?: number | null
  defaultDate?: string
  onSaved: (p: Purchase) => void
  onDeleted?: () => void
}

export function PurchaseForm({ category, item, period, purchase, defaultStoreId, defaultDate, onSaved, onDeleted }: Props) {
  const { stores, ensureStore, storeById } = useApp()
  const [storeId, setStoreId] = useState<string>(String(purchase?.store_id ?? defaultStoreId ?? ''))
  const [newStore, setNewStore] = useState('')
  const [date, setDate] = useState(purchase?.purchased_on ?? defaultDate ?? todayIso())
  const [qty, setQty] = useState(txt(purchase?.quantity_g))
  const [ppk, setPpk] = useState(txt(purchase?.price_per_kg))
  const [promo, setPromo] = useState(txt(purchase?.promo_pct))
  const [amount, setAmount] = useState(txt(purchase?.amount))
  const [amountTouched, setAmountTouched] = useState(Boolean(purchase))
  const [note, setNote] = useState(purchase?.note ?? '')
  const [units, setUnits] = useState(txt(purchase?.units))
  const [unitsAuto, setUnitsAuto] = useState(false)
  const [last, setLast] = useState<Purchase | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (purchase) return
    let cancelled = false
    lastPurchaseOf(item.id).then((p) => { if (!cancelled) setLast(p) }).catch(() => {})
    return () => { cancelled = true }
  }, [item.id, purchase])

  const computed = useMemo(
    () => computeAmount(parseAmount(qty), parseAmount(ppk), parseAmount(promo)),
    [qty, ppk, promo],
  )

  // Nombre d'unités (articles à la pièce) et prix unitaire affiché en aide
  const unitCount = Math.max(1, Math.round(parseAmount(units) ?? 1))
  const paidValue = parseAmount(amount)
  const unitHint = unitCount > 1 && paidValue != null ? `soit ${eur(paidValue / unitCount)} pièce` : null

  // Le montant suit le calcul tant que l'utilisateur ne l'a pas modifié lui-même.
  useEffect(() => {
    if (!amountTouched && computed != null) setAmount(txt(computed))
  }, [computed, amountTouched])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const value = parseAmount(amount)
    if (value == null) { setError('Indiquez le montant payé.'); return }
    setBusy(true)
    try {
      let sid: number | null = storeId && storeId !== NEW_STORE ? Number(storeId) : null
      if (storeId === NEW_STORE) {
        if (!newStore.trim()) { setError('Indiquez le nom du nouveau magasin.'); setBusy(false); return }
        sid = (await ensureStore(newStore)).id
      }
      const row = {
        period: purchase?.period ?? period,
        item_id: item.id,
        store_id: sid,
        purchased_on: date || null,
        quantity_g: category.weighed ? parseAmount(qty) : null,
        price_per_kg: category.weighed ? parseAmount(ppk) : null,
        promo_pct: parseAmount(promo),
        units: !category.weighed && unitCount > 1 ? unitCount : null,
        amount: value,
        note: note.trim() || null,
      }
      onSaved(await saveRow<Purchase>('purchases', row, purchase?.id))
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  async function remove() {
    if (!purchase || !confirm('Supprimer cet achat ?')) return
    setBusy(true)
    try {
      await deleteRow('purchases', purchase.id)
      onDeleted?.()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      {last && (
        <p className="alert info small">
          Dernier achat : <strong>{eur(last.amount)}</strong>
          {last.units && Number(last.units) > 1 ? <> pour {num(last.units)} ({eur(Number(last.amount) / Number(last.units))} pièce)</> : null}
          {' '}— {storeDate(storeById(last.store_id)?.name, last.purchased_on) || 'sans magasin'}
          {last.price_per_kg != null && <> ({num(last.price_per_kg)} €/kg)</>}
          {' · '}<Link to={`/article/${item.id}`}>évolution du prix</Link>
        </p>
      )}

      <div className="grid2">
        <label className="field">
          Magasin
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">—</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value={NEW_STORE}>+ Nouveau magasin…</option>
          </select>
        </label>
        <label className="field">
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      {storeId === NEW_STORE && (
        <label className="field">
          Nom du nouveau magasin
          <input autoFocus value={newStore} onChange={(e) => setNewStore(e.target.value)} />
        </label>
      )}

      {category.weighed && (
        <div className="grid3">
          <label className="field">
            Quantité (g)
            <input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label className="field">
            €/kg
            <input inputMode="decimal" value={ppk} onChange={(e) => setPpk(e.target.value)} />
          </label>
          <label className="field">
            Promo (%)
            <input inputMode="decimal" value={promo} onChange={(e) => setPromo(e.target.value)} />
          </label>
        </div>
      )}

      <div className={category.weighed ? '' : 'grid2'} style={category.weighed ? undefined : { gridTemplateColumns: '2fr 1fr' }}>
        <label className="field">
          Montant payé (€)
          <input
            inputMode="decimal"
            value={amount}
            placeholder="ex. 1,72 ou 2*2,15"
            onChange={(e) => {
              setAmount(e.target.value)
              setAmountTouched(true)
              // « 2*3,25 » : 2 unités à 3,25 € → le nombre se remplit tout seul
              const m = e.target.value.replace(/\s/g, '').match(/^(\d{1,2})\*\d+(?:[.,]\d+)?$/)
              if (m && !category.weighed && (!units || unitsAuto)) { setUnits(m[1]); setUnitsAuto(true) }
            }}
            style={{ fontSize: '1.3rem', fontWeight: 700 }}
          />
        </label>
        {!category.weighed && (
          <label className="field">
            Nombre
            <input inputMode="numeric" value={units} placeholder="1"
              onChange={(e) => { setUnits(e.target.value); setUnitsAuto(false) }}
              style={{ fontSize: '1.3rem', fontWeight: 700, textAlign: 'center' }} />
          </label>
        )}
      </div>
      {category.weighed && computed != null && amountTouched && parseAmount(amount) !== computed && (
        <button type="button" className="btn-ghost small" onClick={() => { setAmount(txt(computed)); setAmountTouched(false) }}>
          Utiliser le calcul : {eur(computed)}
        </button>
      )}
      {!category.weighed && unitHint && <p className="muted small" style={{ margin: '-8px 0 0' }}>{unitHint}</p>}
      {category.weighed && !qty && !ppk && (
        <p className="muted small" style={{ margin: '-8px 0 0' }}>
          Sans quantité ni €/kg, l'achat compte dans le budget mais pas dans l'évolution des prix.
        </p>
      )}

      {!category.weighed && (
        <label className="field">
          Promo (%) <span className="muted small">— facultatif, sert à comparer les prix hors promo</span>
          <input inputMode="decimal" value={promo} onChange={(e) => setPromo(e.target.value)} />
        </label>
      )}

      <label className="field">
        Remarque
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      {error && <p className="error">{error}</p>}
      <button className="btn-primary btn-big" disabled={busy}>
        {purchase ? 'Enregistrer les modifications' : 'Enregistrer'}
      </button>
      {purchase && <button type="button" className="btn-danger" onClick={remove} disabled={busy}>Supprimer</button>}
    </form>
  )
}
