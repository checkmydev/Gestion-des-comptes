import { supabase } from './supabase'
import type { TicketDraft, TicketRecap } from './ticket'

export interface Source { url: string; title: string }

/** Ticket lu dans le chat : en attente de validation, puis enregistré. */
export interface ChatTicket { draft: TicketDraft; recap: TicketRecap | null; thumb?: string | null }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
  error?: boolean
  ticket?: ChatTicket
  /** Question dictée à voix haute (la réponse est alors lue). */
  voice?: boolean
  /** Résumé d'une demande dictée, en attente de validation par l'utilisateur. */
  validate?: boolean
  /** Vignette de la photo envoyée (affichage seulement, pas gardée en base). */
  image?: string
}

export interface ConversationRow { id: number; titre: string; groupe: string | null; updated_at: string; messages: ChatMessage[]; resume: string | null; resume_count: number }
export const CONVERSATION_FIELDS = 'id, titre, groupe, updated_at, messages, resume, resume_count'

/** Groupes proposés d'office (l'utilisateur peut en créer d'autres). */
export const DEFAULT_GROUPS = ['Tickets', 'Encodage', 'Questions', 'Prix et courses']

/** Groupe d'une nouvelle conversation, deviné d'après son premier message. */
export function guessGroup(list: ChatMessage[]): string {
  const first = list.find((m) => m.role === 'user')?.content ?? ''
  if (list.some((m) => m.ticket) || first.startsWith('📷')) return 'Tickets'
  if (/prix|moins cher|magasin|promo|d[ée]pliant|o[uù] acheter/i.test(first)) return 'Prix et courses'
  if (/j'ai (pay[ée]|achet[ée]|d[ée]pens[ée])|ajoute|enregistre|corrige|supprime|annule|modifie|remplace|mets? /i.test(first)) return 'Encodage'
  return 'Questions'
}

/** Ce qui est gardé en base : pas les erreurs de connexion, pas les miniatures de photo. */
export const toStore = (list: ChatMessage[]) => list.filter((m) => !m.error).map(({ role, content, sources, ticket, voice, validate }) => ({
  role, content,
  ...(sources?.length ? { sources } : {}),
  ...(ticket ? { ticket: { draft: ticket.draft, recap: ticket.recap } } : {}),
  ...(voice ? { voice } : {}),
  ...(validate ? { validate } : {}),
}))

export const titleOf = (list: ChatMessage[]) => {
  const first = list.find((m) => m.role === 'user')
  const q = first?.content.startsWith('📷') ? `Ticket ${list.find((m) => m.ticket)?.ticket?.draft.store ?? ''}`.trim() : first?.content.trim() ?? ''
  return q.length > 70 ? `${q.slice(0, 67)}…` : q
}

/** Remplace un message d'une conversation en base (ex. ticket validé depuis l'écran détaillé). */
export async function patchConversationMessage(conversationId: number, index: number, patch: Partial<ChatMessage>) {
  const { data } = await supabase.from('assistant_conversations').select('messages').eq('id', conversationId).maybeSingle()
  const messages = (data?.messages ?? []) as ChatMessage[]
  if (!messages[index]) return
  messages[index] = { ...messages[index], ...patch }
  await supabase.from('assistant_conversations').update({ messages: toStore(messages), updated_at: new Date().toISOString() }).eq('id', conversationId)
}
