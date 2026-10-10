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
interface ScanResult {
  type?: 'courses' | 'carburant'
  magasin: string | null; date: string | null; total_ticket: number | null; remarque: string | null; lignes: ScannedLine[]
  litres?: number | null; prix_litre?: number | null; montant_carburant?: number | null
}

/** Ligne éditable (les nombres restent du texte pendant la saisie) */
export interface TicketRow { keep: boolean; article: string; categoryId: number; amount: string; units: string; grams: string; ppk: string; discount: number | null; source: string; uncertain: boolean }

/** Plein d'essence lu sur un ticket de station-service (texte pendant la saisie). */
export interface FuelDraft { litres: string; ppl: string; amount: string; km: string }

/** Ticket lu, pas encore enregistré. */
export interface TicketDraft { store: string; date: string; total: number | null; remark: string | null; rows: TicketRow[]; fuel?: FuelDraft | null }

/** Ce qui a été enregistré (récapitulatif). */
export interface TicketRecap {
  store: string; date: string; period: string; lines: { article: string; category: string; amount: number }[]; total: number
  fuel?: { litres: number | null; amount: number; km: number | null } | null
}

/** Le même ticket semble déjà enregistré (photo prise deux fois). */
export class DuplicateTicketError extends Error {}

/** Nombre décimal sans arrondi au centime (prix au litre : 1,789 €). */
const decimal = (s: string) => { const v = Number(s.trim().replace(',', '.').replace(/\s/g, '')); return s.trim() && Number.isFinite(v) ? v : null }

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
  const isFuel = result.type === 'carburant' && result.montant_carburant != null
  if (!result.lignes?.length && !isFuel) throw new Error(result.remarque || "Aucun article n'a été trouvé sur la photo.")
  // Magasin : nom existant si possible
  const known = stores.find((s) => s.name.toLocaleLowerCase('fr') === (result.magasin ?? '').toLocaleLowerCase('fr'))
  return {
    store: known?.name ?? result.magasin ?? '',
    date: result.date && /^\d{4}-\d{2}-\d{2}$/.test(result.date) ? result.date : todayIso(),
    total: result.total_ticket,
    remark: result.remarque,
    fuel: isFuel ? { litres: txt(result.litres), ppl: txt(result.prix_litre), amount: txt(result.montant_carburant), km: '' } : null,
    rows: (result.lignes ?? []).map((l) => {
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
export const draftSum = (d: TicketDraft) => Math.round((keptRows(d).reduce((a, r) => a + (parseAmount(r.amount) ?? 0), 0) + (d.fuel ? parseAmount(d.fuel.amount) ?? 0 : 0)) * 100) / 100
/** Écart entre la somme des lignes et le total imprimé (null si le total n'a pas été lu). */
export const draftGap = (d: TicketDraft) => (d.total != null ? Math.round((draftSum(d) - d.total) * 100) / 100 : null)
export const draftInvalid = (d: TicketDraft) => keptRows(d).some((r) => !r.article.trim() || parseAmount(r.amount) == null)
  || (d.fuel != null && parseAmount(d.fuel.amount) == null)
  || (!keptRows(d).length && !d.fuel)

/** Enregistre les lignes cochées comme achats. */
export async function saveTicket(
  d: TicketDraft,
  ctx: { categories: Category[]; ensureItem: (categoryId: number, name: string) => Promise<Item>; ensureStore: (name: string) => Promise<Store> },
  options: { force?: boolean } = {},
): Promise<TicketRecap> {
  const period = periodForDate(d.date)
  const kept = keptRows(d)
  const fuelAmount = d.fuel ? parseAmount(d.fuel.amount) : null
  // Même ticket déjà enregistré (même jour, même magasin, même montant) ? On demande avant de doubler.
  if (!options.force) {
    const linesTotal = Math.round(kept.reduce((a, r) => a + (parseAmount(r.amount) ?? 0), 0) * 100) / 100
    const known = d.store.trim() ? (await supabase.from('stores').select('id, name')).data?.find((s) => s.name.toLocaleLowerCase('fr') === d.store.trim().toLocaleLowerCase('fr')) : undefined
    if (kept.length && known) {
      const { data } = await supabase.from('purchases').select('amount, ticket_id').eq('purchased_on', d.date).eq('store_id', known.id).not('ticket_id', 'is', null)
      const byTicket = new Map<string, { n: number; total: number }>()
      for (const p of (data ?? []) as { amount: number; ticket_id: string }[]) {
        const t = byTicket.get(p.ticket_id) ?? { n: 0, total: 0 }
        byTicket.set(p.ticket_id, { n: t.n + 1, total: t.total + Number(p.amount) })
      }
      const same = [...byTicket.values()].find((t) => t.n === kept.length && Math.abs(t.total - linesTotal) <= 0.02)
      if (same) throw new DuplicateTicketError(`Ce ticket semble déjà enregistré : ${same.n} achat${same.n > 1 ? 's' : ''} chez ${known.name} le ${d.date.split('-').reverse().join('/')} pour ${eur(same.total)}.`)
    }
    if (fuelAmount != null) {
      const { data } = await supabase.from('fuel_fills').select('id').eq('filled_on', d.date).eq('total', fuelAmount)
      if (data?.length) throw new DuplicateTicketError(`Ce plein semble déjà enregistré : ${eur(fuelAmount)} le ${d.date.split('-').reverse().join('/')}.`)
    }
  }
  const storeId = d.store.trim() && kept.length ? (await ctx.ensureStore(d.store.trim())).id : null
  const ticketId = crypto.randomUUID()
  const payload = []
  const lines: TicketRecap['lines'] = []
  for (const r of kept) {
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
      amount, note: 'ticket scanné', ticket_id: ticketId,
    })
    lines.push({ article: item.name, category: cat.name, amount })
  }
  if (payload.length) must(await supabase.from('purchases').insert(payload))
  let fuel: TicketRecap['fuel'] = null
  if (d.fuel && fuelAmount != null) {
    const litres = parseAmount(d.fuel.litres)
    const km = parseAmount(d.fuel.km)
    must(await supabase.from('fuel_fills').insert({
      period, station: d.store.trim() || 'Station', filled_on: d.date, total: fuelAmount,
      litres, price_per_litre: decimal(d.fuel.ppl), km: km != null ? Math.round(km) : null,
    }))
    fuel = { litres, amount: fuelAmount, km }
  }
  const total = lines.reduce((a, l) => a + l.amount, 0) + (fuel?.amount ?? 0)
  return { store: d.store.trim(), date: d.date, period, lines, total: Math.round(total * 100) / 100, fuel }
}

/** Texte du ticket pour l'assistant (il voit ainsi ce qui a été lu, puis enregistré). */
export function ticketText(d: TicketDraft, categories: Category[], recap?: TicketRecap | null): string {
  const cat = (id: number) => categories.find((c) => c.id === id)?.name ?? '?'
  const head = `Ticket de caisse lu : ${d.store || 'magasin non lu'}, le ${d.date}${d.total != null ? `, total imprimé ${eur(d.total)}` : ''}.`
  const fuelLine = (f: { litres: string | number | null; amount: string | number }) => `- Plein d'essence : ${f.litres ?? '?'} L, ${f.amount} € (onglet Essence)`
  if (recap) {
    return `${head}\nEnregistré par l'utilisateur (bouton) : ${recap.lines.length} achat(s)${recap.fuel ? ' et un plein' : ''}, ${eur(recap.total)}, compté(s) en ${periodLabel(recap.period)} :\n`
      + [...(recap.fuel ? [fuelLine(recap.fuel)] : []), ...recap.lines.map((l) => `- ${l.article} (${l.category}) : ${eur(l.amount)}`)].join('\n')
  }
  return `${head}\nLignes lues, PAS ENCORE ENREGISTRÉES (l'utilisateur doit toucher « Tout enregistrer » sous la fiche, ou « Corriger ») :\n`
    + [...(d.fuel ? [fuelLine(d.fuel)] : []), ...keptRows(d).map((r) => `- ${r.article} (${cat(r.categoryId)}) : ${r.amount} €${r.uncertain ? ' [à vérifier]' : ''}`)].join('\n')
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
