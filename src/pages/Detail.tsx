import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loading } from '../components/Layout'
import { Modal } from '../components/Modal'
import { PurchaseForm } from '../components/PurchaseForm'
import { loadPurchases } from '../lib/api'
import { useApp } from '../lib/app'
import { budgetStatus } from '../lib/budget'
import { eur, num, storeDate } from '../lib/format'
import { cycleLabel, periodLabel } from '../lib/period'
import type { Purchase } from '../lib/types'
import { ProductIcon } from '../components/ProductIcon'

export default function Detail() {
  const { period, categories, itemById, storeById, categoryById } = useApp()
  const [purchases, setPurchases] = useState<Purchase[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Purchase | null>(null)

  const refresh = useCallback(async () => {
    try {
      setPurchases(await loadPurchases(period))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [period])

  useEffect(() => { setPurchases(null); void refresh() }, [refresh])

  if (error) return <p className="error">{error}</p>
  if (!purchases) return <Loading />

  const byCategory = new Map<number, Purchase[]>()
  for (const p of purchases) {
    const cid = itemById(p.item_id)?.category_id
    if (cid == null) continue
    byCategory.set(cid, [...(byCategory.get(cid) ?? []), p])
  }
  const total = purchases.reduce((a, p) => a + Number(p.amount), 0)
  const visible = categories.filter((c) => !c.archived || byCategory.has(c.id))

  const editingItem = editing ? itemById(editing.item_id) : undefined
  const editingCategory = editingItem ? categoryById(editingItem.category_id) : undefined

  return (
    <div className="stack">
      <div className="spread">
        <div>
        <h1 className="capitalize">Détail — {periodLabel(period)}</h1>
        <div className="muted small">{cycleLabel(period)}</div>
      </div>
        <span className="strong">{eur(total)}</span>
      </div>
      <Link to="/tickets" className="btn btn-block">🧾 Revoir mes tickets scannés</Link>

      {visible.map((c) => {
        const rows = byCategory.get(c.id) ?? []
        const sub = rows.reduce((a, p) => a + Number(p.amount), 0)
        const status = budgetStatus(sub, c.monthly_budget)
        return (
          <section key={c.id} className="card">
            <div className="spread">
              <h2>{c.name}</h2>
              <span className="strong">{eur(sub)}</span>
            </div>
            {c.monthly_budget ? (
              <div className="small ink2" style={{ marginBottom: 8 }}>
                Budget {eur(c.monthly_budget)}
                <div className="meter"><span className={status ?? ''} style={{ width: `${Math.min(100, (sub / c.monthly_budget) * 100)}%` }} /></div>
              </div>
            ) : null}
            {rows.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Article</th>
                      <th>Magasin + date</th>
                      {c.weighed && <><th className="num">Qté (g)</th><th className="num">€/kg</th></>}
                      {c.counted && <th className="num">Nbre</th>}
                      <th className="num">Promo</th>
                      <th className="num">Montant</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id} className="clickable" onClick={() => setEditing(p)}>
                        <td><span className="pname"><ProductIcon name={itemById(p.item_id)?.name ?? ''} category={c.name} icon={itemById(p.item_id)?.icon} />{itemById(p.item_id)?.name}</span>{!c.counted && p.units && Number(p.units) > 1 ? <span className="muted"> ×{num(p.units)}</span> : null}{p.note && <div className="muted small">{p.note}</div>}</td>
                        <td>{storeDate(storeById(p.store_id)?.name, p.purchased_on)}</td>
                        {c.weighed && <><td className="num">{num(p.quantity_g)}</td><td className="num">{num(p.price_per_kg)}</td></>}
                        {c.counted && <td className="num">{num(p.units ?? 1)}</td>}
                        <td className="num">{p.promo_pct ? `${num(p.promo_pct)} %` : ''}</td>
                        <td className="num">{eur(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Link className="btn btn-ghost" to={`/saisie?cat=${c.id}`}>+ Ajouter une ligne</Link>
          </section>
        )
      })}

      {editing && editingItem && editingCategory && (
        <Modal title={`${editingCategory.name} — ${editingItem.name}`} onClose={() => setEditing(null)}>
          <p className="small"><Link to={`/article/${editingItem.id}`}>Voir l'évolution du prix de cet article →</Link></p>
          <PurchaseForm
            category={editingCategory}
            item={editingItem}
            period={period}
            purchase={editing}
            onSaved={() => { setEditing(null); void refresh() }}
            onDeleted={() => { setEditing(null); void refresh() }}
          />
        </Modal>
      )}
    </div>
  )
}
