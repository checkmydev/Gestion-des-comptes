import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../lib/app'
import { CONVERSATION_FIELDS, DEFAULT_GROUPS, guessGroup, titleOf, toStore, type ChatMessage, type ConversationRow } from '../lib/chat'
import { eur, longDate } from '../lib/format'
import { productIcon } from '../lib/icons'
import { periodLabel } from '../lib/period'
import { supabase } from '../lib/supabase'
import {
  compressPhoto, draftGap, draftInvalid, draftSum, DuplicateTicketError, keptRows, readTicket, saveTicket, storeHandoff, takePendingPhoto, ticketText,
  type TicketDraft,
} from '../lib/ticket'
import { checkOnlineVoice, dictationSupported, speak, stopSpeaking, unlockAudio, useDictation } from '../lib/voice'

/** Copie locale de la conversation en cours (affichage immédiat, et secours hors connexion). */
const STORAGE_KEY = 'comptes.assistant.conversation'
const CURRENT_KEY = 'comptes.assistant.current'
const SUGGESTIONS = [
  'Combien ai-je dépensé ce mois-ci ?',
  "J'ai payé 12,50 € chez le boucher aujourd'hui",
  'Quelles dépenses ont augmenté ces derniers mois ?',
  'Où acheter les bananes le moins cher cette semaine ?',
]

/** Nom de l'écran affiché, transmis à l'assistant (« ce mois-ci », « cette catégorie »…). */
const SCREENS: [RegExp, string][] = [
  [/^\/tableau/, 'Tableau de bord (résumé du mois, alertes, budgets)'], [/^\/detail/, 'Détail du mois (achats par catégorie)'], [/^\/global\/?(\?tab=mois)?$/, 'Global du mois (rentrées, dépenses fixes, solde)'],
  [/^\/global\?tab=essence/, 'Global — Essence'], [/^\/global\?tab=annuels/, 'Global — Dépenses annuelles'], [/^\/global\?tab=epargne/, 'Global — Épargne'],
  [/^\/stats/, 'Analyses (tendances sur 12 mois, budgets)'], [/^\/inflation/, 'Inflation des prix'], [/^\/article/, "Fiche d'un article (évolution du prix)"],
  [/^\/courses/, 'Liste de courses'], [/^\/prix/, 'Meilleurs prix'], [/^\/saisie/, 'Saisie manuelle'], [/^\/parametres/, 'Paramètres'],
]

function loadConversation(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ChatMessage[]) : []
  } catch {
    return []
  }
}

function loadCurrentId(): number | null {
  try { return Number(localStorage.getItem(CURRENT_KEY)) || null } catch { return null }
}

