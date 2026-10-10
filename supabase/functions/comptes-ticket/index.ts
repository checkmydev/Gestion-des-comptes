// Lecture d'un ticket de caisse photographié (Supabase Edge Function).
//
// Reçoit une photo (JPEG réduit par l'application), la fait lire par Claude et renvoie
// le magasin, la date et les lignes d'achat, rangées dans les catégories et articles
// existants de l'utilisateur. Rien n'est enregistré ici : l'application montre le
// résultat à l'utilisateur, qui corrige puis valide. La photo n'est pas conservée.
//
// Mêmes protections que l'assistant : clé dans le secret COMPTES_ANTHROPIC_API_KEY,
// accès limité aux comptes de ALLOWED_EMAILS, données lues avec la session (RLS).
import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0'
import { createClient } from 'npm:@supabase/supabase-js@2.117.3'

const MODEL = 'claude-sonnet-5-5' // lecture fiable des tickets, deux fois moins chère qu'Opus
const MAX_IMAGE_BYTES = 4_500_000 // la photo est réduite côté application (≈ 300-800 Ko)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const INSTRUCTIONS = `Tu lis la photo d'un ticket de caisse belge (Delhaize, Lidl, Colruyt, Aldi, Carrefour, Intermarché, Spar, boulangerie, pharmacie…) pour l'application de comptes d'un retraité. Tu renvoies le magasin, la date et chaque article acheté.

