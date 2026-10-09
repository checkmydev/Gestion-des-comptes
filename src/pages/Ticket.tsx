import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { must } from '../lib/api'
import { useApp } from '../lib/app'
import { eur, parseAmount, todayIso } from '../lib/format'
import { cycleLabel, periodForDate, periodLabel } from '../lib/period'
import { supabase } from '../lib/supabase'

interface ScannedLine {
  texte_ticket: string
  article: string
  categorie: string
  montant: number
  nombre: number | null
  poids_g: number | null
  prix_kg: number | null
  remise: number | null
  incertain: boolean
}
interface ScanResult { magasin: string | null; date: string | null; total_ticket: number | null; remarque: string | null; lignes: ScannedLine[] }

/** Ligne éditable (les nombres restent du texte pendant la saisie) */
interface Row { keep: boolean; article: string; categoryId: number; amount: string; units: string; grams: string; ppk: string; discount: number | null; source: string; uncertain: boolean }

const txt = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','))

/** Réduit la photo (côté le plus long : 1600 px) avant l'envoi. */
async function compress(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.82)
}

/**
 * Scanner un ticket de caisse : photo → lecture automatique → vérification → enregistrement.
 * Rien n'est enregistré avant que l'utilisateur ait vérifié et validé.
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
  const [savedCount, setSavedCount] = useState(0)

  const catById = (id: number) => categories.find((c) => c.id === id)

  async function onPhoto(file: File | undefined) {
    if (!file) return
    setError(null)
    setStep('lecture')
    try {
      const dataUrl = await compress(file)
      setPreview(dataUrl)
      const { data, error: fnError } = await supabase.functions.invoke('comptes-ticket', {
        body: { image: dataUrl.split(',')[1], media_type: 'image/jpeg' },
      })
      if (fnError) {
        let message = 'La lecture du ticket a échoué. Vérifiez la connexion internet et réessayez.'
        try { const body = await (fnError as { context?: Response }).context?.json(); if (body?.error) message = body.error } catch { /* ignoré */ }
        throw new Error(message)
      }
      const result = data as ScanResult
      if (!result.lignes?.length) throw new Error(result.remarque || "Aucun article n'a été trouvé sur la photo.")
      // Magasin : nom existant si possible
      const known = stores.find((s) => s.name.toLocaleLowerCase('fr') === (result.magasin ?? '').toLocaleLowerCase('fr'))
      setStore(known?.name ?? result.magasin ?? '')
      if (result.date && /^\d{4}-\d{2}-\d{2}$/.test(result.date)) setDate(result.date)
      setTicketTotal(result.total_ticket)
      setRemark(result.remarque)
      setRows(result.lignes.map((l) => {
        const cat = active.find((c) => c.name === l.categorie) ?? active.find((c) => c.name === 'Divers') ?? active[0]
        return {
          keep: true, article: l.article, categoryId: cat.id, amount: txt(l.montant),
          units: l.nombre && l.nombre > 1 ? String(l.nombre) : '', grams: txt(l.poids_g), ppk: txt(l.prix_kg),
          discount: l.remise, source: l.texte_ticket, uncertain: l.incertain,
        }
      }))
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
    setSaving(true)
    setError(null)
    try {
      const storeId = store.trim() ? (await ensureStore(store.trim())).id : null
      const period = periodForDate(date)
      const payload = []
      for (const r of kept) {
        const cat = catById(r.categoryId)!
        const item = await ensureItem(cat.id, r.article)
        const amount = parseAmount(r.amount)!
        const grams = cat.weighed ? parseAmount(r.grams) : null
        const ppk = cat.weighed ? parseAmount(r.ppk) : null
        const units = !cat.weighed ? Math.round(parseAmount(r.units) ?? 1) : 1
        const promo = r.discount && r.discount > 0 ? Math.round((r.discount / (amount + r.discount)) * 1000) / 10 : null
        payload.push({
          period, item_id: item.id, store_id: storeId, purchased_on: date,
          quantity_g: grams, price_per_kg: ppk, promo_pct: promo, units: units > 1 ? units : null,
          amount, note: 'ticket scanné',
        })
      }
      must(await supabase.from('purchases').insert(payload))
      setSavedCount(payload.length)
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
        <p>{savedCount} achat{savedCount > 1 ? 's' : ''} ajouté{savedCount > 1 ? 's' : ''}, compté{savedCount > 1 ? 's' : ''} en <strong className="capitalize">{periodLabel(periodForDate(date))}</strong>.</p>
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

          <p className="small ink2" style={{ margin: 0 }}>Vérifiez chaque ligne : touchez un champ pour le corriger, décochez ce qui ne doit pas être enregistré.</p>

          {rows.map((r, i) => {
            const cat = catById(r.categoryId)
            const names = items.filter((it) => it.category_id === r.categoryId)
            return (
              <div key={i} className="card" style={{ padding: 12, opacity: r.keep ? 1 : 0.5, borderLeft: r.uncertain ? '4px solid var(--warning)' : undefined }}>
                <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={r.keep} onChange={(e) => update(i, { keep: e.target.checked })} aria-label="Enregistrer cette ligne" style={{ marginTop: 10 }} />
                  <div className="grow stack" style={{ gap: 8 }}>
                    <div className="muted small">Ticket : « {r.source} »{r.uncertain && <strong style={{ color: 'var(--ink)' }}> · à vérifier</strong>}{r.discount ? ` · réduction ${eur(r.discount)} déduite` : ''}</div>
                    <div className="grid2" style={{ gridTemplateColumns: '3fr 2fr' }}>
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
            {saving ? 'Enregistrement…' : `Enregistrer ${kept.length} achat${kept.length > 1 ? 's' : ''}`}
          </button>
          <button className="btn-ghost" onClick={reset}>Recommencer avec une autre photo</button>
        </>
      )}

      <Link to="/saisie" className="small">← Saisie manuelle</Link>
    </div>
  )
}
