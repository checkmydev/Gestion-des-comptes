// Voix de l'assistant (Supabase Edge Function).
//
// Reçoit le texte d'une réponse et renvoie l'audio (MP3) lu par une voix de synthèse
// naturelle d'OpenAI (gpt-4o-mini-tts), avec une consigne de ton chaleureuse et posée.
// Rien n'est conservé : ni le texte, ni l'audio.
//
// Mêmes protections que l'assistant : clé dans le secret COMPTES_OPENAI_API_KEY (propre
// à cette application), accès limité aux comptes de ALLOWED_EMAILS. Le coût de chaque
// lecture est noté dans comptes.assistant_usage.
import { createClient } from 'npm:@supabase/supabase-js@2.117.3'

const MODEL = 'gpt-4o-mini-tts'
const MAX_CHARS = 2500
/** Voix proposées dans les Paramètres (les autres sont refusées). */
const VOICES = new Set(['marin', 'cedar', 'coral', 'sage', 'nova', 'shimmer', 'ash', 'onyx', 'ballad', 'verse'])
const DEFAULT_VOICE = 'coral'
// Coût approximatif : ≈ 0,015 $ par minute d'audio, ≈ 900 caractères par minute
const USD_PER_CHAR = 0.015 / 900
const USD_EUR = 0.92

const PACE: Record<string, string> = {
  lente: 'Parle lentement, en articulant bien, avec de petites pauses entre les phrases.',
  normale: 'Parle à un rythme tranquille, sans te presser.',
  rapide: 'Parle à un rythme naturel et fluide.',
}

const instructions = (pace: string) => `Tu lis à voix haute la réponse de l'assistant d'une application de comptes, à un retraité belge francophone.
Voix : chaleureuse, calme, bienveillante, comme un proche attentionné qui explique simplement. Jamais robotique ni commerciale.
Langue : français, accent neutre ou belge, prononciation claire. Les montants se disent naturellement (« douze euros cinquante »).
Intonation : naturelle et vivante, souriante quand c'est une bonne nouvelle, posée pour les chiffres importants.
${PACE[pace] ?? PACE.normale}`

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

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
  if (!email || !allowed.includes(email)) return json({ error: "Ce compte n'a pas accès à la voix de l'assistant." }, 403)

  const apiKey = (Deno.env.get('COMPTES_OPENAI_API_KEY') ?? '').trim()
  if (!apiKey) return json({ error: 'Voix en ligne non configurée.' }, 503)

  let text = ''
  let voice = DEFAULT_VOICE
  let pace = 'normale'
  try {
    const body = await req.json()
    text = String(body.text ?? '').trim().slice(0, MAX_CHARS)
    if (VOICES.has(body.voice)) voice = body.voice
    if (typeof body.pace === 'string' && PACE[body.pace]) pace = body.pace
  } catch { /* corps invalide */ }
  if (!text) return json({ error: 'Texte manquant.' }, 400)

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, voice, input: text, instructions: instructions(pace), response_format: 'mp3' }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('OpenAI', res.status, detail.slice(0, 300))
    return json({ error: res.status === 401 ? 'Clé de la voix en ligne invalide.' : res.status === 429 ? 'Voix en ligne très sollicitée ou crédit épuisé.' : `Erreur de la voix en ligne (${res.status}).` }, 502)
  }

  // Suivi du coût (non bloquant)
  db.from('assistant_usage').insert({
    question: `[voix ${voice}] ${text.slice(0, 120)}`,
    cout_eur: Math.round(text.length * USD_PER_CHAR * USD_EUR * 10000) / 10000,
  }).then(() => {}, () => {})

  return new Response(res.body, { headers: { ...CORS, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } })
})
