// Publie une page privée (point sur les dépenses…) dans l'application.
// Elle sera visible à l'adresse  …/Gestion-des-comptes/#/doc/<slug>,
// uniquement après connexion avec le compte de Papa. Aucun bouton n'y mène.
//
//   node scripts/publish-doc.mjs <slug> "<titre>" <fichier.html>
//   ex. node scripts/publish-doc.mjs point-octobre-2026 "Point dépenses — octobre 2026" "Documents/Point dépenses octobre 2026.html"
//
// Connexion : .env.local (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_EMAIL, SUPABASE_PASSWORD).
// Le fichier HTML reste hors du dépôt public (dossier Documents/).
import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'

for (const f of ['.env.local', '.env']) if (existsSync(f)) process.loadEnvFile(f)
const { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key, SUPABASE_EMAIL: email, SUPABASE_PASSWORD: password } = process.env
const [slug, title, file] = process.argv.slice(2)
if (!slug || !title || !file) { console.error('Usage : node scripts/publish-doc.mjs <slug> "<titre>" <fichier.html>'); process.exit(1) }
if (!/^[a-z0-9-]+$/.test(slug)) { console.error('Le slug ne peut contenir que a-z, 0-9 et des tirets.'); process.exit(1) }
if (!url || !key || !email || !password) { console.error('Identifiants manquants dans .env.local'); process.exit(1) }

const sb = createClient(url, key, { auth: { persistSession: false }, db: { schema: 'comptes' } })
const { error: authError } = await sb.auth.signInWithPassword({ email, password })
if (authError) { console.error('Connexion impossible :', authError.message); process.exit(1) }

const html = readFileSync(file, 'utf8')
const { error } = await sb.from('documents')
  .upsert({ slug, title, html, updated_at: new Date().toISOString() }, { onConflict: 'user_id,slug' })
if (error) { console.error(error.message); process.exit(1) }
console.log(`✓ Publié : https://checkmydev.github.io/Gestion-des-comptes/#/doc/${slug}`)
