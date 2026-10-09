import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useApp } from '../lib/app'
import { supabase } from '../lib/supabase'

interface Source { url: string; title: string }
interface ChatMessage { role: 'user' | 'assistant'; content: string; sources?: Source[]; error?: boolean }

const STORAGE_KEY = 'comptes.assistant.conversation'
const SUGGESTIONS = [
  'Combien ai-je dépensé ce mois-ci ?',
  'Où acheter les bananes le moins cher cette semaine ?',
  'Quelles dépenses ont augmenté ces derniers mois ?',
  'Quelles factures annuelles dois-je encore prévoir ?',
]

function loadConversation(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ChatMessage[]) : []
  } catch {
    return []
  }
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

const STEPS_DATA = [
  'Je consulte vos comptes…',
  'Je fais les additions…',
  'Je compare avec les mois précédents…',
  'Je prépare la réponse…',
]
const STEPS_PRICES = [
  'Je regarde ce que vous payez d\'habitude…',
  'Je cherche les prix sur les sites des magasins…',
  'Je parcours les dépliants de la semaine…',
  'Je compare les magasins…',
  'Je vérifie les promotions…',
  'Je prépare la réponse…',
]

/** Bulle d'attente animée : pièce qui tourne, points qui ondulent, étapes qui défilent. */
function ThinkingBubble({ question }: { question: string }) {
  const prices = /prix|cher|magasin|promo|achet|dépliant|meilleur/i.test(question)
  const steps = prices ? STEPS_PRICES : STEPS_DATA
  const [index, setIndex] = useState(0)
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const step = window.setInterval(() => setIndex((i) => Math.min(i + 1, steps.length - 1)), prices ? 9000 : 3500)
    const clock = window.setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => { window.clearInterval(step); window.clearInterval(clock) }
  }, [prices, steps.length])
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

/**
 * Assistant : répond aux questions sur les comptes et cherche les meilleurs prix
 * sur internet. Les échanges passent par la fonction serveur « comptes-assistant »
 * (la clé de l'IA n'est jamais dans l'application).
 */
export default function Assistant() {
  const { reload } = useApp()
  const [messages, setMessages] = useState<ChatMessage[]>(loadConversation)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40))) } catch { /* ignoré */ }
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

  async function send(text: string) {
    const question = text.trim()
    if (!question || busy) return
    const next: ChatMessage[] = [...messages, { role: 'user', content: question }]
    setMessages(next)
    setInput('')
    setBusy(true)
    try {
      const history = next.filter((m) => !m.error).map(({ role, content }) => ({ role, content }))
      const { data, error } = await supabase.functions.invoke('comptes-assistant', { body: { messages: history } })
      if (error) {
        let message = "L'assistant n'a pas pu répondre. Vérifiez la connexion internet et réessayez."
        try {
          const body = await (error as { context?: Response }).context?.json()
          if (body?.error) message = body.error
        } catch { /* réponse non JSON */ }
        throw new Error(message)
      }
      const reply = (data?.reply as string) ?? "Je n'ai pas trouvé de réponse."
      setMessages((m) => [...m, { role: 'assistant', content: reply, sources: data?.sources ?? [] }])
      void reload() // l'assistant a pu créer des articles ou des magasins
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: (e as Error).message, error: true }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack chat">
      <div className="spread">
        <h1>Assistant</h1>
        {messages.length > 0 && (
          <button className="btn-ghost small" onClick={() => { if (confirm('Effacer la conversation ?')) setMessages([]) }}>
            Nouvelle conversation
          </button>
        )}
      </div>

      {messages.length === 0 && (
        <div className="card stack" style={{ gap: 10 }}>
          <p style={{ margin: 0 }}>
            Posez une question sur vos dépenses, ou demandez où un produit est le moins cher :
            l'assistant consulte vos comptes et peut chercher les prix sur internet.
          </p>
          <div className="stack" style={{ gap: 8 }}>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="btn" style={{ justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => send(s)}>{s}</button>
            ))}
          </div>
        </div>
      )}

      <div className="stack" style={{ gap: 12 }}>
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}${m.error ? ' error' : ''}`}>
            {m.role === 'assistant' ? <Formatted text={m.content} /> : <p>{m.content}</p>}
            {m.sources && m.sources.length > 0 && (
              <div className="sources">
                <span className="muted small">Sources :</span>
                {m.sources.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="small">{s.title}</a>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <ThinkingBubble question={[...messages].reverse().find((m) => m.role === 'user')?.content ?? ''} />}
        <div ref={endRef} />
      </div>

      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send(input) }}>
        <textarea
          rows={2}
          value={input}
          placeholder="Votre question…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input) } }}
          disabled={busy}
        />
        <button className="btn-primary" disabled={busy || !input.trim()} aria-label="Envoyer">Envoyer</button>
      </form>
      <p className="muted small" style={{ margin: 0 }}>
        Les réponses peuvent contenir des erreurs : vérifiez les prix en magasin. Si l'assistant remarque une incohérence dans l'application, il la signale pour qu'elle soit corrigée.
      </p>
    </div>
  )
}
