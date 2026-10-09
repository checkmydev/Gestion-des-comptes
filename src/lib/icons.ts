/**
 * Petite icône (émoji) pour chaque produit, choisie d'après son nom.
 * L'ordre compte : les expressions les plus précises d'abord (« tomates pelées »
 * avant « tomate », « pomme de terre » avant « pomme »).
 * Une icône choisie à la main dans les Paramètres (items.icon) l'emporte toujours.
 */
const RULES: [RegExp, string][] = [
  // Expressions composées
  [/lait d.?amande|lait amande|lait de soja|lait d.?avoine/, '🥛'],
  [/couque|boule de berlin|beignet|donut|viennoiserie/, '🍩'],
  [/doppler|dopler|radio|scanner|\birm\b|echographie/, '🩺'],
  [/\bpkg\b|q-park|qpark/, '🅿️'],
  [/tomates? pelees|conserve|bocal|bocaux/, '🥫'],
  [/pomme(s)? de terre|\bpdt\b|patate|puree/, '🥔'],
  [/frite/, '🍟'],
  [/fromage rape|mozza rape|emmental rape/, '🧀'],
  [/papier toilette|\bpq\b|essuie|mouchoir/, '🧻'],
  [/creme fraiche|creme epaisse|creme\b/, '🥛'],
  [/petits? suisses?|yaou?rt|skyr|fromage blanc/, '🥣'],
  [/vache qui rit/, '🧀'],
  [/fishstick|poisson|saumon|cabillaud|sebaste|raie|thon|truite|maquereau|colin|scampi/, '🐟'],
  [/crevette/, '🦐'],
  // Fruits
  [/banane/, '🍌'], [/pomme|jona|golden|pink lady|granny/, '🍎'], [/\bpoires?\b/, '🍐'],
  [/peche|nectarine|abricot|prune|mirabelle/, '🍑'], [/cerise/, '🍒'], [/fraise/, '🍓'],
  [/framboise|myrtille|mure/, '🫐'], [/raisin/, '🍇'], [/orange|clementine|mandarine/, '🍊'],
  [/citron/, '🍋'], [/melon/, '🍈'], [/pasteque/, '🍉'], [/ananas/, '🍍'], [/kiwi/, '🥝'],
  [/mangue/, '🥭'], [/avocat/, '🥑'], [/noix|noisette|amande|cerneau|cacahuete/, '🌰'], [/compote/, '🍏'],
  // Légumes
  [/tomate/, '🍅'], [/carotte/, '🥕'], [/oignon|echalote/, '🧅'], [/\bail\b/, '🧄'],
  [/brocoli|chou-fleur/, '🥦'], [/concombre|courgette|cornichon/, '🥒'], [/poivron/, '🫑'],
  [/piment/, '🌶️'], [/champignon/, '🍄'], [/\bmais\b/, '🌽'], [/aubergine/, '🍆'],
  [/haricot|petits? pois|pois casse/, '🫛'],
  [/salade|laitue|roquette|mache|chicon|endive|epinard|poireau|\bchou\b|celeri|fenouil|asperge|panais|navet|betterave|legume/, '🥬'],
  [/persil|basilic|thym|ciboulette|coriandre|herbe/, '🌿'],
  // Produits laitiers, œufs
  [/oeuf/, '🥚'], [/beurre|becel|margarine/, '🧈'],
  [/fromage|edam|brie|camembert|emmental|roquefort|mozza|gouda|comte|parmesan|raclette|\bbleu\b|rocamadour|feta|chevre/, '🧀'],
  [/lait|cecemel/, '🥛'],
  // Pain, pâtisserie
  [/baguette/, '🥖'], [/croissant/, '🥐'], [/gaufre/, '🧇'], [/biscuit|boudoir|speculoos|cookie/, '🍪'],
  [/cake|gateau|tarte|flan|patisserie|eclair/, '🍰'], [/pain|crouton/, '🍞'],
  // Viandes
  [/poulet|dinde|volaille|nugget/, '🍗'], [/jambon|lard|bacon|serrano/, '🥓'],
  [/saucisse|saucisson|chipo|boulette|merguez/, '🌭'],
  [/steak|boeuf|hache|rumsteak|carpaccio|roti|viande|porc|veau|\bpele\b|\busa\b|burger/, '🥩'],
  // Épicerie
  [/pates|spaghetti|fusil|tagliatelle|lasagne|macaroni|penne/, '🍝'], [/\briz\b|bami|nasi/, '🍚'],
  [/farine/, '🌾'], [/sucre|\bsel\b|epice|poivre/, '🧂'], [/huile|vinaigre|olive/, '🫒'],
  [/sauce|mayo|ketchup|bearnaise|moutarde|pesto/, '🥫'], [/soupe|bouillon|potage/, '🍲'],
  [/chips|crackers|apero/, '🥨'], [/confiture|miel|choco|nutella|pate a tartiner/, '🍯'],
  [/chocolat|bonbon/, '🍫'], [/glace|creme glacee/, '🍦'], [/pizza/, '🍕'], [/surgele/, '❄️'],
  [/cereale|muesli|flocon/, '🥣'],
  // Boissons
  [/cafe|lavazza|nespresso|dolce gusto/, '☕'], [/\bthe\b|tisane|earl/, '🍵'],
  [/biere|pils|jupiler|leffe|duvel/, '🍺'], [/vin\b|proseco|prosecco|champagne|cava/, '🍷'],
  [/jus|aquarius|soda|coca|limonade|sirop/, '🧃'], [/eau/, '💧'],
  // Maison, divers
  [/savon|gel douche|shampo|dentifrice|deodorant/, '🧼'],
  [/vaisselle|tablette|eponge|mr propre|nettoy|lessive|javel|detergent/, '🧽'],
  [/pile/, '🔋'], [/ampoule/, '💡'], [/\bsac\b/, '🛍️'], [/consigne|vidange/, '♻️'],
  [/encre|imprim|cartouche/, '🖨️'], [/manteau|vetement|pull|chaussure|chaussette/, '🧥'],
  [/plante|fleur|\bpot\b|terreau|graine/, '🪴'], [/cadeau/, '🎁'], [/velo/, '🚲'],
  [/plaque|voiture|auto\b|carwash/, '🚗'], [/parking/, '🅿️'],
  [/friskies|chat|croquette|litiere|collier/, '🐱'],
  [/casserole|poele|ustensile|vaisselle/, '🍳'], [/cadre/, '🖼️'],
  // Santé
  [/consultation|medecin|docteur|toubib|echo|operatoire|hopital|dentiste|kine|labo|prise de sang/, '🩺'],
  [/bandage|pansement|soin/, '🩹'],
  [/medoc|medicament|tamsulosine|metarelax|nurofen|dafalgan|paracetamol|ibuprofene|goutte|pharma|sirop|verrue|vitamine|suvezen/, '💊'],
  // Restos, sorties
  [/sandwich|panini|wrap/, '🥪'],
  [/resto|restaurant|diner|souper|lunch|chinois|brasserie|traiteur|snack|friterie|cinema|sortie/, '🍽️'],
]

const BY_CATEGORY: [RegExp, string][] = [
  [/legume/, '🥗'], [/cafe/, '☕'], [/lait/, '🥛'], [/poulet|poisson/, '🍗'], [/pain/, '🍞'],
  [/viande|jambon/, '🥩'], [/oeuf/, '🥚'], [/medoc|toubib|sante/, '💊'], [/resto|sortie/, '🍽️'],
  [/frais extra|extra/, '✨'], [/divers/, '🛒'],
]

const norm = (s: string) => s.replace(/œ/gi, 'oe').replace(/æ/gi, 'ae')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function productIcon(name: string, categoryName?: string, chosen?: string | null): string {
  if (chosen && chosen.trim()) return chosen.trim()
  const n = norm(name)
  for (const [re, icon] of RULES) if (re.test(n)) return icon
  const c = norm(categoryName ?? '')
  for (const [re, icon] of BY_CATEGORY) if (re.test(c)) return icon
  return '🛒'
}

/** Icône d'une catégorie (titres de blocs, tuiles de la saisie). */
export function categoryIcon(categoryName: string): string {
  const c = norm(categoryName)
  for (const [re, icon] of BY_CATEGORY) if (re.test(c)) return icon
  return '🛒'
}
