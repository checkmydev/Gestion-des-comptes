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

/** Modèle courant (questions, encodage, corrections, résumés) : bon et deux fois moins cher qu'Opus. */
const MODEL = 'claude-sonnet-5-5'
/** Modèle des recherches de prix sur internet : comparer des produits et des formats demande plus de finesse. */
const MODEL_PRICES = 'claude-opus-5-5'
/** Une question qui demande de chercher des prix (où acheter, moins cher, promotions…). */
const PRICE_QUESTION = /(moins cher|plus cher|bon march|meilleur (magasin|endroit|prix)|o[uù] (acheter|trouver)|promo|d[ée]pliant|compar\w* (les |des )?(magasins|prix)|(cherche|trouve|regarde)\w* (le |les )?prix|prix (sur internet|en ligne|ailleurs|chez|dans les magasins))/i
const MAX_STEPS = 10 // garde-fou de la boucle d'agent

// Coût : tarifs Anthropic en dollars par million de jetons (à revoir s'ils changent) ;
// écriture du cache = 1,25 × l'entrée ; recherche web ≈ 0,01 $ chacune.
const TARIFS: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
}
const WEB_SEARCH_USD = 0.01
const USD_EUR = 0.92
/** Plafond par requête : au-delà, l'historique est compacté et la recherche s'arrête. */
const MAX_COST_EUR = 1
/** Au-delà de cette taille, les anciens messages sont résumés (≈ 8 000 jetons). */
const COMPACT_CHARS = 30000
const COMPACT_MESSAGES = 24
/** Messages récents gardés tels quels lors d'un compactage. */
const KEEP_RECENT = 4

const BUDGET_NOTE = "[Note de l'application] Le plafond de coût de cette question est presque atteint : ne lance plus de recherche ni d'outil. Réponds maintenant avec ce que tu as déjà trouvé, et dis brièvement à l'utilisateur que la recherche a été écourtée pour limiter les frais (il peut reposer une question plus précise)."

type Usage = { input: number; output: number; cache_read: number; cache_write: number; web_searches: number; usd: number }
const costEur = (u: Usage) => USD_EUR * u.usd
/** Additionne la consommation d'un appel, au tarif du modèle qui a répondu (il peut différer en cas de repli). */
const addUsage = (u: Usage, r: Anthropic.Beta.BetaUsage, model: string) => {
  const t = TARIFS[model] ?? TARIFS[MODEL_PRICES]
  const read = r.cache_read_input_tokens ?? 0
  const write = r.cache_creation_input_tokens ?? 0
  const searches = r.server_tool_use?.web_search_requests ?? 0
  u.input += r.input_tokens
  u.output += r.output_tokens
  u.cache_read += read
  u.cache_write += write
  u.web_searches += searches
  u.usd += (r.input_tokens * t.input + r.output_tokens * t.output + read * t.cache_read + write * t.cache_write) / 1e6 + searches * WEB_SEARCH_USD
}

type Turn = { role: 'user' | 'assistant'; content: string }

/** Outils qui modifient les comptes (l'écran affiché est rechargé après). */
const WRITE_TOOLS = new Set([
  'ajouter_achats', 'ajouter_ligne_mois', 'ajouter_plein', 'payer_depense_annuelle', 'ajouter_mouvement_epargne',
  'annuler_ajout', 'supprimer_achats', 'supprimer_article', 'modifier_achat', 'enregistrer_prix_releves',
  'modifier_ligne', 'supprimer_lignes', 'ajouter_trajet_ou_poste', 'modifier_categorie', 'modifier_article', 'modifier_objectifs', 'fixer_solde_mois',
])

