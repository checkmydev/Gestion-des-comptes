import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApp } from '../lib/app'
import { patchConversationMessage } from '../lib/chat'
import { eur, longDate, parseAmount, todayIso } from '../lib/format'
import { cycleLabel, periodForDate, periodLabel } from '../lib/period'
import { productIcon } from '../lib/icons'
import { compressPhoto, readTicket, saveTicket, takeHandoff, ticketText, type TicketDraft, type TicketRow as Row } from '../lib/ticket'

/**
 * Scanner un ticket de caisse : photo → lecture automatique → vérification → enregistrement.
 * Rien n'est enregistré avant que l'utilisateur ait vérifié et validé.
 * Ouvert depuis l'assistant (« Corriger »), il reprend le ticket lu et y revient après validation.
 */
export default function Ticket() {
  const { categories, items, stores, ensureItem, ensureStore } = useApp()
  const navigate = useNavigate()
  const active = categories.filter((c) => !c.archived)
  const [step, setStep] = useState<'photo' | 'lecture' | 'verif' | 'fini'>('photo')
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [store, setStore] = useState('')
  const [date, setDate] = useState(todayIso())
  const [ticketTotal, setTicketTotal] = useState<number | null>(null)
  const [remark, setRemark] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<{ article: string; category: string; amount: number }[]>([])
  const [zoom, setZoom] = useState(false)
  const [fromChat, setFromChat] = useState<{ conversationId: number | null; messageIndex: number } | null>(null)

  const catById = (id: number) => categories.find((c) => c.id === id)

  function load(d: TicketDraft) {
    setStore(d.store); setDate(d.date); setTicketTotal(d.total); setRemark(d.remark); setRows(d.rows)
  }

  // Ticket venu du chat
  useEffect(() => {
    const h = takeHandoff()
    if (!h) return
    load(h.draft)
    setPreview(h.preview)
    setFromChat({ conversationId: h.conversationId, messageIndex: h.messageIndex })
    setStep('verif')
  }, [])

  async function onPhoto(file: File | undefined) {
    if (!file) return
    setError(null)
    setStep('lecture')
    try {
      const dataUrl = await compressPhoto(file)
      setPreview(dataUrl)
      load(await readTicket(dataUrl, categories, stores))
      setStep('verif')
    } catch (e) {
      setError((e as Error).message)
      setStep('photo')
    }
  }

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const kept = rows.filter((r) => r.keep)
  const sum = useMemo(() => Math.round(kept.reduce((a, r) => a + (parseAmount(r.amount) ?? 0), 0) * 100) / 100, [kept])
  const gap = ticketTotal != null ? Math.round((sum - ticketTotal) * 100) / 100 : null
  const invalid = kept.some((r) => !r.article.trim() || parseAmount(r.amount) == null)

  async function save() {
    if (invalid || !kept.length) return
    if (gap != null && Math.abs(gap) > 0.02 && !confirm(`Le total des lignes (${eur(sum)}) ne correspond pas au ticket (${eur(ticketTotal!)}). Enregistrer quand même ?`)) return
    setSaving(true)
    setError(null)
    try {
      const draft: TicketDraft = { store, date, total: ticketTotal, remark, rows }
      const recap = await saveTicket(draft, { categories, ensureItem, ensureStore })
      if (fromChat?.conversationId != null) {
        // Retour dans la conversation : la fiche du ticket passe à « enregistré »
        await patchConversationMessage(fromChat.conversationId, fromChat.messageIndex, { content: ticketText(draft, categories, recap), ticket: { draft, recap } })
        navigate('/assistant')
        return
      }
      setSaved(recap.lines)
      setStep('fini')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  function reset() {
    setStep('photo'); setPreview(null); setRows([]); setError(null); setRemark(null); setTicketTotal(null)
  }

  if (step === 'fini') {
    return (
      <div className="card stack">
        <h1>✓ Ticket enregistré</h1>
        <p style={{ margin: 0 }}>
          {saved.length} achat{saved.length > 1 ? 's' : ''}{store.trim() ? <> chez <strong>{store.trim()}</strong></> : null}, le {longDate(date)},
          compté{saved.length > 1 ? 's' : ''} en <strong className="capitalize">{periodLabel(periodForDate(date))}</strong> :
        </p>
        <table>
          <tbody>
            {saved.map((r, i) => (
              <tr key={i}><td>{r.article}<div className="muted small">{r.category}</div></td><td className="num">{eur(r.amount)}</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td>Total</td><td className="num">{eur(saved.reduce((a, r) => a + r.amount, 0))}</td></tr></tfoot>
        </table>
        <button className="btn-primary btn-big" onClick={reset}>📷 Scanner un autre ticket</button>
        <button className="btn-big" onClick={() => navigate('/detail')}>Voir le détail du mois</button>
      </div>
    )
  }

  return (
    <div className="stack">
      <h1>Scanner un ticket</h1>

      {step === 'photo' && (
        <div className="card stack">
          <p style={{ margin: 0 }}>Prenez le ticket de caisse en photo, bien à plat et en entier. L'application lit les articles ; vous vérifiez avant d'enregistrer.</p>
          <label className="btn btn-primary btn-big" style={{ cursor: 'pointer' }}>
            📷 Prendre une photo
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onPhoto(e.target.files?.[0])} />
          </label>
          <label className="btn" style={{ cursor: 'pointer' }}>
            Choisir une photo existante
            <input type="file" accept="image/*" hidden onChange={(e) => void onPhoto(e.target.files?.[0])} />
          </label>
          {error && <p className="alert over" style={{ margin: 0 }}>{error}</p>}
          <p className="muted small" style={{ margin: 0 }}>Conseil : un ticket long peut être photographié en deux fois (deux scans).</p>
        </div>
      )}

      {step === 'lecture' && (
        <div className="card stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          {preview && <img src={preview} alt="Ticket photographié" style={{ maxHeight: 220, borderRadius: 8 }} />}
          <p><span className="dots" aria-hidden="true" /> Lecture du ticket… (une vingtaine de secondes)</p>
        </div>
      )}

      {step === 'verif' && (
        <>
          <section className="card read-summary" aria-label="Ce qui a été lu sur le ticket">
            {preview && (
              <button type="button" className="read-thumb" onClick={() => setZoom((z) => !z)} aria-label={zoom ? 'Réduire la photo' : 'Agrandir la photo'}>
                <img src={preview} alt="Votre ticket" className={zoom ? 'zoomed' : ''} />
              </button>
            )}
            <div className="grow">
              <h2 style={{ marginBottom: 6 }}>Voici ce que j'ai lu</h2>
              <ul className="read-facts">
                <li>🏪 <strong>{store || 'Magasin non lu'}</strong></li>
                <li>📅 {longDate(date)}</li>
                <li>🧾 {rows.length} article{rows.length > 1 ? 's' : ''}{ticketTotal != null && <> · total <strong>{eur(ticketTotal)}</strong></>}</li>
                {gap != null && Math.abs(gap) <= 0.02
                  ? <li className="ok">✓ Le total des articles correspond au ticket</li>
                  : gap != null ? <li className="warn">⚠ Écart de {eur(Math.abs(gap))} avec le total du ticket</li> : null}
                {rows.some((r) => r.uncertain) && <li className="warn">⚠ {rows.filter((r) => r.uncertain).length} ligne{rows.filter((r) => r.uncertain).length > 1 ? 's' : ''} difficile{rows.filter((r) => r.uncertain).length > 1 ? 's' : ''} à lire (en jaune)</li>}
              </ul>
            </div>
          </section>
          <p className="callout-step"><strong>À vous :</strong> vérifiez les lignes ci-dessous en les comparant au ticket, corrigez si besoin, puis touchez <strong>« Valider et enregistrer »</strong> en bas.</p>

          <div className="card stack" style={{ gap: 10 }}>
            <div className="grid2">
              <label className="field">
                Magasin
                <input list="ticket-stores" value={store} onChange={(e) => setStore(e.target.value)} />
                <datalist id="ticket-stores">{stores.map((s) => <option key={s.id} value={s.name} />)}</datalist>
              </label>
              <label className="field">
                Date du ticket
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
            </div>
            <p className="small muted" style={{ margin: 0 }}>Compté en <strong className="capitalize">{periodLabel(periodForDate(date))}</strong> ({cycleLabel(periodForDate(date))})</p>
            {remark && <p className="alert" style={{ margin: 0 }}>{remark}</p>}
          </div>

          <p className="small ink2" style={{ margin: 0 }}>Touchez un champ pour le corriger ; décochez une ligne pour ne pas l'enregistrer.</p>

          {rows.map((r, i) => {
            const cat = catById(r.categoryId)
            const names = items.filter((it) => it.category_id === r.categoryId)
            return (
              <div key={i} className="card" style={{ padding: 12, opacity: r.keep ? 1 : 0.5, borderLeft: r.uncertain ? '4px solid var(--warning)' : undefined }}>
                <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={r.keep} onChange={(e) => update(i, { keep: e.target.checked })} aria-label="Enregistrer cette ligne" style={{ marginTop: 10 }} />
                  <div className="grow stack" style={{ gap: 8 }}>
                    <div className="muted small">Ticket : « {r.source} »{r.uncertain && <strong style={{ color: 'var(--ink)' }}> · à vérifier</strong>}{r.discount ? ` · réduction ${eur(r.discount)} déduite` : ''}</div>
                    <div className="grid2" style={{ gridTemplateColumns: 'auto 3fr 2fr', alignItems: 'center' }}>
                      <span className="picon picon-lg" aria-hidden="true">{productIcon(r.article, catById(r.categoryId)?.name)}</span>
                      <input list={`items-${i}`} value={r.article} onChange={(e) => update(i, { article: e.target.value })} aria-label="Article" />
                      <datalist id={`items-${i}`}>{names.map((n) => <option key={n.id} value={n.name} />)}</datalist>
                      <select value={r.categoryId} onChange={(e) => update(i, { categoryId: Number(e.target.value) })} aria-label="Catégorie">
                        {active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                    <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
                      {cat?.weighed ? (
                        <>
                          <input inputMode="decimal" value={r.grams} onChange={(e) => update(i, { grams: e.target.value })} placeholder="g" aria-label="Poids en grammes" style={{ width: '30%' }} />
                          <input inputMode="decimal" value={r.ppk} onChange={(e) => update(i, { ppk: e.target.value })} placeholder="€/kg" aria-label="Prix au kilo" style={{ width: '30%' }} />
                        </>
                      ) : (
                        <input inputMode="numeric" value={r.units} onChange={(e) => update(i, { units: e.target.value })} placeholder="nb 1" aria-label="Nombre" style={{ width: '30%' }} />
                      )}
                      <input inputMode="decimal" value={r.amount} onChange={(e) => update(i, { amount: e.target.value })} aria-label="Montant payé" style={{ fontWeight: 700, textAlign: 'right' }} />
                    </div>
                  </div>
                </div>
              </div>
            )
          })}

          <div className="card stack" style={{ gap: 6 }}>
            <div className="spread"><span>Total des lignes cochées</span><strong>{eur(sum)}</strong></div>
            {ticketTotal != null && (
              <div className="spread small"><span className="muted">Total imprimé sur le ticket</span><span>{eur(ticketTotal)}</span></div>
            )}
            {gap != null && Math.abs(gap) > 0.02 && (
              <p className="alert" style={{ margin: 0 }}>Écart de {eur(Math.abs(gap))} avec le ticket : une ligne manque ou est mal lue. Vérifiez avant d'enregistrer.</p>
            )}
            {gap != null && Math.abs(gap) <= 0.02 && <p className="small" style={{ margin: 0, color: 'var(--good-ink)' }}>✓ Le total correspond au ticket.</p>}
          </div>

          {error && <p className="alert over" style={{ margin: 0 }}>{error}</p>}
          <button className="btn-primary btn-big" disabled={saving || invalid || !kept.length} onClick={save}>
            {saving ? 'Enregistrement…' : `✓ Valider et enregistrer ${kept.length} achat${kept.length > 1 ? 's' : ''}`}
          </button>
          <button className="btn-ghost" onClick={reset}>Recommencer avec une autre photo</button>
        </>
      )}

      {fromChat ? <Link to="/assistant" className="small">← Retour à l'assistant (sans enregistrer)</Link> : <Link to="/saisie" className="small">← Saisie manuelle</Link>}
    </div>
  )
}
