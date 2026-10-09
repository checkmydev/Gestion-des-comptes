import { must } from './api'
import { eur, parseAmount, todayIso } from './format'
import { periodForDate, periodLabel } from './period'
import { supabase } from './supabase'
import type { Category, Item, Store } from './types'

/** Ligne lue par la fonction serveur « comptes-ticket ». */
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
export interface TicketRow { keep: boolean; article: string; categoryId: number; amount: string; units: string; grams: string; ppk: string; discount: number | null; source: string; uncertain: boolean }

/** Ticket lu, pas encore enregistré. */
export interface TicketDraft { store: string; date: string; total: number | null; remark: string | null; rows: TicketRow[] }

/** Ce qui a été enregistré (récapitulatif). */
export interface TicketRecap { store: string; date: string; period: string; lines: { article: string; category: string; amount: number }[]; total: number }

const txt = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','))

/** Réduit la photo (côté le plus long : 1600 px) avant l'envoi. */
export async function compressPhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.82)
}

/** Envoie la photo (déjà réduite) à la lecture automatique et prépare les lignes à vérifier. */
export async function readTicket(dataUrl: string, categories: Category[], stores: Store[]): Promise<TicketDraft> {
  const active = categories.filter((c) => !c.archived)
  const { data, error } = await supabase.functions.invoke('comptes-ticket', {
    body: { image: dataUrl.split(',')[1], media_type: 'image/jpeg' },
  })
  if (error) {
    let message = 'La lecture du ticket a échoué. Vérifiez la connexion internet et réessayez.'
    try { const body = await (error as { context?: Response }).context?.json(); if (body?.error) message = body.error } catch { /* ignoré */ }
    throw new Error(message)
  }
  const result = data as ScanResult
  if (!result.lignes?.length) throw new Error(result.remarque || "Aucun article n'a été trouvé sur la photo.")
  // Magasin : nom existant si possible
  const known = stores.find((s) => s.name.toLocaleLowerCase('fr') === (result.magasin ?? '').toLocaleLowerCase('fr'))
  return {
    store: known?.name ?? result.magasin ?? '',
    date: result.date && /^\d{4}-\d{2}-\d{2}$/.test(result.date) ? result.date : todayIso(),
    total: result.total_ticket,
    remark: result.remarque,
    rows: result.lignes.map((l) => {
      const cat = active.find((c) => c.name === l.categorie) ?? active.find((c) => c.name === 'Divers') ?? active[0]
      return {
        keep: true, article: l.article, categoryId: cat.id, amount: txt(l.montant),
        units: l.nombre && l.nombre > 1 ? String(l.nombre) : '', grams: txt(l.poids_g), ppk: txt(l.prix_kg),
        discount: l.remise, source: l.texte_ticket, uncertain: l.incertain,
      }
    }),
  }
}

export const keptRows = (d: TicketDraft) => d.rows.filter((r) => r.keep)
export const draftSum = (d: TicketDraft) => Math.round(keptRows(d).reduce((a, r) => a + (parseAmount(r.amount) ?? 0), 0) * 100) / 100
/** Écart entre la somme des lignes et le total imprimé (null si le total n'a pas été lu). */
export const draftGap = (d: TicketDraft) => (d.total != null ? Math.round((draftSum(d) - d.total) * 100) / 100 : null)
export const draftInvalid = (d: TicketDraft) => keptRows(d).some((r) => !r.article.trim() || parseAmount(r.amount) == null)

/** Enregistre les lignes cochées comme achats. */
export async function saveTicket(
  d: TicketDraft,
  ctx: { categories: Category[]; ensureItem: (categoryId: number, name: string) => Promise<Item>; ensureStore: (name: string) => Promise<Store> },
): Promise<TicketRecap> {
  const storeId = d.store.trim() ? (await ctx.ensureStore(d.store.trim())).id : null
  const period = periodForDate(d.date)
  const payload = []
  const lines: TicketRecap['lines'] = []
  for (const r of keptRows(d)) {
    const cat = ctx.categories.find((c) => c.id === r.categoryId)!
    const item = await ctx.ensureItem(cat.id, r.article)
    const amount = parseAmount(r.amount)!
    const grams = cat.weighed ? parseAmount(r.grams) : null
    const ppk = cat.weighed ? parseAmount(r.ppk) : null
    const units = !cat.weighed ? Math.round(parseAmount(r.units) ?? 1) : 1
    const promo = r.discount && r.discount > 0 ? Math.round((r.discount / (amount + r.discount)) * 1000) / 10 : null
    payload.push({
      period, item_id: item.id, store_id: storeId, purchased_on: d.date,
      quantity_g: grams, price_per_kg: ppk, promo_pct: promo, units: units > 1 ? units : null,
      amount, note: 'ticket scanné',
    })
    lines.push({ article: item.name, category: cat.name, amount })
  }
  must(await supabase.from('purchases').insert(payload))
  return { store: d.store.trim(), date: d.date, period, lines, total: Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100 }
}

/** Texte du ticket pour l'assistant (il voit ainsi ce qui a été lu, puis enregistré). */
export function ticketText(d: TicketDraft, categories: Category[], recap?: TicketRecap | null): string {
  const cat = (id: number) => categories.find((c) => c.id === id)?.name ?? '?'
  const head = `Ticket de caisse lu : ${d.store || 'magasin non lu'}, le ${d.date}${d.total != null ? `, total imprimé ${eur(d.total)}` : ''}.`
  if (recap) {
    return `${head}\nEnregistré par l'utilisateur (bouton) : ${recap.lines.length} achat(s), ${eur(recap.total)}, compté(s) en ${periodLabel(recap.period)} :\n`
      + recap.lines.map((l) => `- ${l.article} (${l.category}) : ${eur(l.amount)}`).join('\n')
  }
  return `${head}\nLignes lues, PAS ENCORE ENREGISTRÉES (l'utilisateur doit toucher « Tout enregistrer » sous la fiche, ou « Corriger ») :\n`
    + keptRows(d).map((r) => `- ${r.article} (${cat(r.categoryId)}) : ${r.amount} €${r.uncertain ? ' [à vérifier]' : ''}`).join('\n')
}

// Passage d'un ticket du chat vers l'écran de vérification détaillée, et retour.
const DRAFT_KEY = 'comptes.ticket.draft'
export interface DraftHandoff { draft: TicketDraft; preview: string | null; conversationId: number | null; messageIndex: number }
export function storeHandoff(h: DraftHandoff) {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(h)) } catch {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...h, preview: null })) } catch { /* ignoré */ }
  }
}
export function takeHandoff(): DraftHandoff | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    sessionStorage.removeItem(DRAFT_KEY)
    return raw ? (JSON.parse(raw) as DraftHandoff) : null
  } catch { return null }
}

/** Photo choisie depuis l'accueil, à lire dès l'ouverture de l'assistant. */
let pendingPhoto: File | null = null
export const setPendingPhoto = (f: File | null) => { pendingPhoto = f }
export const takePendingPhoto = () => { const f = pendingPhoto; pendingPhoto = null; return f }
