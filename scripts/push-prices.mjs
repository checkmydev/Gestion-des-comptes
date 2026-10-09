// Envoie dans l'application des prix relevés (recherche de prix faite sur le PC).
//
//   node scripts/push-prices.mjs --list                  liste les articles suivis + dernier prix payé
//   node scripts/push-prices.mjs prix.json [--dry]       envoie les prix du fichier (--dry : simulation)
//   node scripts/push-prices.mjs prix.json --create      crée les articles inconnus (catégorie obligatoire)
//
// Format de prix.json :
// [
//   { "article": "Bananes", "categorie": "Légumes", "enseigne": "Lidl", "prix": 1.29, "unite": "kg",
//     "promo": false, "date": "2026-10-09", "libelle": "Bananes Chiquita 1 kg", "source": "https://..." }
// ]
// unite : "kg", "piece" ou "l" (défaut : "piece"). date : défaut = aujourd'hui.
//
// Connexion : variables de .env.local
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_EMAIL, SUPABASE_PASSWORD
// (le compte de l'utilisateur : les règles de sécurité RLS restent actives).
import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'

for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f)
const { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key, SUPABASE_EMAIL: email, SUPABASE_PASSWORD: password } = process.env
if (!url || !key || !email || !password) {
  console.error('Il manque VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_EMAIL ou SUPABASE_PASSWORD dans .env.local')
  process.exit(1)
}

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const create = args.includes('--create')
const file = args.find((a) => !a.startsWith('--'))

const sb = createClient(url, key, { auth: { persistSession: false }, db: { schema: 'comptes' } })
const { error: authError } = await sb.auth.signInWithPassword({ email, password })
if (authError) { console.error('Connexion impossible :', authError.message); process.exit(1) }

const must = ({ data, error }) => { if (error) throw new Error(error.message); return data }
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

const categories = must(await sb.from('categories').select('id, name, track_inflation'))
const items = must(await sb.from('items').select('id, name, category_id'))
const catName = (id) => categories.find((c) => c.id === id)?.name ?? '?'

if (args.includes('--list')) {
  // Articles des catégories suivies, avec le dernier prix payé : la liste de travail pour la recherche.
  const tracked = new Set(categories.filter((c) => c.track_inflation).map((c) => c.id))
  const ids = items.filter((i) => tracked.has(i.category_id)).map((i) => i.id)
  const last = new Map()
  for (let i = 0; i < ids.length; i += 150) {
    const rows = must(await sb.from('purchases').select('item_id, amount, units, price_per_kg, purchased_on, stores(name)')
      .in('item_id', ids.slice(i, i + 150)).order('purchased_on', { ascending: true }))
    for (const r of rows) last.set(r.item_id, r)
  }
  const out = items.filter((i) => tracked.has(i.category_id)).map((i) => {
    const p = last.get(i.id)
    return {
      categorie: catName(i.category_id), article: i.name,
      dernier_prix: p ? (p.price_per_kg != null ? `${p.price_per_kg} €/kg` : `${Math.round((p.amount / (p.units || 1)) * 100) / 100} € pièce`) : '',
      magasin: p?.stores?.name ?? '', date: p?.purchased_on ?? '',
    }
  })
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

if (!file) { console.error('Indiquez le fichier JSON des prix (ou --list).'); process.exit(1) }
const entries = JSON.parse(readFileSync(file, 'utf8'))
const today = new Date().toISOString().slice(0, 10)

const rows = []
const unknown = []
for (const e of entries) {
  const cat = e.categorie ? categories.find((c) => norm(c.name) === norm(e.categorie)) : null
  let item = items.find((i) => norm(i.name) === norm(e.article) && (!cat || i.category_id === cat.id))
  if (!item && create && cat && !dry) {
    item = must(await sb.from('items').insert({ category_id: cat.id, name: String(e.article).trim() }).select().single())
    items.push(item)
    console.log(`+ article créé : ${cat.name} / ${item.name}`)
  }
  if (!item) { unknown.push(e); continue }
  const unit = ['kg', 'piece', 'l'].includes(e.unite) ? e.unite : 'piece'
  if (typeof e.prix !== 'number' || !e.enseigne) { console.warn('Ligne ignorée (prix ou enseigne manquant) :', e); continue }
  rows.push({
    item_id: item.id, store_name: String(e.enseigne).trim(), price: e.prix, unit,
    label: e.libelle ?? null, is_promo: Boolean(e.promo), observed_on: e.date ?? today, source: e.source ?? null,
  })
}

console.table(rows.map((r) => ({ article: items.find((i) => i.id === r.item_id).name, enseigne: r.store_name, prix: r.price, unite: r.unit, promo: r.is_promo, date: r.observed_on })))
if (unknown.length) {
  console.warn(`\n${unknown.length} article(s) introuvable(s) — vérifiez le nom ou relancez avec --create (et une catégorie) :`)
  for (const u of unknown) console.warn(`  - ${u.categorie ?? '?'} / ${u.article}`)
}
if (dry) { console.log(`\nSimulation : ${rows.length} prix seraient envoyés.`); process.exit(0) }
if (rows.length) must(await sb.from('price_references').insert(rows))
console.log(`\n✓ ${rows.length} prix envoyés dans l'application.`)
