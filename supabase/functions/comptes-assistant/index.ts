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
- Tu peux ajouter des données quand l'utilisateur le demande (achats, rentrées et dépenses fixes, pleins, paiements de dépenses annuelles, épargne). Si une information indispensable manque (montant, date, catégorie), demande-la au lieu de l'inventer ; « aujourd'hui », « hier » ou « samedi » se convertissent en date. Les outils vérifient d'eux-mêmes ce qui est déjà enregistré : s'ils signalent un doublon possible, montre clairement ce qui existe déjà et demande si c'est un autre achat ; ne relance avec forcer (ou remplacer) qu'après un « oui » de l'utilisateur. Après chaque ajout, récapitule exactement ce qui a été enregistré (article, montant, date, mois comptable) et précise qu'il peut te demander de l'annuler.
- Une dépense annuelle (assurance, taxe, eau, hospitalisation…) se note avec payer_depense_annuelle, pas comme un achat.
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
  // --- Écriture (chaque outil vérifie d'abord ce qui est déjà enregistré) ---
  {
    name: 'ajouter_achats',
    description: "Ajoute un ou plusieurs achats dans le détail du mois. Vérifie d'abord les doublons (même article, même date, montant identique ou proche) : les lignes douteuses ne sont PAS enregistrées et sont renvoyées dans « doublons_possibles ». Relance avec forcer=true seulement après confirmation de l'utilisateur. Le mois comptable est calculé d'après la date (à partir du 26 : mois suivant).",
    input_schema: {
      type: 'object',
      properties: {
        achats: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              article: { type: 'string', description: "nom de l'article (réutilise un nom existant si c'est le même produit)" },
              categorie: { type: 'string', description: 'une catégorie existante' },
              montant: { type: 'number', description: 'montant payé pour la ligne' },
              date: { type: 'string', description: 'AAAA-MM-JJ (date du ticket)' },
              magasin: { type: 'string' },
              nombre: { type: 'integer', description: "nombre d'unités (défaut 1)" },
              poids_g: { type: 'number', description: 'poids en grammes (légumes)' },
              prix_kg: { type: 'number' },
              promo_pct: { type: 'number' },
              remarque: { type: 'string' },
            },
            required: ['article', 'categorie', 'montant', 'date'],
            additionalProperties: false,
          },
        },
        forcer: { type: 'boolean', description: "true pour enregistrer malgré un doublon possible, après confirmation de l'utilisateur" },
      },
      required: ['achats'],
      additionalProperties: false,
    },
  },
  {
    name: 'ajouter_ligne_mois',
    description: "Ajoute une rentrée (pension, remboursement…) ou une dépense fixe (loyer, électricité, GSM…) au Global d'un mois. Si une ligne du même nom existe déjà ce mois-là, rien n'est modifié et la ligne existante est renvoyée ; relance avec remplacer=true (nouveau montant) seulement après confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['revenu', 'fixe'] },
        libelle: { type: 'string' },
        montant: { type: 'number' },
        periode: { type: 'string', description: 'AAAA-MM-01 (défaut : mois en cours)' },
        remarque: { type: 'string' },
        remplacer: { type: 'boolean' },
      },
      required: ['section', 'libelle', 'montant'],
      additionalProperties: false,
    },
  },
  {
    name: 'ajouter_plein',
    description: "Ajoute un plein d'essence. Refuse s'il existe déjà un plein le même jour pour un montant proche (relance avec forcer=true après confirmation).",
    input_schema: {
      type: 'object',
      properties: {
        station: { type: 'string' }, total: { type: 'number' }, date: { type: 'string', description: 'AAAA-MM-JJ' },
        prix_litre: { type: 'number' }, km: { type: 'number', description: 'compteur kilométrique' }, forcer: { type: 'boolean' },
      },
      required: ['station', 'total', 'date'],
      additionalProperties: false,
    },
  },
  {
    name: 'payer_depense_annuelle',
    description: "Note le paiement d'une dépense annuelle (assurance, taxe, eau, hospitalisation…) sur son poste de l'année. Par défaut la somme sort aussi du compte épargne. Refuse si un paiement du même montant existe déjà ce mois-là pour ce poste (relance avec forcer=true après confirmation).",
    input_schema: {
      type: 'object',
      properties: {
        poste: { type: 'string' }, montant: { type: 'number' }, date: { type: 'string', description: 'AAAA-MM-JJ' },
        depuis_epargne: { type: 'boolean', description: 'défaut true' }, remarque: { type: 'string' }, forcer: { type: 'boolean' },
      },
      required: ['poste', 'montant', 'date'],
      additionalProperties: false,
    },
  },
  {
    name: 'ajouter_mouvement_epargne',
    description: "Ajoute un mouvement sur le compte épargne (positif : versement ; négatif : retrait ou dépense). Refuse si le même montant existe déjà à la même date (relance avec forcer=true après confirmation).",
    input_schema: {
      type: 'object',
      properties: { libelle: { type: 'string' }, montant: { type: 'number' }, date: { type: 'string', description: 'AAAA-MM-JJ' }, forcer: { type: 'boolean' } },
      required: ['libelle', 'montant', 'date'],
      additionalProperties: false,
    },
  },
  {
    name: 'annuler_ajout',
    description: "Annule des ajouts ou modifications faits par l'assistant (jamais une saisie de l'utilisateur). Sans paramètre : annule la dernière demande (toutes ses lignes). Sinon, donne les numéros du journal obtenus avec derniers_ajouts. Uniquement à la demande de l'utilisateur ou pour corriger ta propre erreur.",
    input_schema: {
      type: 'object',
      properties: { numeros_journal: { type: 'array', items: { type: 'integer' } } },
      additionalProperties: false,
    },
  },
  {
    name: 'derniers_ajouts',
    description: "Liste les derniers ajouts et modifications faits par l'assistant (journal), avec leur numéro, pour les montrer ou en annuler un précis.",
    input_schema: { type: 'object', properties: { nombre: { type: 'integer' } }, additionalProperties: false },
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
/** Mois comptable d'une date (le mois commence le 26). */
function periodForDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const p = `${y}-${String(m).padStart(2, '0')}-01`
  return d >= 26 ? addMonths(p, 1) : p
}
const todayIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Brussels' })
const shiftDate = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10)
const BY_ASSISTANT = "ajouté par l'assistant"
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

