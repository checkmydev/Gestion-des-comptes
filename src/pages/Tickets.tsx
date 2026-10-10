import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loading } from '../components/Layout'
import { ProductIcon } from '../components/ProductIcon'
import { must } from '../lib/api'
import { useApp } from '../lib/app'
import { eur, longDate } from '../lib/format'
import { periodLabel } from '../lib/period'
import { supabase } from '../lib/supabase'
import type { Purchase } from '../lib/types'

interface TicketGroup { id: string; date: string | null; storeId: number | null; savedAt: string; period: string; lines: Purchase[]; total: number }

/** Tickets scannés : revoir ce qui a été enregistré, supprimer un ticket entier (ex. photographié deux fois). */
export default function Tickets() {
  const { itemById, categoryById, storeById, dataChanged } = useApp()
  const [tickets, setTickets] = useState<TicketGroup[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const rows = must(await supabase.from('purchases').select('*').not('ticket_id', 'is', null)
        .order('created_at', { ascending: false }).order('id').limit(1000)) as Purchase[]
      const groups = new Map<string, TicketGroup>()
      for (const p of rows) {
        const g = groups.get(p.ticket_id!) ?? { id: p.ticket_id!, date: p.purchased_on, storeId: p.store_id, savedAt: p.created_at ?? '', period: p.period, lines: [], total: 0 }
        g.lines.push(p)
        g.total = Math.round((g.total + Number(p.amount)) * 100) / 100
        groups.set(p.ticket_id!, g)
      }
      setTickets([...groups.values()])
    } catch (e) { setError((e as Error).message) }
  }
  useEffect(() => { void load() }, [])

  async function remove(t: TicketGroup) {
    const store = storeById(t.storeId)?.name ?? 'magasin inconnu'
    if (!confirm(`Supprimer tout ce ticket (${t.lines.length} achat${t.lines.length > 1 ? 's' : ''}, ${eur(t.total)} chez ${store}) ? Les achats disparaîtront de vos comptes.`)) return
    try {
      must(await supabase.from('purchases').delete().eq('ticket_id', t.id))
      setTickets((ts) => ts?.filter((x) => x.id !== t.id) ?? null)
      dataChanged()
    } catch (e) { alert((e as Error).message) }
  }

  if (error) return <p className="error">{error}</p>
  if (!tickets) return <Loading />

  // Même jour, même magasin, même montant : sans doute le même ticket enregistré deux fois
  const twin = (t: TicketGroup) => tickets.some((x) => x.id !== t.id && x.date === t.date && x.storeId === t.storeId && Math.abs(x.total - t.total) <= 0.02 && x.lines.length === t.lines.length)

  return (
    <div className="stack">
      <h1>Mes tickets</h1>
      <p className="muted small" style={{ margin: 0 }}>
        Les tickets photographiés et enregistrés, du plus récent au plus ancien. Touchez un ticket pour voir ses achats.
        La photo elle-même n'est pas conservée. Les pleins d'essence sont dans <Link to="/global?tab=essence">Global → Essence</Link>.
      </p>
      {!tickets.length && <p className="alert info">Aucun ticket scanné pour l'instant. Photographiez-en un depuis l'assistant (📷 Ticket).</p>}
      {tickets.map((t) => {
        const store = storeById(t.storeId)?.name ?? 'Magasin inconnu'
        const isOpen = open === t.id
        return (
          <section key={t.id} className={`card ticket-item${twin(t) ? ' twin' : ''}`}>
            <button className="btn-ghost ticket-head" onClick={() => setOpen(isOpen ? null : t.id)} aria-expanded={isOpen}>
              <span className="grow" style={{ textAlign: 'left' }}>
                <strong>🧾 {store}</strong>
                <span className="muted small" style={{ display: 'block' }}>
                  {t.date ? longDate(t.date) : 'sans date'} · {t.lines.length} achat{t.lines.length > 1 ? 's' : ''} · <span className="capitalize">{periodLabel(t.period)}</span>
                </span>
              </span>
              <strong className="num">{eur(t.total)}</strong>
              <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
            </button>
            {twin(t) && <p className="alert small" style={{ margin: '8px 0 0' }}>⚠ Un autre ticket identique (même jour, même magasin, même montant) a été enregistré : c'est peut-être un doublon.</p>}
            {isOpen && (
              <>
                <table className="ticket-lines" style={{ marginTop: 8 }}>
                  <tbody>
                    {t.lines.map((p) => {
                      const it = itemById(p.item_id)
                      return (
                        <tr key={p.id}>
                          <td><span className="pname"><ProductIcon name={it?.name ?? ''} category={categoryById(it?.category_id ?? 0)?.name} icon={it?.icon} />{it?.name ?? '?'}{p.units && Number(p.units) > 1 ? <span className="muted small"> × {Number(p.units)}</span> : null}</span></td>
                          <td className="num">{eur(p.amount)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot><tr><td>Total</td><td className="num">{eur(t.total)}</td></tr></tfoot>
                </table>
                <p className="muted small">Une ligne fausse ? Corrigez-la dans le <Link to="/detail">Détail</Link>, ou demandez-le simplement à l'assistant.</p>
                <button className="btn btn-danger" onClick={() => void remove(t)}>🗑 Supprimer tout ce ticket</button>
              </>
            )}
          </section>
        )
      })}
    </div>
  )
}
