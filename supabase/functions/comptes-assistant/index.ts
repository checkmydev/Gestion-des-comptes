// Assistant de l'application Comptes (Supabase Edge Function).
//
// - Garde la clé Anthropic côté serveur (secret COMPTES_ANTHROPIC_API_KEY), jamais dans l'application.
//   Les secrets Supabase sont communs à tout le projet : ANTHROPIC_API_KEY appartient à une
//   autre application et n'est volontairement jamais utilisé ici.
// - N'accepte que les comptes listés dans le secret ALLOWED_EMAILS (l'authentification
//   Supabase est partagée avec d'autres applications).
// - Lit les données avec la session de l'utilisateur : les règles RLS s'appliquent.
// - Outils : données des comptes (lecture), recherche et lecture de pages web
//   (outils serveur Anthropic), enregistrement des prix relevés (sur demande).
import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0'
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3'

const MODEL = 'claude-opus-5-5'
const MAX_STEPS = 10 // garde-fou de la boucle d'agent

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// ---------------------------------------------------------------------------
// Consignes (stables : mises en cache)
// ---------------------------------------------------------------------------
const SYSTEM = `Tu es l'assistant de l'application « Comptes », utilisée par un retraité belge pour suivre ses dépenses courantes. Tu lui parles en français, en le vouvoyant, simplement et chaleureusement, sans jargon. Réponses courtes et concrètes ; des listes à puces quand c'est utile.

Ce que tu sais du fonctionnement de ses comptes :
- Le mois comptable commence le 26 (jour de la pension) : « octobre » va du 26 septembre au 25 octobre. Une période s'écrit AAAA-MM-01.
- Dépenses courantes par catégories (Légumes, Divers, Viande & jambon, Restos & sorties, Médocs & toubibs…), saisies achat par achat. Les Légumes ont un prix au kilo ; « units » est le nombre d'unités achetées.
- Global du mois : rentrées (pension), dépenses fixes (loyer, électricité, GSM…), essence.
- Les dépenses annuelles (assurances, taxes, eau, hospitalisation…) forment une enveloppe à part, payée par l'épargne, avec un plafond annuel.
- Magasins habituels en Belgique : Delhaize, Carrefour, Lidl, Colruyt, Aldi, Intermarché, Spar, boulangerie Berlo…

Règles :
- Pour toute question sur ses dépenses, utilise les outils de données ; n'invente jamais un montant. Si une donnée manque, dis-le.
- Pour trouver le meilleur prix d'un produit, utilise la recherche web sur les sites des enseignes belges (delhaize.be, colruyt.be, lidl.be, aldi.be, carrefour.eu, intermarche.be…) et compare au prix qu'il paie d'habitude (outil historique_prix). Compare des produits équivalents (même format ou prix au kilo), signale les promotions et leur date de fin si elle est connue. Donne toujours tes sources (enseigne et lien), et précise qu'un prix en ligne peut différer en magasin. Pense aussi aux dépliants promotionnels de la semaine. Certaines pages produits ne se laissent pas lire et, chez Colruyt, le prix dépend du magasin choisi : si un prix reste introuvable, dis précisément pourquoi pour cette enseigne (n'écris pas que la recherche est « indisponible »).
- Termine une recherche de prix par les liens complets (URL) des pages utilisées.
- N'enregistre des prix (outil enregistrer_prix_releves) que si l'utilisateur te le demande explicitement, ou après lui avoir proposé et obtenu son accord dans la conversation.
- Montants en euros au format belge (1 234,56 €). Arrondis raisonnablement.
- Tu peux conseiller (où acheter moins cher, quel poste surveiller), sans moraliser.
- Quand l'utilisateur exprime une préférence ou une remarque durable (façon de présenter, habitudes, informations le concernant), enregistre-la avec l'outil retenir, puis respecte-la ; si elle devient fausse, utilise oublier. Ne promets jamais de te souvenir de quelque chose sans l'avoir enregistré. Les notes déjà mémorisées te sont données plus bas.
- Quand l'utilisateur fait une remarque sur ses données (« il manque… », « ce montant est faux… »), vérifie toujours avec les outils avant de répondre, et explique ce que tu as trouvé.
- Si une question révèle une incohérence de l'application elle-même (un total qui ne correspond pas, une donnée contradictoire ou dupliquée, un calcul faux, un écran qui ne fait pas ce qu'il devrait, une fonction qui manque vraiment), utilise l'outil signaler_probleme : décris précisément ce qui ne va pas, avec les chiffres et les périodes concernés, et une piste de correction. Dis ensuite à l'utilisateur, en une phrase, que le problème a été signalé pour être corrigé. Ne signale pas une simple question ou une préférence.`

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------
const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 12, user_location: { type: 'approximate', country: 'BE', timezone: 'Europe/Brussels' } },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 10 },
  {
    name: 'resume_mois',
    description: "Résumé d'un mois comptable : total par catégorie, budgets, rentrées, dépenses fixes, essence. Sans période : le mois en cours.",
    input_schema: { type: 'object', properties: { periode: { type: 'string', description: 'AAAA-MM-01' } }, additionalProperties: false },
  },
  {
    name: 'depenses_par_mois',
    description: 'Total des dépenses courantes par mois et par catégorie sur une plage de mois (par défaut les 12 derniers).',
    input_schema: {
      type: 'object',
      properties: { depuis: { type: 'string', description: 'AAAA-MM-01' }, jusqua: { type: 'string', description: 'AAAA-MM-01' } },
      additionalProperties: false,
    },
  },
  {
    name: 'chercher_achats',
    description: 'Liste des achats filtrés (texte dans le nom de l\'article, catégorie, magasin, dates). Renvoie au plus `limite` lignes, les plus récentes d\'abord.',
    input_schema: {
      type: 'object',
      properties: {
        texte: { type: 'string' }, categorie: { type: 'string' }, magasin: { type: 'string' },
        depuis: { type: 'string', description: 'date AAAA-MM-JJ' }, jusqua: { type: 'string', description: 'date AAAA-MM-JJ' },
        limite: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'historique_prix',
    description: "Historique des prix d'un article : prix payés (au kilo ou à l'unité, hors promo) par magasin et date, et prix relevés déjà enregistrés.",
    input_schema: { type: 'object', properties: { article: { type: 'string' } }, required: ['article'], additionalProperties: false },
  },
  {
    name: 'depenses_annuelles_et_epargne',
    description: "Postes de dépenses annuelles d'une année (montants prévus, payés), plafond annuel, solde et derniers mouvements du compte épargne.",
    input_schema: { type: 'object', properties: { annee: { type: 'integer' } }, additionalProperties: false },
  },
  {
    name: 'retenir',
    description: "Mémorise durablement une préférence ou une information personnelle de l'utilisateur (ex. « montants sans centimes », « fait ses courses le mardi chez Lidl »). Relue à chaque conversation.",
    input_schema: { type: 'object', properties: { note: { type: 'string', description: 'phrase courte et autonome' } }, required: ['note'], additionalProperties: false },
  },
  {
    name: 'oublier',
    description: "Supprime une note mémorisée devenue fausse ou que l'utilisateur ne veut plus (par son numéro).",
    input_schema: { type: 'object', properties: { numero: { type: 'integer' } }, required: ['numero'], additionalProperties: false },
  },
  {
    name: 'signaler_probleme',
    description: "Enregistre un rapport pour l'équipe qui développe l'application, quand une question révèle une incohérence, un bug, une donnée erronée ou une fonction manquante. Le rapport doit permettre de corriger sans reposer la question.",
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bug', 'donnees', 'incoherence', 'amelioration'] },
        titre: { type: 'string', description: 'résumé en une ligne' },
        description: { type: 'string', description: 'ce qui ne va pas, constaté avec quelles données' },
        contexte: { type: 'object', description: 'chiffres, périodes, articles, écrans concernés', additionalProperties: true },
        suggestion: { type: 'string', description: 'piste de correction' },
      },
      required: ['type', 'titre', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'enregistrer_prix_releves',
    description: "Enregistre des prix trouvés en magasin ou en ligne dans la rubrique « Meilleurs prix » de l'application. Uniquement sur demande explicite de l'utilisateur.",
    input_schema: {
      type: 'object',
      properties: {
        prix: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              article: { type: 'string', description: "nom de l'article tel qu'il existe dans l'application" },
              enseigne: { type: 'string' },
              prix: { type: 'number' },
              unite: { type: 'string', enum: ['kg', 'piece', 'l'] },
              promo: { type: 'boolean' },
              libelle: { type: 'string', description: 'libellé exact du produit trouvé' },
              source: { type: 'string', description: 'URL' },
            },
            required: ['article', 'enseigne', 'prix', 'unite'],
            additionalProperties: false,
          },
        },
      },
      required: ['prix'],
      additionalProperties: false,
    },
  },
]