function shortDate(iso: string) {
  const d = new Date(iso)
  const same = d.toDateString() === new Date().toDateString()
  return same
    ? `aujourd'hui à ${d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' })
}

/** Petite vignette de la photo pour la bulle (non gardée en base). */
async function thumbnail(dataUrl: string): Promise<string> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const scale = 240 / Math.max(img.width, img.height)
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.7)
}

/** Mise en forme simple et sûre des réponses : gras, liens, listes, paragraphes. */
function renderInline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1]) out.push(<strong key={`${key}-${i++}`}>{m[1]}</strong>)
    else if (m[2]) out.push(<a key={`${key}-${i++}`} href={m[3]} target="_blank" rel="noreferrer">{m[2]}</a>)
    else if (m[4]) out.push(<a key={`${key}-${i++}`} href={m[4]} target="_blank" rel="noreferrer">{new URL(m[4]).hostname}</a>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function Formatted({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let list: string[] = []
  const flush = (k: number) => {
    if (!list.length) return
    blocks.push(<ul key={`ul${k}`}>{list.map((l, j) => <li key={j}>{renderInline(l, `li${k}-${j}`)}</li>)}</ul>)
    list = []
  }
  lines.forEach((line, k) => {
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/)
    if (item) { list.push(item[1]); return }
    flush(k)
    const t = line.trim()
    if (!t) return
    const h = t.match(/^#{1,4}\s+(.*)$/)
    blocks.push(h ? <p key={k}><strong>{h[1]}</strong></p> : <p key={k}>{renderInline(t, `p${k}`)}</p>)
  })
  flush(lines.length)
  return <>{blocks}</>
}

const STEPS_DATA = ['Je consulte vos comptes…', 'Je fais les additions…', 'Je compare avec les mois précédents…', 'Je prépare la réponse…']
const STEPS_PRICES = [
  'Je regarde ce que vous payez d\'habitude…', 'Je cherche les prix sur les sites des magasins…', 'Je parcours les dépliants de la semaine…',
  'Je compare les magasins…', 'Je vérifie les promotions…', 'Je prépare la réponse…',
]
const STEPS_TICKET = ['Je regarde la photo…', 'Je lis les articles un par un…', 'Je range chaque article dans sa catégorie…', 'Je vérifie le total…']

/** Bulle d'attente animée : pièce qui tourne, points qui ondulent, étapes qui défilent. */
function ThinkingBubble({ question, ticket }: { question: string; ticket: boolean }) {
  const prices = !ticket && /prix|cher|magasin|promo|dépliant|meilleur/i.test(question)
  const steps = ticket ? STEPS_TICKET : prices ? STEPS_PRICES : STEPS_DATA
  const [index, setIndex] = useState(0)
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const step = window.setInterval(() => setIndex((i) => Math.min(i + 1, steps.length - 1)), prices ? 9000 : ticket ? 5000 : 3500)
    const clock = window.setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => { window.clearInterval(step); window.clearInterval(clock) }
  }, [prices, ticket, steps.length])
  return (
    <div className="bubble assistant thinking" role="status" aria-live="polite">
      <div className="thinking-row">
        <span className="thinking-coin" aria-hidden="true">€</span>
        <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
      </div>
      <p key={index} className="thinking-step">{steps[index]}</p>
      {seconds >= 20 && <p className="muted small" style={{ margin: 0 }}>Encore un instant… {seconds} s</p>}
    </div>
  )
}

/** Fiche d'un ticket lu, dans la conversation : vérifier, enregistrer ou corriger. */
function TicketCard({ m, onSave, onCorrect, onDraft, saving }: { m: ChatMessage; onSave: () => void; onCorrect: () => void; onDraft: (d: TicketDraft) => void; saving: boolean }) {
  const { categories } = useApp()
  const t = m.ticket!
  const d = t.draft
  const cat = (id: number) => categories.find((c) => c.id === id)?.name
  if (t.recap) {
    return (
      <div className="bubble assistant ticket-card">
        <p className="ticket-done">✓ Ticket enregistré</p>
        {t.recap.fuel && (
          <p>⛽ <strong>Plein de {eur(t.recap.fuel.amount)}</strong>{t.recap.fuel.litres != null ? <> ({String(t.recap.fuel.litres).replace('.', ',')} L)</> : null} ajouté dans l'onglet Essence{t.recap.fuel.km == null ? ' — sans compteur, la consommation ne peut pas être calculée' : ''}.</p>
        )}
        {t.recap.lines.length > 0 && <p>
          <strong>{t.recap.lines.length} achat{t.recap.lines.length > 1 ? 's' : ''}</strong>{t.recap.store ? <> chez <strong>{t.recap.store}</strong></> : null}, le {longDate(t.recap.date)},
          pour <strong>{eur(t.recap.total - (t.recap.fuel?.amount ?? 0))}</strong>, compté{t.recap.lines.length > 1 ? 's' : ''} en <span className="capitalize">{periodLabel(t.recap.period)}</span>.
        </p>}
        <p className="muted small">Une erreur ? Dites-le-moi simplement, par exemple « le beurre coûtait 2,29 € » ou « supprime la consigne ».</p>
      </div>
    )
  }
  const gap = draftGap(d)
  const kept = keptRows(d)
  const uncertain = kept.filter((r) => r.uncertain).length
  return (
    <div className="bubble assistant ticket-card">
      <p><strong>Voici ce que j'ai lu</strong></p>
      <ul className="read-facts">
        <li>🏪 <strong>{d.store || 'Magasin non lu'}</strong></li>
        <li>📅 {longDate(d.date)}</li>
        <li>🧾 {kept.length} article{kept.length > 1 ? 's' : ''} · <strong>{eur(draftSum(d))}</strong></li>
        {gap != null && Math.abs(gap) <= 0.02 && <li className="ok">✓ Le total correspond au ticket</li>}
        {gap != null && Math.abs(gap) > 0.02 && <li className="warn">⚠ Écart de {eur(Math.abs(gap))} avec le total du ticket ({eur(d.total!)})</li>}
        {uncertain > 0 && <li className="warn">⚠ {uncertain} ligne{uncertain > 1 ? 's' : ''} difficile{uncertain > 1 ? 's' : ''} à lire</li>}
      </ul>
      {d.fuel && (
        <div className="fuel-box">
          <p style={{ margin: 0 }}>⛽ <strong>Plein d'essence</strong> : {d.fuel.litres ? <>{d.fuel.litres} L</> : 'litres non lus'}{d.fuel.ppl ? <> à {d.fuel.ppl} €/l</> : null} = <strong>{d.fuel.amount} €</strong></p>
          <label className="field">
            Compteur kilométrique (facultatif)
            <input inputMode="numeric" value={d.fuel.km} placeholder="ex. 89 450" onChange={(e) => onDraft({ ...d, fuel: { ...d.fuel!, km: e.target.value } })} />
          </label>
          <p className="muted small" style={{ margin: 0 }}>Avec le compteur à chaque plein, l'application calcule la consommation aux 100 km.</p>
        </div>
      )}
      {kept.length > 0 && <table className="ticket-lines">
        <tbody>
          {kept.map((r, i) => (
            <tr key={i} className={r.uncertain ? 'uncertain' : undefined}>
              <td><span className="pname"><span className="picon" aria-hidden="true">{productIcon(r.article, cat(r.categoryId))}</span>{r.article}{r.uncertain ? ' ⚠' : ''}</span></td>
              <td className="num">{r.amount} €</td>
            </tr>
          ))}
        </tbody>
      </table>}
      {d.remark && <p className="muted small">{d.remark}</p>}
      <p className="small"><strong>Vérifiez avec le ticket :</strong> si tout est juste, enregistrez. Sinon, touchez « Corriger ».</p>
      <div className="stack" style={{ gap: 8 }}>
        <button className="btn-primary btn-big" disabled={saving || draftInvalid(d) || !kept.length} onClick={onSave}>
          {saving ? 'Enregistrement…' : `✓ Tout enregistrer (${[d.fuel ? 'le plein' : '', kept.length ? `${kept.length} achat${kept.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' et ')})`}
        </button>
        <button className="btn" disabled={saving} onClick={onCorrect}>✏️ Corriger une ligne</button>
      </div>
    </div>
  )
}

/**
 * Assistant : on lui parle, on lui écrit, on lui montre un ticket. Il répond sur les comptes,
 * cherche les meilleurs prix, encode, corrige et supprime à la demande.
 * Utilisé en page (#/assistant) et en panneau par-dessus n'importe quel écran.
 */
export function AssistantChat({ panel = false, onClose }: { panel?: boolean; onClose?: () => void }) {
  const { reload, dataChanged, categories, stores, ensureItem, ensureStore, period } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const [messages, setMessages] = useState<ChatMessage[]>(loadConversation)
  const [conversationId, setConversationId] = useState<number | null>(loadCurrentId)
  /** Résumé des anciens messages (compactage fait par le serveur) et nombre de messages qu'il couvre. */
  const [summary, setSummary] = useState<{ resume: string | null; count: number }>({ resume: null, count: 0 })
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  /** Groupe de la conversation en cours (ou choisi pour la prochaine nouvelle conversation). */
  const [group, setGroup] = useState<string | null>(null)
  const [past, setPast] = useState<ConversationRow[] | null>(null)
  const [showPast, setShowPast] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<false | 'question' | 'ticket'>(false)
  const [savingTicket, setSavingTicket] = useState<number | null>(null)
  const [speaking, setSpeaking] = useState<number | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef<false | 'question' | 'ticket'>(false)
  busyRef.current = busy
  /** Photos des tickets lus pendant cette session (pour l'écran « Corriger »). */
  const photos = useRef(new Map<number, string>())
  /** Vrai quand l'utilisateur vient de commencer une nouvelle conversation (à ne pas remplacer). */
  const startedNewRef = useRef(false)
  const conversationIdRef = useRef<number | null>(null)
  const syncedAtRef = useRef<string | null>(null)
  const savingRef = useRef(false)

  // Écran et mois affichés derrière le panneau (ou avant d'ouvrir l'assistant)
  const screenPath = (location.state as { from?: string } | null)?.from ?? location.pathname + location.search
  const screen = SCREENS.find(([re]) => re.test(screenPath))?.[1] ?? null

  const dictation = useDictation((text) => void send(text, true))

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore(messages).slice(-40)))
      if (conversationId) localStorage.setItem(CURRENT_KEY, String(conversationId))
      else localStorage.removeItem(CURRENT_KEY)
    } catch { /* ignoré */ }
    if (!showPast) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy, conversationId, showPast, dictation.interim])

  conversationIdRef.current = conversationId
  syncedAtRef.current = syncedAt
  savingRef.current = savingTicket !== null

  function show(row: ConversationRow) {
    setGroup(row.groupe)
    setConversationId(row.id)
    setMessages(row.messages ?? [])
    setSummary({ resume: row.resume, count: row.resume_count ?? 0 })
    setSyncedAt(row.updated_at)
  }

  // À l'ouverture (et au retour sur l'application) : reprendre la conversation la plus récente,
  // qu'elle ait été commencée sur ce téléphone ou sur un autre appareil.
  useEffect(() => {
    let cancelled = false
    // Ancienne conversation gardée seulement sur l'appareil (avant la sauvegarde en base) : effacée.
    if (loadCurrentId() === null) setMessages([])
    async function latest() {
      if (startedNewRef.current || busyRef.current || savingRef.current) return
      const { data } = await supabase.from('assistant_conversations')
        .select(CONVERSATION_FIELDS).order('updated_at', { ascending: false }).limit(1)
      const row = (data as ConversationRow[] | null)?.[0]
      if (cancelled || startedNewRef.current || busyRef.current || savingRef.current) return
      // La même conversation, déjà à jour ici : rien à recharger (évite d'écraser un enregistrement en cours)
      if (row && row.id === conversationIdRef.current && row.updated_at === syncedAtRef.current) return
      if (!row) {
        // Plus aucune conversation en base (effacées ailleurs) : la copie locale disparaît aussi.
        if (loadCurrentId() !== null) { setConversationId(null); setMessages([]); setSummary({ resume: null, count: 0 }); setSyncedAt(null) }
        return
      }
      show(row)
    }
    void checkOnlineVoice() // savoir tout de suite quelle voix lira les réponses
    const photo = takePendingPhoto()
    if (photo) void handlePhoto(photo)
    else void latest()
    const onVisible = () => { if (document.visibilityState === 'visible') void latest() }
    document.addEventListener('visibilitychange', onVisible)
    // « Parler à l'assistant » depuis l'accueil : l'écoute commence tout de suite.
    if (new URLSearchParams(location.search).get('parler') === '1' || (location.state as { parler?: boolean } | null)?.parler) {
      navigate(location.pathname, { replace: true, state: location.state })
      dictation.start()
    }
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible); stopSpeaking() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Enregistre la conversation en base ; renvoie son numéro. */
  async function persist(list: ChatMessage[], id: number | null, sum: { resume: string | null; count: number }): Promise<number | null> {
    const row = { titre: titleOf(list), messages: toStore(list), resume: sum.resume, resume_count: sum.count, updated_at: new Date().toISOString() }
    const res = id
      ? await supabase.from('assistant_conversations').update(row).eq('id', id).select('id, updated_at').single()
      : await supabase.from('assistant_conversations').insert({ ...row, groupe: group ?? guessGroup(list) }).select('id, updated_at, groupe').single()
    if (!id && res.data) setGroup((res.data as unknown as { groupe: string | null }).groupe)
    if (res.error || !res.data) { setSaveError(true); return id }
    setSaveError(false)
    setSyncedAt(res.data.updated_at as string)
    return res.data.id as number
  }

  /** Repart de la version en base si la conversation a continué sur un autre appareil. */
  async function freshBase(): Promise<{ base: ChatMessage[]; sum: { resume: string | null; count: number } }> {
    let base = messages
    let sum = summary
    if (conversationId) {
      const { data } = await supabase.from('assistant_conversations').select(CONVERSATION_FIELDS).eq('id', conversationId).maybeSingle()
      const row = data as ConversationRow | null
      if (row && row.updated_at !== syncedAt) {
        base = row.messages ?? []
        sum = { resume: row.resume, count: row.resume_count ?? 0 }
      }
    }
    return { base, sum }
  }

  async function openPast() {
    setShowPast(true)
    setPast(null)
    const { data } = await supabase.from('assistant_conversations')
      .select(CONVERSATION_FIELDS).order('updated_at', { ascending: false }).limit(50)
    setPast((data as ConversationRow[] | null) ?? [])
  }

  function resumeConversation(c: ConversationRow) {
    startedNewRef.current = false
    show(c)
    setShowPast(false)
  }

  async function remove(c: ConversationRow) {
    if (!confirm(`Supprimer la conversation « ${c.titre || 'sans titre'} » ?`)) return
    const { error } = await supabase.from('assistant_conversations').delete().eq('id', c.id)
    if (error) { alert("La conversation n'a pas pu être supprimée. Vérifiez la connexion internet."); return }
    setPast((p) => p?.filter((x) => x.id !== c.id) ?? null)
    if (c.id === conversationId) startNew()
  }

  async function moveTo(c: ConversationRow, target: string) {
    let name = target
    if (target === '__nouveau__') {
      name = (prompt('Nom du nouveau groupe (par exemple « Santé », « Voiture ») :') ?? '').trim()
      if (!name) return
    }
    const { error } = await supabase.from('assistant_conversations').update({ groupe: name }).eq('id', c.id)
    if (error) { alert("La conversation n'a pas pu être déplacée. Vérifiez la connexion internet."); return }
    setPast((p) => p?.map((x) => (x.id === c.id ? { ...x, groupe: name } : x)) ?? null)
    if (c.id === conversationId) setGroup(name)
  }

  async function removeAll() {
    if (!confirm('Effacer toutes les conversations avec l\'assistant ? Vos comptes ne sont pas touchés.')) return
    const { error } = await supabase.from('assistant_conversations').delete().gt('id', 0)
    if (error) { alert("Les conversations n'ont pas pu être effacées. Vérifiez la connexion internet."); return }
    setPast([])
    startNew()
  }

  function startNew(inGroup: string | null = null) {
    setGroup(inGroup)
    startedNewRef.current = true
    stopSpeaking(); setSpeaking(null)
    setConversationId(null)
    setMessages([])
    setSummary({ resume: null, count: 0 })
    setSyncedAt(null)
    setShowPast(false)
  }

  function listen(i: number, text: string) {
    unlockAudio()
    if (speaking === i) { stopSpeaking(); setSpeaking(null); return }
    setSpeaking(i)
    speak(text, () => setSpeaking((s) => (s === i ? null : s)))
  }

  async function send(text: string, voice = false) {
    const question = text.trim()
    if (!question || busyRef.current) return
    if (voice) unlockAudio() // la réponse sera lue : le son doit être autorisé pendant le geste
    stopSpeaking(); setSpeaking(null)
    setBusy('question')
    setInput('')
    let { base, sum } = await freshBase()
    const next: ChatMessage[] = [...base, { role: 'user', content: question, ...(voice ? { voice } : {}) }]
    setMessages(next)
    // La question est gardée tout de suite : elle reste visible sur les autres appareils même sans réponse.
    const id = await persist(next, conversationId, sum)
    setConversationId(id)
    if (id) startedNewRef.current = false
    try {
      // Les messages déjà résumés ne sont pas renvoyés : le résumé les remplace.
      const context = toStore(next).slice(sum.count).map(({ role, content }) => ({ role, content }))
      const { data, error } = await supabase.functions.invoke('comptes-assistant', {
        body: { messages: context, resume: sum.resume, conversation_id: id, voix: voice, ecran: { page: screen, mois: period } },
      })
      if (error) {
        let message = "L'assistant n'a pas pu répondre. Vérifiez la connexion internet et réessayez."
        try {
          const body = await (error as { context?: Response }).context?.json()
          if (body?.error) message = body.error
        } catch { /* réponse non JSON */ }
        throw new Error(message)
      }
      const reply = (data?.reply as string) ?? "Je n'ai pas trouvé de réponse."
      const compacted = data?.compacted as { resume: string; couverts: number } | null
      if (compacted) sum = { resume: compacted.resume, count: sum.count + compacted.couverts }
      const final: ChatMessage[] = [...next, { role: 'assistant', content: reply, sources: data?.sources ?? [], ...(data?.a_valider ? { validate: true } : {}) }]
      const nav = data?.navigation as { type: string; id?: number; ids?: number[]; groupe?: string | null } | null
      const deletedCurrent = nav?.type === 'supprimees' && id != null && (nav.ids ?? []).includes(id)
      setMessages(final)
      setSummary(sum)
      if (!deletedCurrent) await persist(final, id, sum)
      if (data?.modifie) dataChanged() // l'écran affiché derrière se recharge
      void reload() // l'assistant a pu créer des articles ou des magasins
      // Conversations : nouvelle, reprise, rangée, effacée (demandé à l'assistant)
      if (nav?.type === 'nouvelle') startNew(nav.groupe ?? null)
      else if (nav?.type === 'ouvrir' && nav.id) {
        const { data: row } = await supabase.from('assistant_conversations').select(CONVERSATION_FIELDS).eq('id', nav.id).maybeSingle()
        if (row) { startedNewRef.current = false; show(row as ConversationRow) }
      } else if (nav?.type === 'rangee' && nav.id === id) setGroup(nav.groupe ?? null)
      else if (deletedCurrent) {
        // La conversation n'existe plus : on repart d'une page blanche, avec la confirmation de l'assistant
        startNew(group)
        setMessages([{ role: 'assistant', content: reply }])
      }
      if (voice) { setSpeaking(nav ? null : final.length - 1); speak(reply, () => setSpeaking(null)) }
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: (e as Error).message, error: true }])
    } finally {
      setBusy(false)
    }
  }

  async function handlePhoto(file: File | undefined) {
    if (!file || busyRef.current) return
    stopSpeaking(); setSpeaking(null)
    setBusy('ticket')
    let dataUrl: string
    let thumb: string | undefined
    try {
      dataUrl = await compressPhoto(file)
      thumb = await thumbnail(dataUrl).catch(() => undefined)
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: "Je n'arrive pas à ouvrir cette photo. Réessayez.", error: true }])
      setBusy(false)
      return
    }
    let { base, sum } = await freshBase()
    const next: ChatMessage[] = [...base, { role: 'user', content: '📷 Photo d\'un ticket de caisse', image: thumb }]
    setMessages(next)
    try {
      const draft = await readTicket(dataUrl, categories, stores)
      const final: ChatMessage[] = [...next, { role: 'assistant', content: ticketText(draft, categories), ticket: { draft, recap: null } }]
      photos.current.set(final.length - 1, dataUrl)
      setMessages(final)
      const id = await persist(final, conversationId, sum)
      setConversationId(id)
      if (id) startedNewRef.current = false
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: (e as Error).message, error: true }])
    } finally {
      setBusy(false)
    }
    void sum
  }

  async function saveCard(i: number) {
    const m = messages[i]
    if (!m.ticket || m.ticket.recap) return
    const d = m.ticket.draft
    const gap = draftGap(d)
    if (gap != null && Math.abs(gap) > 0.02 && !confirm(`Le total des lignes (${eur(draftSum(d))}) ne correspond pas au ticket (${eur(d.total!)}). Enregistrer quand même ?`)) return
    setSavingTicket(i)
    try {
      let recap
      try {
        recap = await saveTicket(d, { categories, ensureItem, ensureStore })
      } catch (e) {
        if (!(e instanceof DuplicateTicketError)) throw e
        if (!confirm(`${e.message}\n\nAvez-vous photographié deux fois le même ticket ? Touchez « Annuler » pour ne pas l'enregistrer une deuxième fois, ou « OK » si c'est vraiment un autre achat.`)) {
          const final = messages.map((x, j) => (j === i ? { ...x, content: `${x.content}\n(Non enregistré : déjà enregistré auparavant.)`, ticket: undefined } : x))
          setMessages(final)
          await persist(final, conversationId, summary)
          return
        }
        recap = await saveTicket(d, { categories, ensureItem, ensureStore }, { force: true })
      }
      const final = messages.map((x, j) => (j === i ? { ...x, content: ticketText(d, categories, recap), ticket: { draft: d, recap } } : x))
      setMessages(final)
      await persist(final, conversationId, summary)
      dataChanged()
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setSavingTicket(null)
    }
  }

  function correctCard(i: number) {
    const m = messages[i]
    if (!m.ticket) return
    // Position du message dans la conversation gardée en base (sans les messages d'erreur)
    const storedIndex = messages.slice(0, i).filter((x) => !x.error).length
    storeHandoff({ draft: m.ticket.draft, preview: photos.current.get(i) ?? null, conversationId, messageIndex: storedIndex })
    onClose?.()
    navigate('/ticket')
  }

  const lastQuestion = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''

  if (showPast) {
    return (
      <div className={`stack ${panel ? 'chat-panel-body' : ''}`}>
        <div className="spread">
          <h1>Conversations</h1>
          <button className="btn-ghost" onClick={() => setShowPast(false)}>Retour</button>
        </div>
        <button className="btn-primary btn-big btn-block" onClick={() => startNew()}>+ Nouvelle conversation</button>
        {past === null && <p className="muted">Chargement…</p>}
        {past?.length === 0 && <p className="muted">Aucune conversation enregistrée.</p>}
        {past && past.length > 0 && (() => {
          // Groupes : du plus récemment utilisé au plus ancien
          const names: string[] = []
          for (const c of past) { const g = c.groupe ?? 'Sans groupe'; if (!names.includes(g)) names.push(g) }
          const allNames = [...names, ...DEFAULT_GROUPS.filter((g) => !names.includes(g))]
          return names.map((g) => {
            const list = past.filter((c) => (c.groupe ?? 'Sans groupe') === g)
            return (
              <section key={g} className="conv-group">
                <div className="spread conv-group-head">
                  <h2>📁 {g} <span className="muted small">({list.length})</span></h2>
                  <button className="btn-ghost small" onClick={() => startNew(g === 'Sans groupe' ? null : g)}>+ Nouvelle ici</button>
                </div>
                <div className="list">
                  {list.map((c) => (
                    <div key={c.id} className="conv-item">
                      <button className="btn-ghost conv-open" onClick={() => resumeConversation(c)}>
                        <span style={{ fontWeight: c.id === conversationId ? 700 : 400 }}>{c.titre || 'Sans titre'}</span>
                        <span className="muted small">{shortDate(c.updated_at)} · {c.messages?.length ?? 0} message{(c.messages?.length ?? 0) > 1 ? 's' : ''}{c.id === conversationId ? ' · en cours' : ''}</span>
                      </button>
                      <div className="row conv-actions">
                        <select aria-label={`Déplacer « ${c.titre} » dans un autre groupe`} value="" onChange={(e) => { if (e.target.value) void moveTo(c, e.target.value) }}>
                          <option value="">📁 Déplacer…</option>
                          {allNames.filter((n) => n !== g && n !== 'Sans groupe').map((n) => <option key={n} value={n}>{n}</option>)}
                          <option value="__nouveau__">+ Nouveau groupe…</option>
                        </select>
                        <button className="btn-ghost btn-danger" aria-label={`Supprimer la conversation « ${c.titre} »`} onClick={() => remove(c)}>🗑</button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )
          })
        })()}
        <p className="muted small">Les conversations sont gardées sur votre compte : vous les retrouvez sur tous vos appareils. Elles ne s'effacent pas toutes seules : supprimez-les ici quand vous le souhaitez.</p>
        {past && past.length > 0 && (
          <button className="btn btn-danger" onClick={() => void removeAll()}>🗑 Effacer toutes les conversations</button>
        )}
      </div>
    )
  }

  const canDictate = dictationSupported()

  return (
    <div className={`chat ${panel ? 'chat-panel-body' : 'stack'}`}>
      <div className="spread chat-head">
        <h1>Assistant</h1>
        {panel && <button className="btn-ghost chat-close" onClick={onClose} aria-label="Fermer l'assistant">✕ Fermer</button>}
      </div>
      <div className="row chat-tools">
        <button className="btn-ghost small" onClick={() => void openPast()}>🕘 Conversations{group ? <> · 📁 {group}</> : null}</button>
        {messages.length > 0 && <button className="btn-ghost small" onClick={() => startNew()}>+ Nouvelle</button>}
      </div>
      {panel && screen && <p className="muted small chat-context">Vous regardez : {screen.split(' (')[0]} · <span className="capitalize">{periodLabel(period)}</span></p>}
      {saveError && <p className="alert small" style={{ margin: 0 }}>La conversation n'a pas pu être sauvegardée (connexion ?). Elle reste sur cet appareil.</p>}

      <div className="chat-scroll">
        {messages.length === 0 && !busy && (
          <div className="card stack" style={{ gap: 10 }}>
            <p style={{ margin: 0 }}>
              <strong>Parlez-moi</strong> ou <strong>montrez-moi un ticket</strong> : je l'enregistre. Posez-moi aussi vos questions sur vos dépenses,
              ou demandez où un produit est le moins cher. Je peux corriger ou supprimer ce qui est encodé.
            </p>
            <p className="muted small" style={{ margin: 0 }}>
              Quand vous me dictez une dépense, je vous montre d'abord un résumé à valider. Mes réponses peuvent contenir des erreurs : vérifiez les prix en magasin.
            </p>
            <div className="stack" style={{ gap: 8 }}>
              {SUGGESTIONS.map((s) => (
                <button key={s} className="btn" style={{ justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => void send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        <div className="stack" style={{ gap: 12 }}>
          {messages.map((m, i) => (m.ticket
            ? <TicketCard key={i} m={m} saving={savingTicket === i} onSave={() => void saveCard(i)} onCorrect={() => correctCard(i)}
                onDraft={(d) => setMessages((list) => list.map((x, j) => (j === i && x.ticket ? { ...x, ticket: { ...x.ticket, draft: d } } : x)))} />
            : (
              <div key={i} className={`bubble ${m.role}${m.error ? ' error' : ''}`}>
                {m.image && <img src={m.image} alt="Photo du ticket" className="bubble-photo" />}
                {m.role === 'assistant' ? <Formatted text={m.content} /> : <p>{m.voice ? '🎤 ' : ''}{m.content}</p>}
                {m.sources && m.sources.length > 0 && (
                  <div className="sources">
                    <span className="muted small">Sources :</span>
                    {m.sources.map((s) => (
                      <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="small">{s.title}</a>
                    ))}
                  </div>
                )}
                {m.validate && i === messages.length - 1 && !busy && (
                  <div className="validate-actions">
                    <button className="btn-primary btn-big" onClick={() => void send("Oui, c'est juste, enregistre.", true)}>✓ Oui, j'enregistre</button>
                    <button className="btn btn-big" onClick={() => void send("Non, n'enregistre rien.", true)}>✗ Non</button>
                  </div>
                )}
                {m.role === 'assistant' && !m.error && (
                  <button className="btn-ghost listen-btn" onClick={() => listen(i, m.content)} aria-label={speaking === i ? 'Arrêter la lecture' : 'Écouter la réponse'}>
                    {speaking === i ? '⏹ Arrêter' : '🔊 Écouter'}
                  </button>
                )}
              </div>
            )))}
          {dictation.listening && (
            <div className="bubble user listening-bubble" aria-live="polite">
              <p>{dictation.interim || 'Je vous écoute…'}</p>
            </div>
          )}
          {busy && <ThinkingBubble question={lastQuestion} ticket={busy === 'ticket'} />}
          <div ref={endRef} />
        </div>
      </div>

      <div className="chat-dock">
        {dictation.error && (
          <p className="alert small" style={{ margin: 0 }}>
            {dictation.error} <button className="btn-ghost small" onClick={dictation.clearError}>OK</button>
          </p>
        )}
        <div className="chat-actions">
          <label className={`btn chat-action${busy ? ' disabled' : ''}`} aria-label="Photographier un ticket">
            <span aria-hidden="true">📷</span><span>Ticket</span>
            <input type="file" accept="image/*" capture="environment" hidden disabled={Boolean(busy)}
              onChange={(e) => { void handlePhoto(e.target.files?.[0]); e.target.value = '' }} />
          </label>
          {canDictate && (
            <button className={`chat-action mic${dictation.listening ? ' on' : ''}`} disabled={Boolean(busy)}
              onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
              aria-label={dictation.listening ? "Arrêter l'écoute et envoyer" : 'Parler'}>
              <span aria-hidden="true">{dictation.listening ? '⏹' : '🎤'}</span>
              <span>{dictation.listening ? 'Envoyer' : 'Parler'}</span>
            </button>
          )}
        </div>
        <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send(input) }}>
          <textarea
            rows={1}
            value={input}
            placeholder="… ou écrivez ici"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input) } }}
            disabled={Boolean(busy)}
            aria-label="Votre question"
          />
          <button className="btn-primary" disabled={Boolean(busy) || !input.trim()} aria-label="Envoyer">Envoyer</button>
        </form>
      </div>
    </div>
  )
}