/**
 * Première écriture dans un mois : comme l'application, on crée le mois et on recopie
 * les rentrées et dépenses fixes du dernier mois connu (montants « à recopier »).
 */
async function ensureMonth(db: Db, period: string): Promise<void> {
  const existing = await must(db.from('months').select('period').eq('period', period)) as unknown[]
  if (existing.length) return
  const created = await must(db.from('months').upsert({ period }, { onConflict: 'user_id,period', ignoreDuplicates: true }).select()) as unknown[]
  if (!created.length) return
  const already = await must(db.from('monthly_lines').select('id').eq('period', period).limit(1)) as unknown[]
  if (already.length) return
  const prev = await must(db.from('monthly_lines').select('period').lt('period', period).order('period', { ascending: false }).limit(1)) as { period: string }[]
  if (!prev.length) return
  const lines = await must(db.from('monthly_lines').select('section, label, amount, carry_over, sort_order').eq('period', prev[0].period)) as Record<string, any>[]
  if (lines.length) {
    await must(db.from('monthly_lines').insert(lines.map((l) => ({
      period, section: l.section, label: l.label, amount: l.carry_over ? l.amount : 0, carry_over: l.carry_over, sort_order: l.sort_order,
    }))))
  }
}

/** Préférences et remarques durables de l'utilisateur, relues à chaque question. */
async function loadMemory(db: Db): Promise<{ id: number; note: string }[]> {
  const { data } = await db.from('assistant_memory').select('id, note').order('created_at').limit(50)
  return (data ?? []) as { id: number; note: string }[]
}