type Input = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const isPeriod = (v?: string) => !!v && /^\d{4}-\d{2}-01$/.test(v)
const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)

function currentPeriod(): string {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Brussels' }))
  let y = d.getFullYear(), m = d.getMonth() + 1
  if (d.getDate() >= 26) { m += 1; if (m > 12) { m = 1; y += 1 } }
  return `${y}-${String(m).padStart(2, '0')}-01`
}
function addMonths(p: string, n: number): string {
  const [y, m] = p.split('-').map(Number)
  const i = y * 12 + (m - 1) + n
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`
}
const round2 = (n: number) => Math.round(n * 100) / 100

async function must<T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data as T
}

type Db = SupabaseClient<any, any, any> // client sur le schéma « comptes »

/** Texte comparable : sans accents ni majuscules, œ → oe, æ → ae. */
const norm = (s: string) => s.replace(/œ/gi, 'oe').replace(/æ/gi, 'ae')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Articles dont le nom (et la catégorie) contiennent le texte, à la manière d'une personne. */
async function matchingItemIds(db: Db, texte?: string, categorie?: string): Promise<number[]> {
  const items = await must(db.from('items').select('id, name, categories(name)')) as Record<string, any>[]
  const t = texte ? norm(texte).replace(/s$/, '') : '' // « oeufs » trouve aussi « oeuf »
  const c = categorie ? norm(categorie) : ''
  return items
    .filter((i) => (!t || norm(i.name).includes(t)) && (!c || norm(i.categories?.name ?? '').includes(c)))
    .map((i) => i.id as number)
}

/** Préférences et remarques durables de l'utilisateur, relues à chaque question. */
async function loadMemory(db: Db): Promise<{ id: number; note: string }[]> {
  const { data } = await db.from('assistant_memory').select('id, note').order('created_at').limit(50)
  return (data ?? []) as { id: number; note: string }[]
}

async function runTool(db: Db, name: string, input: Input, question: string): Promise<unknown> {
  switch (name) {
    case 'retenir': {
      const note = (str(input.note) ?? '').slice(0, 500)
      if (!note) throw new Error('note vide')
      const saved = await must(db.from('assistant_memory').insert({ note }).select('id').single()) as { id: number }
      return { retenu: true, numero: saved.id }
    }
    case 'oublier': {
      await must(db.from('assistant_memory').delete().eq('id', Number(input.numero)))
      return { oublie: true }
    }
    case 'signaler_probleme': {
      const type = ['bug', 'donnees', 'incoherence', 'amelioration'].includes(String(input.type)) ? String(input.type) : 'incoherence'
      const row = {
        type,
        titre: (str(input.titre) ?? 'Signalement').slice(0, 200),
        description: (str(input.description) ?? '').slice(0, 4000),
        contexte: input.contexte && typeof input.contexte === 'object' ? input.contexte : null,
        suggestion: str(input.suggestion)?.slice(0, 2000) ?? null,
        question: question.slice(0, 2000),
      }
      // Pas de doublon : un signalement encore ouvert sur le même sujet n'est pas recréé
      const words = (t: string) => new Set(t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z]{5,}/g) ?? [])
      const open = await must(db.from('app_reports').select('id, titre').in('statut', ['nouveau', 'en_cours'])) as { id: number; titre: string }[]
      const mine = words(row.titre)
      const twin = open.find((r) => [...words(r.titre)].filter((w) => mine.has(w)).length >= 2)
      if (twin) return { enregistre: false, deja_signale: twin.id, titre: twin.titre }
      const saved = await must(db.from('app_reports').insert(row).select('id').single()) as { id: number }
      return { enregistre: true, numero: saved.id }
    }
    case 'resume_mois': {
      const p = isPeriod(str(input.periode)) ? str(input.periode)! : currentPeriod()
      const [cats, totals, lines, fuel] = await Promise.all([
        must(db.from('categories').select('id, name, monthly_budget')),
        must(db.from('category_month_totals').select('category_id, total').eq('period', p)),
        must(db.from('monthly_lines').select('section, label, amount').eq('period', p)),
        must(db.from('fuel_fills').select('total').eq('period', p)),
      ])
      const byCat = (totals as { category_id: number; total: number }[]).map((t) => {
        const c = (cats as { id: number; name: string; monthly_budget: number | null }[]).find((x) => x.id === t.category_id)
        return { categorie: c?.name, total: Number(t.total), budget: c?.monthly_budget != null ? Number(c.monthly_budget) : null }
      })
      return {
        periode: p, du: `${addMonths(p, -1).slice(0, 8)}26`, au: `${p.slice(0, 8)}25`,
        depenses_courantes: round2(byCat.reduce((a, x) => a + x.total, 0)), par_categorie: byCat,
        rentrees_et_fixes: lines, essence: round2((fuel as { total: number }[]).reduce((a, f) => a + Number(f.total), 0)),
      }
    }
    case 'depenses_par_mois': {
      const to = isPeriod(str(input.jusqua)) ? str(input.jusqua)! : currentPeriod()
      const from = isPeriod(str(input.depuis)) ? str(input.depuis)! : addMonths(to, -11)
      const [cats, totals] = await Promise.all([
        must(db.from('categories').select('id, name')),
        must(db.from('category_month_totals').select('period, category_id, total').gte('period', from).lte('period', to).order('period')),
      ])
      const name = (id: number) => (cats as { id: number; name: string }[]).find((c) => c.id === id)?.name ?? '?'
      const out: Record<string, Record<string, number>> = {}
      for (const t of totals as { period: string; category_id: number; total: number }[]) {
        out[t.period] ??= {}
        out[t.period][name(t.category_id)] = Number(t.total)
      }
      return Object.entries(out).map(([periode, c]) => ({ periode, total: round2(Object.values(c).reduce((a, b) => a + b, 0)), par_categorie: c }))
    }
    case 'chercher_achats': {
      const limite = Math.min(Math.max(Number(input.limite) || 50, 1), 200)
      // Filtre texte / catégorie fait ici, insensible aux accents et à œ/oe (« oeufs » trouve « œufs »)
      const ids = (str(input.texte) || str(input.categorie)) ? await matchingItemIds(db, str(input.texte), str(input.categorie)) : null
      if (ids && !ids.length) return []
      let q = db.from('purchases')
        .select('purchased_on, period, amount, units, quantity_g, price_per_kg, promo_pct, note, items(name, categories(name)), stores(name)')
        .order('purchased_on', { ascending: false, nullsFirst: false }).limit(limite)
      if (ids) q = q.in('item_id', ids.slice(0, 300))
      if (isDate(str(input.depuis))) q = q.gte('purchased_on', str(input.depuis)!)
      if (isDate(str(input.jusqua))) q = q.lte('purchased_on', str(input.jusqua)!)
      let rows = await must(q) as Record<string, any>[]
      if (str(input.magasin)) rows = rows.filter((r) => norm(r.stores?.name ?? '').includes(norm(str(input.magasin)!)))
      return rows.map((r) => ({
        date: r.purchased_on, mois: r.period, article: r.items?.name, categorie: r.items?.categories?.name, magasin: r.stores?.name ?? null,
        montant: Number(r.amount), nombre: r.units ?? 1, quantite_g: r.quantity_g, prix_kg: r.price_per_kg, promo_pct: r.promo_pct, note: r.note,
      }))
    }
    case 'historique_prix': {
      const article = str(input.article) ?? ''
      const matched = await matchingItemIds(db, article, undefined)
      const items = matched.length
        ? await must(db.from('items').select('id, name, categories(name, weighed)').in('id', matched.slice(0, 10))) as Record<string, any>[]
        : []
      if (!items.length) return { message: `Aucun article ne correspond à « ${article} ».` }
      const ids = items.map((i) => i.id)
      const [purchases, refs] = await Promise.all([
        must(db.from('purchases').select('item_id, purchased_on, amount, units, quantity_g, price_per_kg, promo_pct, stores(name)').in('item_id', ids).order('purchased_on', { ascending: false }).limit(150)),
        must(db.from('price_references').select('item_id, store_name, price, unit, is_promo, observed_on, source').in('item_id', ids).order('observed_on', { ascending: false }).limit(50)),
      ])
      return items.map((it) => ({
        article: it.name, categorie: it.categories?.name,
        achats: (purchases as Record<string, any>[]).filter((p) => p.item_id === it.id).map((p) => {
          const promo = Number(p.promo_pct ?? 0)
          const brut = promo > 0 && promo < 100 ? Number(p.amount) / (1 - promo / 100) : Number(p.amount)
          const prix = p.price_per_kg != null ? { valeur: Number(p.price_per_kg), unite: '€/kg' }
            : p.quantity_g ? { valeur: round2(brut / (Number(p.quantity_g) / 1000)), unite: '€/kg' }
            : { valeur: round2(brut / (Number(p.units ?? 1) || 1)), unite: '€/pièce' }
          return { date: p.purchased_on, magasin: p.stores?.name ?? null, paye: Number(p.amount), nombre: p.units ?? 1, prix_hors_promo: prix, promo: promo || null }
        }),
        prix_releves: (refs as Record<string, any>[]).filter((r) => r.item_id === it.id),
      }))
    }
    case 'depenses_annuelles_et_epargne': {
      const annee = Number(input.annee) || Number(currentPeriod().slice(0, 4))
      const [prov, settings, savings] = await Promise.all([
        must(db.from('annual_provisions').select('id, label, annual_amount, due_month, annual_payments(paid_on, amount, note)').eq('year', annee)),
        must(db.from('user_settings').select('annual_budget, emergency_target').maybeSingle()),
        must(db.from('savings_movements').select('moved_on, label, amount').order('moved_on', { ascending: false })),
      ])
      const postes = (prov as Record<string, any>[]).map((p) => ({
        poste: p.label, prevu_par_an: Number(p.annual_amount), mois_echeance: p.due_month,
        paye: round2((p.annual_payments ?? []).reduce((a: number, x: any) => a + Number(x.amount), 0)), paiements: p.annual_payments,
      }))
      const mv = savings as { moved_on: string; label: string; amount: number }[]
      return {
        annee, plafond_annuel: settings ? Number((settings as any).annual_budget) : 2000,
        total_prevu: round2(postes.reduce((a, p) => a + p.prevu_par_an, 0)), total_paye: round2(postes.reduce((a, p) => a + p.paye, 0)), postes,
        epargne: { solde: round2(mv.reduce((a, m) => a + Number(m.amount), 0)), reserve_visee: settings ? Number((settings as any).emergency_target) : null, derniers_mouvements: mv.slice(0, 10) },
      }
    }
    case 'enregistrer_prix_releves': {
      const list = Array.isArray(input.prix) ? input.prix as Record<string, unknown>[] : []
      const items = await must(db.from('items').select('id, name')) as { id: number; name: string }[]
      const rows = []
      const inconnus: string[] = []
      for (const p of list) {
        const art = str(p.article)
        const item = art ? items.find((i) => norm(i.name) === norm(art)) : undefined
        if (!item || typeof p.prix !== 'number' || !str(p.enseigne)) { inconnus.push(art ?? '?'); continue }
        rows.push({
          item_id: item.id, store_name: str(p.enseigne)!, price: p.prix, unit: ['kg', 'piece', 'l'].includes(String(p.unite)) ? p.unite : 'piece',
          is_promo: Boolean(p.promo), label: str(p.libelle) ?? null, source: str(p.source) ?? null,
        })
      }
      if (rows.length) await must(db.from('price_references').insert(rows))
      return { enregistres: rows.length, articles_introuvables: inconnus }
    }
    default:
      throw new Error(`Outil inconnu : ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405)

  // Session de l'utilisateur et liste des comptes autorisés
  const authHeader = req.headers.get('Authorization') ?? ''
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    db: { schema: 'comptes' },
    auth: { persistSession: false },
  })
  const { data: userData } = await db.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''))
  const email = userData.user?.email?.toLowerCase()
  const allowed = (Deno.env.get('ALLOWED_EMAILS') ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
  if (!email || !allowed.includes(email)) return json({ error: "Ce compte n'a pas accès à l'assistant." }, 403)

  // Conversation (texte seulement) envoyée par l'application
  let history: { role: 'user' | 'assistant'; content: string }[] = []
  try {
    const body = await req.json()
    history = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m: any) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-20)
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 8000) }))
  } catch { /* corps invalide */ }
  while (history.length && history[0].role !== 'user') history.shift()
  if (!history.length || history[history.length - 1].role !== 'user') return json({ error: 'Message manquant.' }, 400)

  const apiKey = (Deno.env.get('COMPTES_ANTHROPIC_API_KEY') ?? '').trim()
  if (!apiKey) return json({ error: "L'assistant n'est pas encore configuré (clé manquante)." }, 503)
  const client = new Anthropic({ apiKey })
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({ role: m.role, content: m.content }))
  const today = new Date().toLocaleDateString('fr-BE', { timeZone: 'Europe/Brussels', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const sources = new Map<string, string>()
  const memory = await loadMemory(db)
  const memoryText = memory.length
    ? `Notes mémorisées sur l'utilisateur (à respecter) :\n${memory.map((m) => `- n°${m.id} : ${m.note}`).join('\n')}`
    : "Aucune note mémorisée pour l'instant."
  const usage = { input: 0, output: 0, cache_read: 0, web_searches: 0 }

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: [
          { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `Aujourd'hui : ${today}. Mois comptable en cours : ${currentPeriod()}.\n\n${memoryText}` },
        ],
        tools: TOOLS,
        messages,
      })
      usage.input += response.usage.input_tokens
      usage.output += response.usage.output_tokens
      usage.cache_read += response.usage.cache_read_input_tokens ?? 0
      usage.web_searches += response.usage.server_tool_use?.web_search_requests ?? 0

      // Sources : citations de la réponse et pages effectivement lues
      for (const block of response.content) {
        if (block.type === 'text' && block.citations) {
          for (const c of block.citations) if ('url' in c && c.url) sources.set(c.url, ('title' in c && c.title) || c.url)
        }
        if (block.type === 'web_fetch_tool_result' && !Array.isArray(block.content) && block.content.type === 'web_fetch_result') {
          const page = block.content
          if (!sources.has(page.url)) sources.set(page.url, page.content?.title || new URL(page.url).hostname)
        }
      }

      if (response.stop_reason === 'refusal') {
        return json({ reply: "Je ne peux pas répondre à cette demande. Pouvez-vous la formuler autrement ?", sources: [], usage })
      }
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content })
        continue
      }
      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content })
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          try {
            const out = await runTool(db, block.name, (block.input ?? {}) as Input, history[history.length - 1].content)
            results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) })
          } catch (e) {
            results.push({ type: 'tool_result', tool_use_id: block.id, content: `Erreur : ${(e as Error).message}`, is_error: true })
          }
        }
        messages.push({ role: 'user', content: results })
        continue
      }
      // end_turn, max_tokens… : réponse finale
      const reply = response.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join('').trim()
      return json({
        reply: reply || "Je n'ai pas trouvé de réponse.",
        truncated: response.stop_reason === 'max_tokens',
        sources: [...sources].slice(0, 12).map(([url, title]) => ({ url, title })),
        usage,
      })
    }
    return json({ reply: "La recherche a pris trop d'étapes. Pouvez-vous préciser la question ?", sources: [], usage })
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "L'assistant est très sollicité, réessayez dans un instant." }, 429)
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "La clé de l'assistant n'est pas valide." }, 500)
    if (e instanceof Anthropic.APIError) return json({ error: `Erreur de l'assistant (${e.status}).` }, 502)
    return json({ error: (e as Error).message }, 500)
  }
})