Règles de lecture :
- Une ligne par article acheté. Ignore les lignes de total, sous-total, TVA, mode de paiement, rendu, points de fidélité, numéros de caisse.
- « montant » est ce qui a été réellement payé pour la ligne, réductions déduites. Une ligne de réduction (« Réduction », « Promo », « Lidl Plus », « -0,50 », « 2e à -50 % »…) se déduit de l'article qu'elle concerne (en général celui juste au-dessus) : mets le montant de la remise dans « remise » et n'en fais pas une ligne à part.
- Articles pesés (« 0,812 kg x 1,99 €/kg ») : poids_g = 812, prix_kg = 1.99. Articles multiples (« 2 x 1,49 ») : nombre = 2 et montant = le total de la ligne.
- Consignes de bouteilles et sacs : catégorie Divers, article « Consigne » ou « Sac ».
- « article » : un nom court et générique en français, comme une personne l'écrirait (« Yaourt nature », pas « DANONE NAT 4X125G »). Si un article de la liste fournie correspond au même produit, reprends EXACTEMENT son nom.
- « categorie » : une des catégories fournies. Fruits et légumes frais → la catégorie pesée (Légumes).
- « incertain » = true si la ligne est mal lisible ou si tu as dû deviner.
- Date au format AAAA-MM-JJ ; magasin : reprends le nom d'un magasin connu s'il correspond (ex. « DELHAIZE WAVRE » → « Delhaize »).
- Si la photo n'est pas un ticket de caisse ou est illisible, renvoie une liste vide et explique-le dans « remarque ».`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405)

  const authHeader = req.headers.get('Authorization') ?? ''
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    db: { schema: 'comptes' },
    auth: { persistSession: false },
  })
  const { data: userData } = await db.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''))
  const email = userData.user?.email?.toLowerCase()
  const allowed = (Deno.env.get('ALLOWED_EMAILS') ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
  if (!email || !allowed.includes(email)) return json({ error: "Ce compte n'a pas accès à la lecture des tickets." }, 403)

  const apiKey = (Deno.env.get('COMPTES_ANTHROPIC_API_KEY') ?? '').trim()
  if (!apiKey) return json({ error: "La lecture des tickets n'est pas encore configurée (clé manquante)." }, 503)

  let image = ''
  let mediaType: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg'
  try {
    const body = await req.json()
    image = String(body.image ?? '')
    if (['image/png', 'image/webp'].includes(body.media_type)) mediaType = body.media_type
  } catch { /* corps invalide */ }
  if (!image || !/^[A-Za-z0-9+/=]+$/.test(image)) return json({ error: 'Photo manquante.' }, 400)
  if (image.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: 'Photo trop lourde.' }, 413)

  // Catégories, articles et magasins connus : le ticket est rangé dans les comptes existants
  const [cats, items, stores] = await Promise.all([
    db.from('categories').select('id, name, weighed, counted').eq('archived', false).order('sort_order'),
    db.from('items').select('name, category_id').order('name'),
    db.from('stores').select('name').order('name'),
  ])
  if (cats.error || items.error || stores.error) return json({ error: 'Lecture des comptes impossible.' }, 500)
  const categories = cats.data as { id: number; name: string; weighed: boolean; counted: boolean }[]
  const catalog = categories.map((c) => {
    const names = (items.data as { name: string; category_id: number }[]).filter((i) => i.category_id === c.id).map((i) => i.name)
    return `- ${c.name}${c.weighed ? ' (pesée : prix au kilo)' : ''} : ${names.join(', ') || '(aucun article)'}`
  }).join('\n')
  const context = `Catégories et articles déjà connus :\n${catalog}\n\nMagasins connus : ${(stores.data as { name: string }[]).map((s) => s.name).join(', ')}`

  // Format de réponse imposé (sorties structurées)
  const nullable = (type: string, description?: string) => ({ type: [type, 'null'], ...(description ? { description } : {}) })
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['magasin', 'date', 'total_ticket', 'lignes', 'remarque'],
    properties: {
      magasin: nullable('string'),
      date: nullable('string', 'AAAA-MM-JJ'),
      total_ticket: nullable('number', 'total payé indiqué sur le ticket'),
      remarque: nullable('string', 'ce qui pose problème sur le ticket, sinon null'),
      lignes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['texte_ticket', 'article', 'categorie', 'montant', 'nombre', 'poids_g', 'prix_kg', 'remise', 'incertain'],
          properties: {
            texte_ticket: { type: 'string', description: 'la ligne telle qu’écrite sur le ticket' },
            article: { type: 'string' },
            categorie: { type: 'string', enum: categories.map((c) => c.name) },
            montant: { type: 'number', description: 'payé pour la ligne, remise déduite' },
            nombre: nullable('integer'),
            poids_g: nullable('number'),
            prix_kg: nullable('number'),
            remise: nullable('number', 'montant de la réduction appliquée à cette ligne'),
            incertain: { type: 'boolean' },
          },
        },
      },
    },
  }

  // Clé non rattachée à un workspace : l'identifiant du workspace doit accompagner chaque appel.
  const workspace = (Deno.env.get('COMPTES_ANTHROPIC_WORKSPACE_ID') ?? '').trim()
  const client = new Anthropic({ apiKey, ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}) })
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      system: [
        { type: 'text', text: INSTRUCTIONS },
        { type: 'text', text: context, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: 'Lis ce ticket de caisse.' },
        ],
      }],
    })
    if (response.stop_reason === 'refusal') return json({ error: "Ce ticket n'a pas pu être lu." }, 422)
    const text = response.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join('')
    const parsed = JSON.parse(text)
    return json({ ...parsed, usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } })
  } catch (e) {
    if (e instanceof SyntaxError) return json({ error: "La lecture du ticket n'a pas abouti. Réessayez avec une photo plus nette." }, 502)
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'Service très sollicité, réessayez dans un instant.' }, 429)
    // Clé non rattachée à un workspace et identifiant de workspace absent
    if (e instanceof Anthropic.APIError && /workspace/i.test(String(e.message))) return json({ error: "La clé de l'assistant n'est liée à aucun espace de travail Anthropic : il faut indiquer l'identifiant du workspace (secret COMPTES_ANTHROPIC_WORKSPACE_ID) ou utiliser une clé créée dans un workspace." }, 500)
    // Crédit Anthropic épuisé : message clair plutôt qu'une « erreur 400 »
    if (e instanceof Anthropic.APIError && /credit balance/i.test(String(e.message))) return json({ error: "Le crédit de l'assistant est épuisé. Il faut le recharger (console Anthropic → Plans & Billing) ; en attendant, vous pouvez encoder à la main." }, 402)
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "La clé de l'assistant n'est pas valide : il faut la remplacer." }, 500)
    if (e instanceof Anthropic.APIError) return json({ error: `Erreur du service de lecture (${e.status}).` }, 502)
    return json({ error: (e as Error).message }, 500)
  }
})