async function runTool(db: Db, name: string, input: Input, question: string, group: string): Promise<unknown> {
  const log = (table: string, rowId: number, resume: string, action: 'ajout' | 'modification' = 'ajout', avant: number | null = null) =>
    must(db.from('assistant_actions').insert({ table_name: table, row_id: rowId, resume, action, avant, groupe: group }))
  switch (name) {
    // ------------------------------------------------------------------ écriture
    case 'ajouter_achats': {
      const lines = Array.isArray(input.achats) ? input.achats as Record<string, any>[] : []
      if (!lines.length) throw new Error('aucun achat fourni')
      const forcer = input.forcer === true
      const [cats, items, stores] = await Promise.all([
        must(db.from('categories').select('id, name, weighed')),
        must(db.from('items').select('id, name, category_id')),
        must(db.from('stores').select('id, name')),
      ]) as [Record<string, any>[], Record<string, any>[], Record<string, any>[]]
      const enregistres = []
      const doublons = []
      const erreurs = []
      for (const l of lines) {
        const nom = (str(l.article) ?? '').slice(0, 120)
        const wanted = norm(String(l.categorie ?? ''))
        const cat = cats.find((c) => norm(c.name) === wanted) ?? cats.find((c) => wanted && norm(c.name).includes(wanted))
        const montant = round2(Number(l.montant))
        const date = isDate(str(l.date)) ? str(l.date)! : todayIso()
        if (!nom || !cat || !(montant > 0)) {
          erreurs.push({ article: nom || '?', erreur: !cat ? `catégorie inconnue « ${l.categorie} »` : !nom ? 'article manquant' : 'montant invalide' })
          continue
        }
        if (!forcer) {
          // Déjà enregistré ? Même article à un jour près, ou même montant le même jour dans la même catégorie.
          const sameName = items.filter((i) => norm(i.name) === norm(nom)).map((i) => i.id)
          const near = await must(db.from('purchases')
            .select('id, purchased_on, amount, item_id, items(name, category_id), stores(name)')
            .gte('purchased_on', shiftDate(date, -1)).lte('purchased_on', shiftDate(date, 1))) as Record<string, any>[]
          const found = near.filter((p) => sameName.includes(p.item_id)
            || (p.purchased_on === date && p.items?.category_id === cat.id && Math.abs(Number(p.amount) - montant) < 0.01))
          if (found.length) {
            doublons.push({
              demande: { article: nom, montant, date },
              deja_enregistre: found.map((p) => ({ numero: p.id, article: p.items?.name, date: p.purchased_on, montant: Number(p.amount), magasin: p.stores?.name ?? null })),
            })
            continue
          }
        }
        let item = items.find((i) => i.category_id === cat.id && norm(i.name) === norm(nom))
        if (!item) {
          item = await must(db.from('items').insert({ category_id: cat.id, name: nom }).select('id, name, category_id').single()) as Record<string, any>
          items.push(item)
        }
        let storeId: number | null = null
        const shop = str(l.magasin)
        if (shop) {
          let s = stores.find((x) => norm(x.name) === norm(shop)) ?? stores.find((x) => norm(x.name).includes(norm(shop)))
          if (!s) { s = await must(db.from('stores').insert({ name: shop }).select('id, name').single()) as Record<string, any>; stores.push(s) }
          storeId = s.id
        }
        const row = {
          period: periodForDate(date), item_id: item.id, store_id: storeId, purchased_on: date, amount: montant,
          units: Number.isInteger(l.nombre) && l.nombre > 1 ? l.nombre : null,
          quantity_g: cat.weighed && Number(l.poids_g) > 0 ? Number(l.poids_g) : null,
          price_per_kg: cat.weighed && Number(l.prix_kg) > 0 ? Number(l.prix_kg) : null,
          promo_pct: Number(l.promo_pct) > 0 ? Number(l.promo_pct) : null,
          note: [BY_ASSISTANT, str(l.remarque)].filter(Boolean).join(' · '),
        }
        const saved = await must(db.from('purchases').insert(row).select('id').single()) as { id: number }
        await log('purchases', saved.id, `Achat : ${item.name}, ${montant.toFixed(2)} €, le ${date}${shop ? ` chez ${shop}` : ''}`)
        enregistres.push({ numero: saved.id, article: item.name, categorie: cat.name, montant, date, mois_comptable: row.period, magasin: shop ?? null })
      }
      return {
        enregistres, doublons_possibles: doublons, erreurs,
        ...(doublons.length ? { consigne: "Rien n'a été enregistré pour ces lignes : montre ce qui existe déjà et demande à l'utilisateur s'il s'agit d'un autre achat. Relance avec forcer=true seulement s'il confirme." } : {}),
      }
    }
    case 'ajouter_ligne_mois': {
      const periode = isPeriod(str(input.periode)) ? str(input.periode)! : currentPeriod()
      const section = input.section === 'revenu' ? 'revenu' : 'fixe'
      const libelle = (str(input.libelle) ?? '').slice(0, 120)
      const montant = round2(Number(input.montant))
      if (!libelle || !Number.isFinite(montant)) throw new Error('libellé ou montant manquant')
      await ensureMonth(db, periode)
      const lines = await must(db.from('monthly_lines').select('id, section, label, amount').eq('period', periode)) as Record<string, any>[]
      const syn = (t: string) => norm(t).replace(/pension/g, 'retraite')
      const same = lines.find((l) => syn(l.label) === syn(libelle))
        ?? lines.find((l) => syn(l.label).includes(syn(libelle)) || syn(libelle).includes(syn(l.label)))
        ?? lines.find((l) => l.section === section && Number(l.amount) > 0 && Math.abs(Number(l.amount) - montant) <= Math.abs(montant) * 0.01)
      if (same && input.remplacer !== true) {
        return {
          enregistre: false, deja_present: { numero: same.id, libelle: same.label, montant: Number(same.amount), periode },
          consigne: "Cette ligne existe déjà ce mois-là : dis-le à l'utilisateur et demande s'il faut remplacer le montant (remplacer=true) ou s'il s'agit d'une autre ligne (autre libellé).",
        }
      }
      if (same) {
        await must(db.from('monthly_lines').update({ amount: montant, ...(str(input.remarque) ? { note: str(input.remarque) } : {}) }).eq('id', same.id))
        await log('monthly_lines', same.id, `Global ${periode} : ${same.label} ${Number(same.amount).toFixed(2)} € → ${montant.toFixed(2)} €`, 'modification', Number(same.amount))
        return { modifie: true, numero: same.id, libelle: same.label, ancien_montant: Number(same.amount), nouveau_montant: montant, periode }
      }
      const saved = await must(db.from('monthly_lines').insert({
        period: periode, section, label: libelle, amount: montant, note: str(input.remarque) ?? null,
        carry_over: section === 'fixe', sort_order: lines.length,
      }).select('id').single()) as { id: number }
      await log('monthly_lines', saved.id, `Global ${periode} : ${libelle} ${montant.toFixed(2)} €`)
      return { enregistre: true, numero: saved.id, section, libelle, montant, periode }
    }
    case 'ajouter_plein': {
      const date = isDate(str(input.date)) ? str(input.date)! : todayIso()
      const total = round2(Number(input.total))
      if (!(total > 0) || !str(input.station)) throw new Error('station ou montant manquant')
      if (input.forcer !== true) {
        const same = await must(db.from('fuel_fills').select('id, station, filled_on, total').eq('filled_on', date)) as Record<string, any>[]
        if (same.length) return { enregistre: false, deja_present: same.map((f) => ({ numero: f.id, station: f.station, date: f.filled_on, total: Number(f.total) })), consigne: "Un plein existe déjà ce jour-là : demande confirmation avant de relancer avec forcer=true." }
      }
      const saved = await must(db.from('fuel_fills').insert({
        period: periodForDate(date), station: str(input.station), filled_on: date, total,
        price_per_litre: Number(input.prix_litre) > 0 ? Number(input.prix_litre) : null, km: Number(input.km) > 0 ? Math.round(Number(input.km)) : null,
      }).select('id').single()) as { id: number }
      await log('fuel_fills', saved.id, `Plein : ${str(input.station)}, ${total.toFixed(2)} €, le ${date}`)
      return { enregistre: true, numero: saved.id, station: str(input.station), date, total, mois_comptable: periodForDate(date) }
    }
    case 'payer_depense_annuelle': {
      const date = isDate(str(input.date)) ? str(input.date)! : todayIso()
      const montant = round2(Number(input.montant))
      const poste = norm(str(input.poste) ?? '')
      if (!poste || !(montant > 0)) throw new Error('poste ou montant manquant')
      const provisions = await must(db.from('annual_provisions').select('id, label').eq('year', Number(date.slice(0, 4)))) as Record<string, any>[]
      const prov = provisions.find((p) => norm(p.label) === poste) ?? provisions.find((p) => norm(p.label).includes(poste) || poste.includes(norm(p.label)))
      if (!prov) return { enregistre: false, erreur: `Aucun poste annuel « ${input.poste} » en ${date.slice(0, 4)}.`, postes_existants: provisions.map((p) => p.label) }
      if (input.forcer !== true) {
        const pays = await must(db.from('annual_payments').select('id, paid_on, amount').eq('provision_id', prov.id)) as Record<string, any>[]
        const same = pays.filter((p) => periodForDate(p.paid_on) === periodForDate(date))
        if (same.length) return { enregistre: false, deja_present: same.map((p) => ({ numero: p.id, date: p.paid_on, montant: Number(p.amount) })), poste: prov.label, consigne: "Un paiement existe déjà ce mois-ci pour ce poste : demande confirmation avant de relancer avec forcer=true." }
      }
      const pay = await must(db.from('annual_payments').insert({ provision_id: prov.id, paid_on: date, amount: montant, note: str(input.remarque) ?? null }).select('id').single()) as { id: number }
      await log('annual_payments', pay.id, `Paiement annuel : ${prov.label}, ${montant.toFixed(2)} €, le ${date}`)
      let epargne: number | null = null
      if (input.depuis_epargne !== false) {
        const mv = await must(db.from('savings_movements').insert({ moved_on: date, label: prov.label, amount: -montant, note: BY_ASSISTANT }).select('id').single()) as { id: number }
        epargne = mv.id
        await log('savings_movements', mv.id, `Épargne : −${montant.toFixed(2)} € (${prov.label})`)
      }
      return { enregistre: true, numero_paiement: pay.id, numero_mouvement_epargne: epargne, poste: prov.label, montant, date }
    }
    case 'ajouter_mouvement_epargne': {
      const date = isDate(str(input.date)) ? str(input.date)! : todayIso()
      const montant = round2(Number(input.montant))
      if (!str(input.libelle) || !Number.isFinite(montant) || montant === 0) throw new Error('libellé ou montant manquant')
      if (input.forcer !== true) {
        const same = await must(db.from('savings_movements').select('id, moved_on, label, amount').eq('moved_on', date).eq('amount', montant)) as Record<string, any>[]
        if (same.length) return { enregistre: false, deja_present: same.map((m) => ({ numero: m.id, date: m.moved_on, libelle: m.label, montant: Number(m.amount) })), consigne: "Le même mouvement existe déjà : demande confirmation avant de relancer avec forcer=true." }
      }
      const saved = await must(db.from('savings_movements').insert({ moved_on: date, label: str(input.libelle), amount: montant, note: BY_ASSISTANT }).select('id').single()) as { id: number }
      await log('savings_movements', saved.id, `Épargne : ${montant.toFixed(2)} € (${str(input.libelle)}), le ${date}`)
      return { enregistre: true, numero: saved.id, libelle: str(input.libelle), montant, date }
    }
    case 'derniers_ajouts': {
      const n = Math.min(Math.max(Number(input.nombre) || 10, 1), 50)
      const rows = await must(db.from('assistant_actions').select('id, created_at, action, resume, annule').order('id', { ascending: false }).limit(n)) as Record<string, any>[]
      return rows.map((r) => ({ numero_journal: r.id, quand: r.created_at, action: r.action, resume: r.resume, annule: r.annule }))
    }
    case 'annuler_ajout': {
      // Par défaut : la dernière demande non annulée (toutes les lignes de son groupe)
      let actions: Record<string, any>[]
      const ids = (Array.isArray(input.numeros_journal) ? input.numeros_journal : []).map(Number).filter(Number.isInteger)
      if (ids.length) {
        actions = await must(db.from('assistant_actions').select('*').in('id', ids).eq('annule', false)) as Record<string, any>[]
      } else {
        const last = await must(db.from('assistant_actions').select('groupe').eq('annule', false).order('id', { ascending: false }).limit(1)) as { groupe: string }[]
        actions = last.length
          ? await must(db.from('assistant_actions').select('*').eq('groupe', last[0].groupe).eq('annule', false)) as Record<string, any>[]
          : []
      }
      if (!actions.length) return { annule: [], message: 'Rien à annuler.' }
      const done: string[] = []
      for (const a of actions) {
        if (a.action === 'modification') {
          await must(db.from(a.table_name).update({ amount: a.avant }).eq('id', a.row_id))
        } else {
          let q = db.from(a.table_name).delete().eq('id', a.row_id)
          if (a.table_name === 'purchases') q = q.like('note', `${BY_ASSISTANT}%`) // jamais un achat saisi par l'utilisateur
          await must(q)
        }
        await must(db.from('assistant_actions').update({ annule: true }).eq('id', a.id))
        done.push(a.resume)
      }
      return { annule: done }
    }
    // ------------------------------------------------------------------ mémoire
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
        .select('id, purchased_on, period, amount, units, quantity_g, price_per_kg, promo_pct, note, items(name, categories(name)), stores(name)')
        .order('purchased_on', { ascending: false, nullsFirst: false }).limit(limite)
      if (ids) q = q.in('item_id', ids.slice(0, 300))
      if (isDate(str(input.depuis))) q = q.gte('purchased_on', str(input.depuis)!)
      if (isDate(str(input.jusqua))) q = q.lte('purchased_on', str(input.jusqua)!)
      let rows = await must(q) as Record<string, any>[]
      if (str(input.magasin)) rows = rows.filter((r) => norm(r.stores?.name ?? '').includes(norm(str(input.magasin)!)))
      return rows.map((r) => ({
        numero: r.id, date: r.purchased_on, mois: r.period, article: r.items?.name, categorie: r.items?.categories?.name, magasin: r.stores?.name ?? null,
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
            const out = await runTool(db, block.name, (block.input ?? {}) as Input, history[history.length - 1].content, crypto.randomUUID())
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