/** Résume les anciens échanges (et le résumé précédent) pour alléger le contexte envoyé à l'IA. */
async function summarize(client: Anthropic, previous: string | null, turns: Turn[], usage: Usage): Promise<string> {
  const transcript = turns.map((t) => `${t.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${t.content}`).join('\n\n')
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: "Tu résumes une conversation entre un retraité et l'assistant de son application de comptes, pour que l'assistant puisse la poursuivre. Écris en français, en 15 lignes maximum. Garde : les questions posées, les chiffres et dates donnés, les achats ou lignes ajoutés ou annulés (avec montants et dates), les prix trouvés et magasins, les demandes encore en suspens, les préférences exprimées. Pas de formules de politesse.",
    messages: [{ role: 'user', content: `${previous ? `Résumé déjà établi :\n${previous}\n\nSuite de la conversation :\n` : ''}${transcript}` }],
  })
  addUsage(usage, response.usage, response.model)
  return response.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join('').trim()
}

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
- Tu peux ajouter ou supprimer des données quand l'utilisateur le demande (achats, rentrées et dépenses fixes, pleins, paiements de dépenses annuelles, épargne). Si une information indispensable manque (montant, date, catégorie), demande-la au lieu de l'inventer ; « aujourd'hui », « hier » ou « samedi » se convertissent en date. Les outils vérifient d'eux-mêmes ce qui est déjà enregistré : s'ils signalent un doublon possible, montre clairement ce qui existe déjà et demande si c'est un autre achat ; ne relance avec forcer (ou remplacer) qu'après un « oui » de l'utilisateur. Après chaque ajout, récapitule exactement ce qui a été enregistré (article, montant, date, mois comptable) et précise qu'il peut te demander de l'annuler.
- Une dépense annuelle (assurance, taxe, eau, hospitalisation…) se note avec payer_depense_annuelle, pas comme un achat.
- L'utilisateur fait l'essentiel par la photo de ses tickets et en te parlant. Un ticket photographié apparaît dans la conversation (« Ticket de caisse lu… ») : s'il est marqué PAS ENCORE ENREGISTRÉ, c'est le bouton « Tout enregistrer » sous la fiche qui l'enregistre ; ne l'encode jamais toi-même avec ajouter_achats (risque de doublon). Si l'utilisateur veut corriger une ligne avant d'enregistrer, propose-lui d'enregistrer d'abord puis de te dire la correction, ou de toucher « Corriger une ligne ». Une fois enregistré, corrige avec modifier_achat ou supprimer_achats (retrouve les lignes avec chercher_achats, tri = "saisie").
- Tu peux tout gérer dans ses comptes : pour les lignes du mois (pension, loyer…), pleins, trajets, postes et paiements annuels, épargne, retrouve d'abord la ligne avec lister_lignes, puis modifier_ligne ou supprimer_lignes ; budgets et catégories avec modifier_categorie ; articles (nom, catégorie, icône) avec modifier_article ; plafond annuel et réserve avec modifier_objectifs ; solde de début de mois avec fixer_solde_mois. Dis toujours exactement ce qui a changé, et qu'il peut dire « annule ».
- L'historique ne contient que le texte des échanges précédents, pas les outils utilisés : ce que tu as annoncé comme fait (« C'est fait », « J'ai enregistré… ») a bien été fait ; ne te contredis pas, et vérifie avec les outils en cas de doute.
- Les conversations sont gardées et rangées en groupes. Quand l'utilisateur demande d'effacer une conversation (« supprime cette conversation », « efface tout l'historique »), d'en commencer une nouvelle, d'en reprendre une ancienne ou de la ranger dans un groupe, utilise gerer_conversation (et lister_conversations pour retrouver la bonne). Effacer demande toujours une confirmation.
- Pour corriger un achat déjà encodé (montant, date, magasin, quantité, article), utilise modifier_achat directement quand la demande est claire, puis dis exactement ce qui a changé ; il peut dire « annule ».
- Tu peux supprimer des achats (supprimer_achats), même encodés par l'utilisateur, et des articles du catalogue (supprimer_article), mais seulement à sa demande. Retrouve d'abord les lignes exactes (chercher_achats ; pour « ce que je viens d'ajouter », tri = "saisie"), montre-les clairement (article, montant, date, magasin) et demande « Je supprime bien ceci ? ». Ne rappelle avec confirme = true qu'après un oui explicite. Une phrase comme « supprime-le » après avoir vu les lignes vaut accord si elle désigne sans ambiguïté ce que tu as montré. Après suppression, récapitule et rappelle qu'il peut dire « annule » pour tout remettre.
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
    description: 'Liste des achats filtrés (texte dans le nom de l\'article, catégorie, magasin, dates). Renvoie au plus `limite` lignes, les plus récentes d\'abord (date d\'achat), ou les dernières encodées avec tri = "saisie" (utile pour « ce que je viens d\'ajouter »). Chaque ligne a un numéro, à utiliser pour supprimer_achats.',
    input_schema: {
      type: 'object',
      properties: {
        texte: { type: 'string' }, categorie: { type: 'string' }, magasin: { type: 'string' },
        depuis: { type: 'string', description: 'date AAAA-MM-JJ' }, jusqua: { type: 'string', description: 'date AAAA-MM-JJ' },
        limite: { type: 'integer', minimum: 1, maximum: 200 },
        tri: { type: 'string', enum: ['date', 'saisie'], description: 'date (par défaut) : date d\'achat ; saisie : derniers encodés' },
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
        litres: { type: 'number' }, prix_litre: { type: 'number' }, km: { type: 'number', description: 'compteur kilométrique (pour la consommation aux 100 km)' }, forcer: { type: 'boolean' },
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
    name: 'supprimer_achats',
    description: "Supprime des achats (y compris ceux encodés par l'utilisateur), désignés par leur numéro obtenu avec chercher_achats. En deux temps : d'abord sans confirme, l'outil renvoie le détail des lignes à montrer à l'utilisateur ; ensuite, seulement après son accord explicite, rappelle avec confirme = true. Annulable avec annuler_ajout.",
    input_schema: {
      type: 'object',
      properties: {
        numeros: { type: 'array', items: { type: 'integer' }, description: 'numéros des achats (chercher_achats)' },
        confirme: { type: 'boolean', description: "true uniquement après l'accord explicite de l'utilisateur" },
      },
      required: ['numeros'],
      additionalProperties: false,
    },
  },
  {
    name: 'lister_conversations',
    description: "Liste les conversations gardées avec l'assistant (numéro, titre, groupe, date, nombre de messages), la conversation en cours étant signalée. Pour en rouvrir, supprimer ou ranger une.",
    input_schema: { type: 'object', properties: { groupe: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'gerer_conversation',
    description: "Agit sur les conversations à la demande de l'utilisateur (à l'écrit ou à la voix) : « nouvelle » commence une nouvelle conversation (dans un groupe si précisé) ; « ouvrir » revient à une conversation existante (numero de lister_conversations) ; « ranger » met une conversation (par défaut celle en cours) dans un groupe (créé s'il n'existe pas) ; « supprimer » efface une conversation (par défaut celle en cours) ou toutes (toutes = true) — en deux temps : sans confirme, l'outil décrit ce qui sera effacé ; rappelle avec confirme = true après un oui explicite. Les comptes ne sont jamais touchés.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['nouvelle', 'ouvrir', 'ranger', 'supprimer'] },
        numero: { type: 'integer', description: 'conversation visée (lister_conversations) ; absent = conversation en cours' },
        groupe: { type: 'string' },
        toutes: { type: 'boolean' },
        confirme: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'lister_lignes',
    description: "Liste, avec leur numéro, les autres données des comptes : lignes du mois (rentrées et dépenses fixes : pension, loyer, électricité…), pleins d'essence, trajets, postes annuels (assurances, taxes… avec montant prévu et mois d'échéance), paiements de dépenses annuelles, mouvements d'épargne. Les numéros servent à modifier_ligne et supprimer_lignes.",
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['lignes_mois', 'pleins', 'trajets', 'postes_annuels', 'paiements_annuels', 'epargne'] },
        mois: { type: 'string', description: 'AAAA-MM-01 (lignes du mois, pleins, trajets)' },
        annee: { type: 'integer', description: 'postes annuels, paiements, épargne' },
        limite: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
  {
    name: 'modifier_ligne',
    description: "Corrige une ligne obtenue avec lister_lignes. Champs possibles selon le type — lignes_mois : libelle, montant, section (revenu|fixe), note, reporter (recopiée le mois suivant) ; pleins : station, date, litres, prix_litre, km, montant ; trajets : libelle, date, km_aller_retour ; postes_annuels : libelle, montant_annuel, mois_echeance (1-12) ; paiements_annuels : date, montant, note ; epargne : date, libelle, montant (+ apport, − retrait), note. Seuls les champs donnés changent. Annulable.",
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['lignes_mois', 'pleins', 'trajets', 'postes_annuels', 'paiements_annuels', 'epargne'] },
        numero: { type: 'integer' },
        champs: {
          type: 'object',
          properties: {
            libelle: { type: 'string' }, montant: { type: 'number' }, section: { type: 'string', enum: ['revenu', 'fixe'] }, note: { type: 'string' },
            reporter: { type: 'boolean' }, station: { type: 'string' }, date: { type: 'string' }, litres: { type: 'number' }, prix_litre: { type: 'number' }, km: { type: 'number' },
            km_aller_retour: { type: 'number' }, montant_annuel: { type: 'number' }, mois_echeance: { type: 'integer' },
          },
          additionalProperties: false,
        },
      },
      required: ['type', 'numero', 'champs'],
      additionalProperties: false,
    },
  },
  {
    name: 'supprimer_lignes',
    description: "Supprime des lignes obtenues avec lister_lignes (même type). En deux temps : sans confirme, renvoie le détail à montrer ; après l'accord explicite de l'utilisateur, rappelle avec confirme = true. Annulable.",
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['lignes_mois', 'pleins', 'trajets', 'postes_annuels', 'paiements_annuels', 'epargne'] },
        numeros: { type: 'array', items: { type: 'integer' } },
        confirme: { type: 'boolean' },
      },
      required: ['type', 'numeros'],
      additionalProperties: false,
    },
  },
  {
    name: 'ajouter_trajet_ou_poste',
    description: "Ajoute un trajet en voiture (type trajets : libelle, date, km_aller_retour) ou un poste de dépense annuelle à prévoir (type postes_annuels : libelle, montant_annuel, mois_echeance, annee). Pour un plein, utilise ajouter_plein ; pour payer un poste annuel, payer_depense_annuelle.",
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['trajets', 'postes_annuels'] },
        libelle: { type: 'string' }, date: { type: 'string' }, km_aller_retour: { type: 'number' },
        montant_annuel: { type: 'number' }, mois_echeance: { type: 'integer' }, annee: { type: 'integer' },
      },
      required: ['type', 'libelle'],
      additionalProperties: false,
    },
  },
  {
    name: 'modifier_categorie',
    description: "Modifie une catégorie : budget mensuel (null pour le retirer), nom, ou archivage (masquée de la saisie). Annulable.",
    input_schema: {
      type: 'object',
      properties: {
        categorie: { type: 'string' },
        budget_mensuel: { type: ['number', 'null'] }, nouveau_nom: { type: 'string' }, archivee: { type: 'boolean' },
      },
      required: ['categorie'],
      additionalProperties: false,
    },
  },
  {
    name: 'modifier_article',
    description: "Modifie un article du catalogue (pas un achat) : le renommer, le déplacer dans une autre catégorie, ou changer son icône (un émoji ; chaîne vide = icône automatique). Tous ses achats suivent. Annulable.",
    input_schema: {
      type: 'object',
      properties: {
        article: { type: 'string' }, categorie: { type: 'string', description: 'catégorie actuelle, pour lever une ambiguïté' },
        nouveau_nom: { type: 'string' }, nouvelle_categorie: { type: 'string' }, icone: { type: 'string' },
      },
      required: ['article'],
      additionalProperties: false,
    },
  },
  {
    name: 'modifier_objectifs',
    description: "Modifie les objectifs : plafond des dépenses annuelles et réserve « imprévus » visée sur l'épargne. Annulable.",
    input_schema: {
      type: 'object',
      properties: { plafond_annuel: { type: 'number' }, reserve_imprevus: { type: 'number' } },
      additionalProperties: false,
    },
  },
  {
    name: 'fixer_solde_mois',
    description: "Fixe le solde du compte au début d'un mois comptable (quand le solde calculé est faux), ou revient au calcul automatique avec solde = null. Annulable.",
    input_schema: {
      type: 'object',
      properties: { mois: { type: 'string', description: 'AAAA-MM-01' }, solde: { type: ['number', 'null'] } },
      required: ['mois', 'solde'],
      additionalProperties: false,
    },
  },
  {
    name: 'modifier_achat',
    description: "Corrige un achat existant (y compris encodé par l'utilisateur ou lu sur un ticket), désigné par son numéro (chercher_achats) : montant, date, magasin, nombre, poids, prix au kilo, ou article (renommer / changer de catégorie). Seuls les champs donnés changent. À utiliser quand l'utilisateur signale une erreur (« le beurre coûtait 2,29 € »). Annulable avec annuler_ajout.",
    input_schema: {
      type: 'object',
      properties: {
        numero: { type: 'integer' },
        montant: { type: 'number' }, date: { type: 'string', description: 'AAAA-MM-JJ' }, magasin: { type: 'string' },
        nombre: { type: 'integer' }, poids_g: { type: 'number' }, prix_kg: { type: 'number' },
        article: { type: 'string', description: "nouveau nom d'article (créé s'il n'existe pas)" },
        categorie: { type: 'string', description: "nouvelle catégorie de l'article" },
      },
      required: ['numero'],
      additionalProperties: false,
    },
  },
  {
    name: 'supprimer_article',
    description: "Supprime un article de la liste des articles (catalogue de la saisie), par exemple un article créé par erreur ou en double. Impossible s'il a encore des achats : l'outil le dit, et il faut d'abord supprimer ces achats (si l'utilisateur le veut) ou les garder. En deux temps comme supprimer_achats (confirme = true après accord).",
    input_schema: {
      type: 'object',
      properties: {
        article: { type: 'string', description: "nom exact de l'article" },
        categorie: { type: 'string', description: 'pour lever une ambiguïté' },
        confirme: { type: 'boolean' },
      },
      required: ['article'],
      additionalProperties: false,
    },
  },
  {
    name: 'annuler_ajout',
    description: "Annule des ajouts, modifications ou suppressions faits par l'assistant (remet une ligne supprimée, retire une ligne ajoutée, remet l'ancien montant). Sans paramètre : annule la dernière demande (toutes ses lignes). Sinon, donne les numéros du journal obtenus avec derniers_ajouts. Uniquement à la demande de l'utilisateur ou pour corriger ta propre erreur.",
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

/** Outils d'écriture qui, pour une demande dictée, attendent la validation du résumé par l'utilisateur. */
const VALIDATED_TOOLS = new Set([
  'ajouter_achats', 'ajouter_ligne_mois', 'ajouter_plein', 'payer_depense_annuelle', 'ajouter_mouvement_epargne', 'modifier_achat', 'enregistrer_prix_releves',
  'modifier_ligne', 'ajouter_trajet_ou_poste', 'modifier_categorie', 'modifier_article', 'modifier_objectifs', 'fixer_solde_mois',
])
for (const t of TOOLS as any[]) {
  if (VALIDATED_TOOLS.has(t.name)) t.input_schema.properties.confirme ??= { type: 'boolean', description: "true seulement quand l'utilisateur a validé le résumé (obligatoire pour une demande dictée)" }
}

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

/** Article de la catégorie (créé s'il n'existe pas encore). */
async function ensureItemDb(db: Db, categoryId: number, name: string): Promise<{ id: number; name: string }> {
  const items = await must(db.from('items').select('id, name').eq('category_id', categoryId)) as { id: number; name: string }[]
  return items.find((i) => norm(i.name) === norm(name))
    ?? await must(db.from('items').insert({ category_id: categoryId, name: name.trim() }).select('id, name').single()) as { id: number; name: string }
}

/** Magasin (créé s'il n'existe pas encore). */
async function ensureStoreDb(db: Db, name: string): Promise<{ id: number; name: string }> {
  const stores = await must(db.from('stores').select('id, name')) as { id: number; name: string }[]
  return stores.find((s) => norm(s.name) === norm(name))
    ?? await must(db.from('stores').insert({ name: name.trim() }).select('id, name').single()) as { id: number; name: string }
}

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

/** Conversations avec l'assistant : lister, ouvrir, nouvelle, ranger, supprimer. */
async function conversationTool(db: Db, name: string, input: Input, current: number | null): Promise<{ out: unknown; nav?: Record<string, unknown> }> {
  const rows = await must(db.from('assistant_conversations').select('id, titre, groupe, updated_at, messages').order('updated_at', { ascending: false }).limit(100)) as Record<string, any>[]
  const describe = (r: Record<string, any>) => ({
    numero: r.id, titre: r.titre || 'sans titre', groupe: r.groupe ?? 'Sans groupe',
    derniere_activite: new Date(r.updated_at).toLocaleString('fr-BE', { timeZone: 'Europe/Brussels', dateStyle: 'short', timeStyle: 'short' }),
    messages: Array.isArray(r.messages) ? r.messages.length : 0, en_cours: r.id === current,
  })
  if (name === 'lister_conversations') {
    const g = str(input.groupe)
    return { out: (g ? rows.filter((r) => norm(r.groupe ?? '').includes(norm(g))) : rows).map(describe) }
  }
  const action = String(input.action)
  const target = Number.isInteger(input.numero) ? rows.find((r) => r.id === Number(input.numero)) : rows.find((r) => r.id === current)
  if (action === 'nouvelle') {
    return { out: { fait: true, message: "L'application ouvre une nouvelle conversation après ta réponse : dis-le en une phrase." }, nav: { type: 'nouvelle', groupe: str(input.groupe) ?? null } }
  }
  if (action === 'ouvrir') {
    if (!target) return { out: { message: 'Conversation introuvable : utilise lister_conversations.' } }
    return { out: { fait: true, ouverte: describe(target), message: "L'application affiche cette conversation après ta réponse : annonce-le en une phrase." }, nav: { type: 'ouvrir', id: target.id } }
  }
  if (action === 'ranger') {
    const g = str(input.groupe)
    if (!g) return { out: { message: 'Indique le nom du groupe.' } }
    if (!target) return { out: { message: "Aucune conversation en cours : elle n'est pas encore enregistrée." } }
    const existing = [...new Set(rows.map((r) => r.groupe).filter(Boolean))] as string[]
    const name2 = existing.find((x) => norm(x) === norm(g)) ?? g.charAt(0).toUpperCase() + g.slice(1)
    await must(db.from('assistant_conversations').update({ groupe: name2 }).eq('id', target.id))
    return { out: { fait: true, conversation: target.titre, groupe: name2, nouveau_groupe: !existing.some((x) => norm(x) === norm(g)) }, nav: { type: 'rangee', id: target.id, groupe: name2 } }
  }
  if (action === 'supprimer') {
    const victims = input.toutes === true ? rows : target ? [target] : []
    if (!victims.length) return { out: { message: 'Aucune conversation à supprimer.' } }
    if (input.confirme !== true) {
      return { out: { a_confirmer: victims.map(describe), consigne: "Rien n'est encore effacé. Dis clairement ce qui sera effacé (les comptes ne sont pas touchés) et demande confirmation ; rappelle avec confirme = true après un oui." } }
    }
    const ids = victims.map((r) => r.id)
    await must(db.from('assistant_usage').delete().in('conversation_id', ids))
    await must(db.from('assistant_conversations').delete().in('id', ids))
    return { out: { fait: true, effacees: victims.length, message: 'Effacé. Confirme en une phrase ; une nouvelle conversation commence.' }, nav: { type: 'supprimees', ids } }
  }
  return { out: { message: 'Action inconnue.' } }
}

/** Données « autres que les achats » que l'assistant peut lister, corriger et supprimer. */
type LineSpec = {
  table: string; label: string; select: string; order: string; period: boolean; dateCol?: string; yearCol?: string
  fields: Record<string, string>; show: (r: Record<string, any>) => Record<string, unknown>; name: (r: Record<string, any>) => string
}
const LINE_TYPES: Record<string, LineSpec> = {
  lignes_mois: {
    table: 'monthly_lines', label: 'ligne du mois', select: '*', order: 'period', period: true,
    fields: { libelle: 'label', montant: 'amount', section: 'section', note: 'note', reporter: 'carry_over' },
    show: (r) => ({ mois: r.period, section: r.section === 'revenu' ? 'rentrée' : 'dépense fixe', libelle: r.label, montant: Number(r.amount), note: r.note, recopiee_mois_suivant: r.carry_over }),
    name: (r) => `${r.label} ${Number(r.amount)} € (${r.period})`,
  },
  pleins: {
    table: 'fuel_fills', label: 'plein', select: '*', order: 'filled_on', period: true, dateCol: 'filled_on',
    fields: { station: 'station', date: 'filled_on', litres: 'litres', prix_litre: 'price_per_litre', km: 'km', montant: 'total' },
    show: (r) => ({ mois: r.period, date: r.filled_on, station: r.station, montant: Number(r.total), litres: r.litres, prix_litre: r.price_per_litre, km: r.km }),
    name: (r) => `plein ${r.station} ${Number(r.total)} € le ${r.filled_on ?? '?'}`,
  },
  trajets: {
    table: 'trips', label: 'trajet', select: '*', order: 'trip_date', period: true, dateCol: 'trip_date',
    fields: { libelle: 'label', date: 'trip_date', km_aller_retour: 'km_round_trip' },
    show: (r) => ({ mois: r.period, date: r.trip_date, libelle: r.label, km_aller_retour: Number(r.km_round_trip) }),
    name: (r) => `trajet ${r.label} (${r.trip_date ?? r.period})`,
  },
  postes_annuels: {
    table: 'annual_provisions', label: 'poste annuel', select: '*', order: 'year', period: false, yearCol: 'year',
    fields: { libelle: 'label', montant_annuel: 'annual_amount', mois_echeance: 'due_month' },
    show: (r) => ({ annee: r.year, libelle: r.label, montant_annuel: Number(r.annual_amount), mois_echeance: r.due_month }),
    name: (r) => `${r.label} ${r.year} (${Number(r.annual_amount)} €/an)`,
  },
  paiements_annuels: {
    table: 'annual_payments', label: 'paiement annuel', select: '*, annual_provisions(label, year)', order: 'paid_on', period: false, dateCol: 'paid_on', yearCol: 'paid_on',
    fields: { date: 'paid_on', montant: 'amount', note: 'note' },
    show: (r) => ({ poste: r.annual_provisions?.label, date: r.paid_on, montant: Number(r.amount), note: r.note }),
    name: (r) => `paiement ${r.annual_provisions?.label ?? ''} ${Number(r.amount)} € le ${r.paid_on}`,
  },
  epargne: {
    table: 'savings_movements', label: 'mouvement d\'épargne', select: '*', order: 'moved_on', period: false, dateCol: 'moved_on', yearCol: 'moved_on',
    fields: { date: 'moved_on', libelle: 'label', montant: 'amount', note: 'note' },
    show: (r) => ({ date: r.moved_on, libelle: r.label, montant: Number(r.amount), note: r.note }),
    name: (r) => `épargne « ${r.label} » ${Number(r.amount)} € le ${r.moved_on}`,
  },
}

async function runTool(db: Db, name: string, input: Input, question: string, group: string): Promise<unknown> {
  const log = (table: string, rowId: number, resume: string, action: 'ajout' | 'modification' | 'suppression' = 'ajout', avant: number | null = null, ligne: unknown = null) =>
    must(db.from('assistant_actions').insert({ table_name: table, row_id: rowId, resume, action, avant, ligne, groupe: group }))
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
        litres: Number(input.litres) > 0 ? round2(Number(input.litres)) : null,
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
    case 'supprimer_achats': {
      const ids = (Array.isArray(input.numeros) ? input.numeros : []).map(Number).filter(Number.isInteger).slice(0, 30)
      if (!ids.length) throw new Error('aucun numéro d\'achat fourni (utilise chercher_achats)')
      const rows = await must(db.from('purchases').select('*, items(name, categories(name)), stores(name)').in('id', ids)) as Record<string, any>[]
      const describe = (r: Record<string, any>) => `${r.items?.name ?? '?'} (${r.items?.categories?.name ?? '?'}), ${Number(r.amount).toFixed(2).replace('.', ',')} €, le ${r.purchased_on ?? '?'}${r.stores?.name ? ` chez ${r.stores.name}` : ''}`
      const introuvables = ids.filter((id) => !rows.some((r) => r.id === id))
      if (input.confirme !== true) {
        return {
          a_confirmer: rows.map((r) => ({ numero: r.id, achat: describe(r), mois: r.period, note: r.note })),
          introuvables,
          consigne: "Rien n'est encore supprimé. Montre ces lignes à l'utilisateur et demande-lui de confirmer ; rappelle avec confirme = true seulement après son accord.",
        }
      }
      const done: string[] = []
      for (const r of rows) {
        const { items: _i, stores: _s, ...ligne } = r
        await must(db.from('purchases').delete().eq('id', r.id))
        await log('purchases', r.id, `Suppression : ${describe(r)}`, 'suppression', null, ligne)
        done.push(describe(r))
      }
      return { supprimes: done, introuvables, annulable: true }
    }
    case 'lister_lignes': {
      const spec = LINE_TYPES[String(input.type)]
      if (!spec) throw new Error('type inconnu')
      const limite = Math.min(Math.max(Number(input.limite) || 50, 1), 100)
      let q = db.from(spec.table).select(spec.select).order(spec.order, { ascending: false }).limit(limite)
      if (isPeriod(str(input.mois)) && spec.period) q = q.eq('period', str(input.mois)!)
      const annee = Number(input.annee)
      if (annee && spec.yearCol === 'year') q = q.eq('year', annee)
      else if (annee && spec.yearCol) q = q.gte(spec.yearCol, `${annee}-01-01`).lte(spec.yearCol, `${annee}-12-31`)
      return (await must(q) as Record<string, any>[]).map((r) => ({ numero: r.id, ...spec.show(r) }))
    }
    case 'modifier_ligne': {
      const spec = LINE_TYPES[String(input.type)]
      if (!spec) throw new Error('type inconnu')
      const id = Number(input.numero)
      const before = await must(db.from(spec.table).select('*').eq('id', id).maybeSingle()) as Record<string, any> | null
      if (!before) return { message: `Aucune ligne n° ${id} de ce type.` }
      const champs = (input.champs ?? {}) as Record<string, unknown>
      const patch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(champs)) {
        const col = spec.fields[k]
        if (!col) return { message: `Le champ « ${k} » ne s'applique pas à ce type.`, champs_possibles: Object.keys(spec.fields) }
        if (spec.dateCol === col && !isDate(String(v))) return { message: 'Date attendue au format AAAA-MM-JJ.' }
        patch[col] = v
      }
      if (!Object.keys(patch).length) return { message: 'Rien à modifier.' }
      // La date décide du mois comptable
      if (spec.period && spec.dateCol && typeof patch[spec.dateCol] === 'string') patch.period = periodForDate(patch[spec.dateCol] as string)
      await must(db.from(spec.table).update(patch).eq('id', id))
      const changes = Object.entries(patch).map(([k, v]) => `${k} : ${before[k] ?? '—'} → ${v}`)
      await log(spec.table, id, `Correction (${spec.label}) « ${spec.name(before)} » : ${changes.join(', ')}`, 'modification', null, before)
      return { modifie: true, ligne: spec.name(before), changements: changes, annulable: true }
    }
    case 'supprimer_lignes': {
      const spec = LINE_TYPES[String(input.type)]
      if (!spec) throw new Error('type inconnu')
      const ids = (Array.isArray(input.numeros) ? input.numeros : []).map(Number).filter(Number.isInteger).slice(0, 30)
      const rows = await must(db.from(spec.table).select('*').in('id', ids)) as Record<string, any>[]
      if (spec.table === 'annual_provisions') {
        const { count } = await db.from('annual_payments').select('id', { count: 'exact', head: true }).in('provision_id', ids)
        if (count) return { impossible: true, message: `Ce poste a ${count} paiement(s) : supprime d'abord ces paiements (type paiements_annuels) si l'utilisateur le veut vraiment.` }
      }
      if (input.confirme !== true) {
        return { a_confirmer: rows.map((r) => ({ numero: r.id, ...spec.show(r) })), introuvables: ids.filter((id) => !rows.some((r) => r.id === id)), consigne: "Rien n'est encore supprimé. Montre ces lignes et demande confirmation ; rappelle avec confirme = true seulement après un oui." }
      }
      const done: string[] = []
      for (const r of rows) {
        await must(db.from(spec.table).delete().eq('id', r.id))
        await log(spec.table, r.id, `Suppression (${spec.label}) : ${spec.name(r)}`, 'suppression', null, r)
        done.push(spec.name(r))
      }
      return { supprimes: done, annulable: true }
    }
    case 'ajouter_trajet_ou_poste': {
      if (input.type === 'trajets') {
        const date = isDate(str(input.date)) ? str(input.date)! : todayIso()
        const row = await must(db.from('trips').insert({ period: periodForDate(date), label: str(input.libelle), trip_date: date, km_round_trip: Number(input.km_aller_retour) || 0 }).select('*').single()) as Record<string, any>
        await log('trips', row.id, `Trajet : ${row.label}, ${row.km_round_trip} km A/R, le ${date}`)
        return { ajoute: `trajet « ${row.label} », ${row.km_round_trip} km aller-retour, le ${date} (mois ${row.period})` }
      }
      const annee = Number(input.annee) || Number(currentPeriod().slice(0, 4))
      const echeance = Number(input.mois_echeance)
      const row = await must(db.from('annual_provisions').insert({
        year: annee, label: str(input.libelle), annual_amount: Number(input.montant_annuel) || 0, due_month: echeance >= 1 && echeance <= 12 ? echeance : null,
      }).select('*').single()) as Record<string, any>
      await log('annual_provisions', row.id, `Poste annuel ${annee} : ${row.label}, ${row.annual_amount} €`)
      return { ajoute: `poste annuel « ${row.label} » (${annee}), ${row.annual_amount} € par an${row.due_month ? `, échéance en mois ${row.due_month}` : ''}` }
    }
    case 'modifier_categorie': {
      const cats = await must(db.from('categories').select('*')) as Record<string, any>[]
      const cat = cats.find((c) => norm(c.name) === norm(str(input.categorie) ?? '')) ?? cats.find((c) => norm(c.name).includes(norm(str(input.categorie) ?? '')))
      if (!cat) return { message: `Catégorie « ${str(input.categorie)} » inconnue.`, categories: cats.map((c) => c.name) }
      const patch: Record<string, unknown> = {}
      if ('budget_mensuel' in input) patch.monthly_budget = input.budget_mensuel == null ? null : round2(Number(input.budget_mensuel))
      if (str(input.nouveau_nom)) patch.name = str(input.nouveau_nom)
      if (typeof input.archivee === 'boolean') patch.archived = input.archivee
      if (!Object.keys(patch).length) return { message: 'Rien à modifier.' }
      await must(db.from('categories').update(patch).eq('id', cat.id))
      await log('categories', cat.id, `Catégorie « ${cat.name} » : ${Object.entries(patch).map(([k, v]) => `${k} → ${v ?? 'aucun'}`).join(', ')}`, 'modification', null, cat)
      return { modifie: true, categorie: cat.name, changements: patch, annulable: true }
    }
    case 'modifier_article': {
      const [cats, items] = await Promise.all([
        must(db.from('categories').select('id, name')) as Promise<{ id: number; name: string }[]>,
        must(db.from('items').select('*')) as Promise<Record<string, any>[]>,
      ])
      let found = items.filter((i) => norm(i.name) === norm(str(input.article) ?? ''))
      if (str(input.categorie)) found = found.filter((i) => norm(cats.find((c) => c.id === i.category_id)?.name ?? '').includes(norm(str(input.categorie)!)))
      if (found.length !== 1) {
        return { message: found.length ? 'Plusieurs articles portent ce nom : précise la catégorie.' : `Aucun article ne s'appelle exactement « ${str(input.article)} ».`,
          proches: items.filter((i) => norm(i.name).includes(norm(str(input.article) ?? ''))).slice(0, 10).map((i) => `${i.name} (${cats.find((c) => c.id === i.category_id)?.name})`) }
      }
      const item = found[0]
      const patch: Record<string, unknown> = {}
      if (str(input.nouveau_nom)) patch.name = str(input.nouveau_nom)
      if (str(input.nouvelle_categorie)) {
        const cat = cats.find((c) => norm(c.name).includes(norm(str(input.nouvelle_categorie)!)))
        if (!cat) return { message: `Catégorie « ${str(input.nouvelle_categorie)} » inconnue.`, categories: cats.map((c) => c.name) }
        patch.category_id = cat.id
      }
      if (typeof input.icone === 'string') patch.icon = input.icone.trim() || null
      if (!Object.keys(patch).length) return { message: 'Rien à modifier.' }
      const clash = items.find((i) => i.id !== item.id && i.category_id === (patch.category_id ?? item.category_id) && norm(i.name) === norm(String(patch.name ?? item.name)))
      if (clash) return { message: `Un article « ${clash.name} » existe déjà dans cette catégorie : il faudrait plutôt déplacer ses achats (modifier_achat) puis supprimer l'article en double.` }
      await must(db.from('items').update(patch).eq('id', item.id))
      await log('items', item.id, `Article « ${item.name} » : ${Object.entries(patch).map(([k, v]) => `${k} → ${k === 'category_id' ? cats.find((c) => c.id === v)?.name : v ?? 'auto'}`).join(', ')}`, 'modification', null, item)
      return { modifie: true, article: item.name, annulable: true }
    }
    case 'modifier_objectifs': {
      const before = await must(db.from('user_settings').select('*').maybeSingle()) as Record<string, any> | null
      const patch: Record<string, unknown> = {}
      if (typeof input.plafond_annuel === 'number') patch.annual_budget = round2(input.plafond_annuel)
      if (typeof input.reserve_imprevus === 'number') patch.emergency_target = round2(input.reserve_imprevus)
      if (!Object.keys(patch).length) return { message: 'Rien à modifier.' }
      await must(db.from('user_settings').upsert({ ...(before ?? {}), ...patch }))
      await log('user_settings', 0, `Objectifs : ${Object.entries(patch).map(([k, v]) => `${k === 'annual_budget' ? 'plafond annuel' : 'réserve imprévus'} ${before?.[k] ?? '—'} → ${v} €`).join(', ')}`, 'modification', null, before)
      return { modifie: true, changements: patch, annulable: true }
    }
    case 'fixer_solde_mois': {
      const mois = str(input.mois)
      if (!isPeriod(mois)) throw new Error('mois attendu au format AAAA-MM-01')
      const before = await must(db.from('months').select('*').eq('period', mois!).maybeSingle()) as Record<string, any> | null
      const solde = input.solde == null ? null : round2(Number(input.solde))
      await must(db.from('months').upsert({ period: mois, opening_balance: solde, ...(before ? { notes: before.notes } : {}) }))
      await log('months', 0, `Solde de début de ${mois} : ${before?.opening_balance ?? 'automatique'} → ${solde ?? 'automatique'}`, 'modification', null, before ?? { period: mois, opening_balance: null })
      return { modifie: true, mois, solde_debut: solde ?? 'calcul automatique', annulable: true }
    }
    case 'modifier_achat': {
      const id = Number(input.numero)
      const before = await must(db.from('purchases').select('*, items(name, category_id, categories(name)), stores(name)').eq('id', id).maybeSingle()) as Record<string, any> | null
      if (!before) return { message: `Aucun achat n° ${id}.` }
      const patch: Record<string, unknown> = {}
      const changes: string[] = []
      if (typeof input.montant === 'number') { patch.amount = round2(input.montant); changes.push(`montant ${Number(before.amount)} → ${round2(input.montant)} €`) }
      if (isDate(str(input.date))) {
        patch.purchased_on = str(input.date); patch.period = periodForDate(str(input.date)!)
        changes.push(`date ${before.purchased_on} → ${str(input.date)} (mois ${patch.period})`)
      }
      if (str(input.magasin)) {
        const st = await ensureStoreDb(db, str(input.magasin)!)
        patch.store_id = st.id; changes.push(`magasin → ${st.name}`)
      }
      if (Number.isInteger(input.nombre)) { patch.units = Number(input.nombre) > 1 ? Number(input.nombre) : null; changes.push(`nombre → ${input.nombre}`) }
      if (typeof input.poids_g === 'number') { patch.quantity_g = input.poids_g; changes.push(`poids → ${input.poids_g} g`) }
      if (typeof input.prix_kg === 'number') { patch.price_per_kg = input.prix_kg; changes.push(`prix au kilo → ${input.prix_kg} €/kg`) }
      if (str(input.article) || str(input.categorie)) {
        const cats = await must(db.from('categories').select('id, name')) as { id: number; name: string }[]
        const cat = str(input.categorie) ? cats.find((c) => norm(c.name).includes(norm(str(input.categorie)!))) : cats.find((c) => c.id === before.items?.category_id)
        if (!cat) return { message: `Catégorie « ${str(input.categorie)} » inconnue.`, categories: cats.map((c) => c.name) }
        const name = str(input.article) ?? before.items?.name
        const item = await ensureItemDb(db, cat.id, name)
        patch.item_id = item.id; changes.push(`article → ${item.name} (${cat.name})`)
      }
      if (!changes.length) return { message: 'Rien à modifier : précise le champ à corriger.' }
      const { items: _i, stores: _s, ...ligne } = before
      await must(db.from('purchases').update(patch).eq('id', id))
      await log('purchases', id, `Correction de l'achat ${before.items?.name ?? '?'} du ${before.purchased_on} : ${changes.join(', ')}`, 'modification', null, ligne)
      return { modifie: true, achat: before.items?.name, changements: changes, annulable: true }
    }
    case 'supprimer_article': {
      const wanted = str(input.article) ?? ''
      const [cats, items] = await Promise.all([
        must(db.from('categories').select('id, name')) as Promise<{ id: number; name: string }[]>,
        must(db.from('items').select('*')) as Promise<Record<string, any>[]>,
      ])
      const catName = (id: number) => cats.find((c) => c.id === id)?.name ?? '?'
      let found = items.filter((i) => norm(i.name) === norm(wanted))
      if (str(input.categorie)) found = found.filter((i) => norm(catName(i.category_id)).includes(norm(str(input.categorie)!)))
      if (!found.length) {
        const proches = items.filter((i) => norm(i.name).includes(norm(wanted))).slice(0, 10).map((i) => `${i.name} (${catName(i.category_id)})`)
        return { message: `Aucun article ne s'appelle exactement « ${wanted} ».`, articles_proches: proches }
      }
      if (found.length > 1) return { message: 'Plusieurs articles portent ce nom : précise la catégorie.', articles: found.map((i) => `${i.name} (${catName(i.category_id)})`) }
      const item = found[0]
      const { count } = await db.from('purchases').select('id', { count: 'exact', head: true }).eq('item_id', item.id)
      if (count) {
        return { impossible: true, message: `« ${item.name} » (${catName(item.category_id)}) a encore ${count} achat(s). Pour le retirer, il faut d'abord supprimer ces achats (chercher_achats puis supprimer_achats), si l'utilisateur le veut vraiment.` }
      }
      const label = `${item.name} (${catName(item.category_id)})`
      if (input.confirme !== true) {
        return { a_confirmer: `l'article « ${label} », sans aucun achat`, consigne: "Rien n'est encore supprimé. Demande confirmation, puis rappelle avec confirme = true." }
      }
      await must(db.from('items').delete().eq('id', item.id))
      await log('items', item.id, `Suppression de l'article : ${label}`, 'suppression', null, item)
      return { supprime: label, annulable: true }
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
        if (a.action === 'modification' && a.table_name === 'user_settings') {
          if (a.ligne) await must(db.from('user_settings').upsert(a.ligne))
        } else if (a.action === 'modification' && a.table_name === 'months') {
          await must(db.from('months').upsert(a.ligne))
        } else if (a.action === 'modification' && a.ligne) {
          const { id: _id, user_id: _u, created_at: _c, ...ligne } = a.ligne as Record<string, unknown>
          await must(db.from(a.table_name).update(ligne).eq('id', a.row_id))
        } else if (a.action === 'modification') {
          await must(db.from(a.table_name).update({ amount: a.avant }).eq('id', a.row_id))
        } else if (a.action === 'suppression') {
          if (!a.ligne) throw new Error('ligne supprimée introuvable dans le journal')
          const { id: _id, ...ligne } = a.ligne as Record<string, unknown>
          await must(db.from(a.table_name).insert(ligne))
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
        .select('id, created_at, purchased_on, period, amount, units, quantity_g, price_per_kg, promo_pct, note, items(name, categories(name)), stores(name)')
        .order(input.tri === 'saisie' ? 'id' : 'purchased_on', { ascending: false, nullsFirst: false }).limit(limite)
      if (ids) q = q.in('item_id', ids.slice(0, 300))
      if (isDate(str(input.depuis))) q = q.gte('purchased_on', str(input.depuis)!)
      if (isDate(str(input.jusqua))) q = q.lte('purchased_on', str(input.jusqua)!)
      let rows = await must(q) as Record<string, any>[]
      if (str(input.magasin)) rows = rows.filter((r) => norm(r.stores?.name ?? '').includes(norm(str(input.magasin)!)))
      return rows.map((r) => ({
        numero: r.id, date: r.purchased_on, encode_le: r.created_at ? new Date(r.created_at).toLocaleString('fr-BE', { timeZone: 'Europe/Brussels', dateStyle: 'short', timeStyle: 'short' }) : null, mois: r.period, article: r.items?.name, categorie: r.items?.categories?.name, magasin: r.stores?.name ?? null,
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
  // (les messages déjà couverts par le résumé ne sont pas renvoyés)
  let history: Turn[] = []
  let resume: string | null = null
  let conversationId: number | null = null
  let voice = false
  let screen: { page: string | null; mois: string | null } | null = null
  try {
    const body = await req.json()
    history = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m: any) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 8000) }))
    resume = typeof body.resume === 'string' && body.resume.trim() ? body.resume.slice(0, 6000) : null
    conversationId = Number.isInteger(body.conversation_id) ? body.conversation_id : null
    voice = body.voix === true
    if (body.ecran && typeof body.ecran === 'object') {
      screen = { page: typeof body.ecran.page === 'string' ? body.ecran.page.slice(0, 120) : null, mois: isPeriod(body.ecran.mois) ? body.ecran.mois : null }
    }
  } catch { /* corps invalide */ }
  // Deux messages de suite du même côté (ex. photo d'un ticket puis question) : regroupés.
  history = history.reduce<Turn[]>((acc, m) => {
    const last = acc[acc.length - 1]
    if (last && last.role === m.role) last.content += `\n\n${m.content}`
    else acc.push({ ...m })
    return acc
  }, [])
  // Garde-fou si l'application envoie un historique trop long : seuls les 60 derniers messages comptent.
  let dropped = Math.max(0, history.length - 60)
  history = history.slice(dropped)
  while (history.length && history[0].role !== 'user') { history.shift(); dropped++ }
  if (!history.length || history[history.length - 1].role !== 'user') return json({ error: 'Message manquant.' }, 400)

  const apiKey = (Deno.env.get('COMPTES_ANTHROPIC_API_KEY') ?? '').trim()
  if (!apiKey) return json({ error: "L'assistant n'est pas encore configuré (clé manquante)." }, 503)
  // Clé non rattachée à un workspace : l'identifiant du workspace doit accompagner chaque appel.
  const workspace = (Deno.env.get('COMPTES_ANTHROPIC_WORKSPACE_ID') ?? '').trim()
  const client = new Anthropic({ apiKey, ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}) })
  const usage: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, web_searches: 0, usd: 0 }
  const question = history[history.length - 1].content
  // Opus pour une recherche de prix (y compris « oui » juste après qu'il l'a proposée), Sonnet sinon
  const previous = history.length > 1 ? history[history.length - 2].content : ''
  const model = PRICE_QUESTION.test(question) || (/^\s*(oui|ok|d'accord|vas-y|volontiers)\b/i.test(question) && /cherche|recherche|prix|magasins?/i.test(previous)) ? MODEL_PRICES : MODEL

  // Compactage : historique long, ou dernière requête de cette conversation au-delà du plafond.
  let compacted: { resume: string; couverts: number } | null = null
  let lastCost = 0
  if (conversationId) {
    const { data } = await db.from('assistant_usage').select('cout_eur').eq('conversation_id', conversationId).order('id', { ascending: false }).limit(1)
    lastCost = Number(data?.[0]?.cout_eur ?? 0)
  }
  const size = history.reduce((a, m) => a + m.content.length, 0) + (resume?.length ?? 0)
  if (history.length > KEEP_RECENT && (size > COMPACT_CHARS || history.length > COMPACT_MESSAGES || lastCost > MAX_COST_EUR)) {
    let cut = history.length - KEEP_RECENT
    while (cut > 0 && history[cut].role !== 'user') cut--
    if (cut > 0) {
      try {
        resume = await summarize(client, resume, history.slice(0, cut), usage)
        compacted = { resume, couverts: dropped + cut }
        history = history.slice(cut)
      } catch { /* compactage impossible : on continue avec l'historique complet */ }
    }
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({ role: m.role, content: m.content }))
  // Mise en cache de l'historique : il est relu à chaque étape de la recherche.
  const lastUser = messages[messages.length - 1]
  messages[messages.length - 1] = { role: 'user', content: [{ type: 'text', text: lastUser.content as string, cache_control: { type: 'ephemeral' } }] }
  const today = new Date().toLocaleDateString('fr-BE', { timeZone: 'Europe/Brussels', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const sources = new Map<string, string>()
  const memory = await loadMemory(db)
  const { data: settingsRow } = await db.from('user_settings').select('stats_from').maybeSingle()
  const statsFrom = (settingsRow as { stats_from?: string | null } | null)?.stats_from ?? null
  const statsText = statsFrom
    ? `

Statistiques : l'utilisateur a choisi de ne compter qu'à partir du mois comptable ${statsFrom}. Les mois antérieurs viennent d'un ancien fichier Excel, moins fiable : pour les moyennes, tendances, comparaisons et conseils, ne les utilise pas, sauf s'il le demande explicitement (ils restent consultables).`
    : ''
  const memoryText = memory.length
    ? `Notes mémorisées sur l'utilisateur (à respecter) :\n${memory.map((m) => `- n°${m.id} : ${m.note}`).join('\n')}`
    : "Aucune note mémorisée pour l'instant."
  const screenText = screen?.page
    ? `\n\nÉcran que l'utilisateur regarde en ce moment : ${screen.page}${screen.mois ? `, mois affiché ${screen.mois}` : ''}. « Ce mois-ci », « ici », « cette page » s'y rapportent, sauf indication contraire.`
    : ''
  const voiceText = voice
    ? "\n\nL'utilisateur a DICTÉ sa question et ta réponse lui sera LUE à voix haute par le téléphone : réponds en 2 à 4 phrases courtes et naturelles, sans liste à puces, sans tableau, sans lien ni URL (les sources restent affichées à l'écran), sans émoji. Écris les montants simplement (12,50 €). Pour toute modification des comptes, présente d'abord le résumé de ce que tu as compris et attends sa validation : les outils refusent d'écrire sans confirme = true. Quand il valide (« oui », « c'est bon », bouton « Oui, j'enregistre »), enregistre exactement ce résumé et confirme en une phrase. La dictée peut mal transcrire un mot : si un nom ou un montant semble étrange, demande confirmation."
    : ''
  const resumeText = resume ? `\n\nRésumé du début de cette conversation (les messages correspondants ne sont plus affichés ici) :\n${resume}` : ''
  let budgetReached = false
  let modified = false
  let awaitingValidation = false
  /** Action demandée à l'application sur les conversations (ouvrir, nouvelle, supprimée…). */
  let navigation: Record<string, unknown> | null = null

  /** Journal du coût de la requête (suivi, et déclenchement du compactage la fois suivante). */
  const record = async () => {
    try {
      await db.from('assistant_usage').insert({
        conversation_id: conversationId, question: question.slice(0, 500),
        input_tokens: usage.input, output_tokens: usage.output, cache_read: usage.cache_read, cache_write: usage.cache_write,
        web_searches: usage.web_searches, cout_eur: Math.round(costEur(usage) * 10000) / 10000,
        compacte: Boolean(compacted), budget_atteint: budgetReached, modele: model,
      })
    } catch { /* suivi non bloquant */ }
  }
  const finish = async (payload: Record<string, unknown>) => {
    await record()
    return json({ ...payload, compacted, modifie: modified, a_valider: awaitingValidation, navigation, cout_eur: Math.round(costEur(usage) * 100) / 100 })
  }

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // Plafond de coût : à l'approche d'1 €, plus de recherche, il répond avec ce qu'il a.
      const lastCall = budgetReached
      const response = await client.beta.messages.create({
        model: model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: [
          { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `Aujourd'hui : ${today}. Mois comptable en cours : ${currentPeriod()}.\n\n${memoryText}${statsText}${screenText}${voiceText}${resumeText}` },
        ],
        tools: TOOLS,
        ...(lastCall ? { tool_choice: { type: 'none' as const } } : {}),
        messages,
      })
      addUsage(usage, response.usage, response.model)
      if (!budgetReached && costEur(usage) > MAX_COST_EUR * 0.8) budgetReached = true

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
        return finish({ reply: "Je ne peux pas répondre à cette demande. Pouvez-vous la formuler autrement ?", sources: [] })
      }
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content })
        if (budgetReached && !lastCall) messages.push({ role: 'user', content: BUDGET_NOTE })
        continue
      }
      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content })
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          try {
            const input = (block.input ?? {}) as Input
            if (block.name === 'lister_conversations' || block.name === 'gerer_conversation') {
              const r = await conversationTool(db, block.name, input, conversationId)
              if (r.nav) navigation = r.nav
              results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(r.out) })
              continue
            }
            // Demande dictée : rien n'est écrit avant que l'utilisateur ait validé le résumé.
            if (voice && VALIDATED_TOOLS.has(block.name) && input.confirme !== true) {
              awaitingValidation = true
              results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({
                pas_encore_enregistre: true, a_valider: input,
                consigne: "Demande dictée : rien n'est enregistré. Présente un résumé clair et court de ce que tu vas faire (quoi, combien, quand, où, quel mois comptable) et demande « Je l'enregistre ? ». L'utilisateur validera avec le bouton ou en disant oui ; rappelle alors l'outil avec les mêmes données et confirme = true.",
              }) })
              continue
            }
            const out = await runTool(db, block.name, input, history[history.length - 1].content, crypto.randomUUID())
            if (WRITE_TOOLS.has(block.name)) modified = true
            results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) })
          } catch (e) {
            results.push({ type: 'tool_result', tool_use_id: block.id, content: `Erreur : ${(e as Error).message}`, is_error: true })
          }
        }
        messages.push({ role: 'user', content: budgetReached && !lastCall ? [...results, { type: 'text', text: BUDGET_NOTE }] : results })
        continue
      }
      // end_turn, max_tokens… : réponse finale
      const reply = response.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join('').trim()
      // Résumé d'une demande dictée qui attend un « oui » : boutons de validation sous la réponse.
      if (voice && !modified && /(je l'enregistre|je l'ajoute|j'enregistre|je le note|je confirme|je corrige|je modifie)[^?]{0,40}\?/i.test(reply)) awaitingValidation = true
      return finish({
        reply: reply || "Je n'ai pas trouvé de réponse.",
        truncated: response.stop_reason === 'max_tokens',
        sources: [...sources].slice(0, 12).map(([url, title]) => ({ url, title })),
      })
    }
    return finish({ reply: "La recherche a pris trop d'étapes. Pouvez-vous préciser la question ?", sources: [] })
  } catch (e) {
    await record()
    if (e instanceof Anthropic.RateLimitError) return json({ error: "L'assistant est très sollicité, réessayez dans un instant." }, 429)
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "La clé de l'assistant n'est pas valide." }, 500)
    // Clé non rattachée à un workspace et identifiant de workspace absent
    if (e instanceof Anthropic.APIError && /workspace/i.test(String(e.message))) return json({ error: "La clé de l'assistant n'est liée à aucun espace de travail Anthropic : il faut indiquer l'identifiant du workspace (secret COMPTES_ANTHROPIC_WORKSPACE_ID) ou utiliser une clé créée dans un workspace." }, 500)
    // Crédit Anthropic épuisé : message clair plutôt qu'une « erreur 400 »
    if (e instanceof Anthropic.APIError && /credit balance/i.test(String(e.message))) return json({ error: "Le crédit de l'assistant est épuisé. Il faut le recharger (console Anthropic → Plans & Billing) ; en attendant, vous pouvez encoder à la main." }, 402)
    if (e instanceof Anthropic.APIError) { console.error('API', e.status, e.message); return json({ error: `Erreur de l'assistant (${e.status}).` }, 502) }
    return json({ error: (e as Error).message }, 500)
  }
})
