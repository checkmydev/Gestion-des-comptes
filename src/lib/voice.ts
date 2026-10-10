import { useCallback, useEffect, useRef, useState } from 'react'

/*
 * Voix : dictée (reconnaissance vocale du téléphone) et lecture à voix haute des réponses.
 * Tout passe par le navigateur (Chrome sur Android, Safari sur iPhone) : rien à installer, gratuit.
 */

interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean
  start(): void; stop(): void; abort(): void
  onresult: ((e: RecognitionEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

function recognitionClass(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const dictationSupported = () => recognitionClass() !== null

const ERRORS: Record<string, string> = {
  'not-allowed': "Le micro est bloqué. Autorisez le micro pour cette application dans les réglages du téléphone, puis réessayez.",
  'service-not-allowed': "Le micro est bloqué. Autorisez le micro pour cette application dans les réglages du téléphone, puis réessayez.",
  'no-speech': "Je n'ai rien entendu. Touchez le micro et parlez juste après.",
  'audio-capture': "Aucun micro n'a été trouvé.",
  network: 'La dictée a besoin d\'internet. Vérifiez la connexion.',
}

/**
 * Dictée : start() écoute, le texte s'affiche au fur et à mesure (interim),
 * puis onFinal reçoit la phrase complète quand l'utilisateur s'arrête de parler.
 */
export function useDictation(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const finalText = useRef('')
  const cb = useRef(onFinal)
  cb.current = onFinal

  const stop = useCallback(() => { rec.current?.stop() }, [])

  const start = useCallback(() => {
    const Cls = recognitionClass()
    if (!Cls) { setError("La dictée n'est pas disponible sur cet appareil. Utilisez le micro du clavier pour dicter."); return }
    stopSpeaking()
    unlockAudio()
    setError(null)
    setInterim('')
    finalText.current = ''
    const r = new Cls()
    r.lang = 'fr-BE'
    r.continuous = false
    r.interimResults = true
    r.onresult = (e) => {
      let live = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (res.isFinal) finalText.current += res[0].transcript
        else live += res[0].transcript
      }
      setInterim((finalText.current + live).trim())
    }
    r.onerror = (e) => { if (e.error !== 'aborted') setError(ERRORS[e.error] ?? 'La dictée a été interrompue. Réessayez.') }
    r.onend = () => {
      setListening(false)
      rec.current = null
      const text = finalText.current.trim()
      setInterim('')
      if (text) cb.current(text)
    }
    rec.current = r
    try { r.start(); setListening(true) } catch { setError('La dictée n\'a pas pu démarrer. Réessayez.') }
  }, [])

  useEffect(() => () => rec.current?.abort(), [])
  return { listening, interim, error, start, stop, clearError: () => setError(null) }
}

/** Texte d'une réponse rendu agréable à écouter : sans gras, liens, puces ni émojis. */
export function speakable(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, y: string, mo: string, d: string) => `${Number(d)} ${MONTHS_FR[Number(mo) - 1] ?? mo} ${y}`)
    .replace(/€\/kg/g, ' euros le kilo')
    .replace(/(\d),(\d{2}) €/g, '$1 euros $2')
    .replace(/ €/g, ' euros')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window

// ---------------------------------------------------------------------------
// Choix de la voix : la meilleure voix française de l'appareil, ou celle choisie
// dans Paramètres → Voix de l'assistant (mémorisée sur cet appareil).
// ---------------------------------------------------------------------------
const VOICE_KEY = 'comptes.voice'
const RATE_KEY = 'comptes.voiceRate'

/** Voix françaises de l'appareil (la liste arrive parfois un peu après le chargement). */
export function frenchVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported()) return []
  return window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith('fr'))
}

/** Prévient quand la liste des voix change (chargement asynchrone sur Chrome/Android). */
export function onVoicesChanged(cb: () => void): () => void {
  if (!speechSupported()) return () => {}
  window.speechSynthesis.addEventListener('voiceschanged', cb)
  return () => window.speechSynthesis.removeEventListener('voiceschanged', cb)
}

/** Note d'une voix : les voix « naturelles » ou en ligne sonnent bien mieux que les voix compactes. */
function score(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase()
  let s = 0
  if (/natural|neural|premium|enhanced|améliorée|amelioree|wavenet|online/.test(n)) s += 50
  if (/google/.test(n)) s += 30
  if (/amélie|amelie|audrey|aurélie|thomas|marie|denise|henri|eloise|vivienne/.test(n)) s += 15
  if (/compact|espeak|robot|novelty/.test(n)) s -= 60
  if (!v.localService) s += 5
  const lang = v.lang.toLowerCase().replace('_', '-')
  if (lang === 'fr-be') s += 8
  else if (lang === 'fr-fr') s += 6
  else if (lang === 'fr-ca' || lang === 'fr-ch') s += 2
  return s
}

export type VoiceEngine = 'enligne' | 'appareil'
export interface VoiceSettings {
  /** Voix naturelle en ligne (OpenAI) ou voix du téléphone. */
  engine: VoiceEngine
  /** Voix en ligne choisie. */
  onlineVoice: string
  /** Voix du téléphone choisie (null = la meilleure automatiquement). */
  voiceURI: string | null
  rate: number
}

const ENGINE_KEY = 'comptes.voiceEngine'
const ONLINE_VOICE_KEY = 'comptes.onlineVoice'

/** Voix en ligne proposées (OpenAI gpt-4o-mini-tts). */
export const ONLINE_VOICES: { id: string; label: string }[] = [
  { id: 'coral', label: 'Coral — femme, chaleureuse' },
  { id: 'marin', label: 'Marin — femme, douce et naturelle' },
  { id: 'sage', label: 'Sage — femme, calme' },
  { id: 'shimmer', label: 'Shimmer — femme, claire' },
  { id: 'cedar', label: 'Cedar — homme, posé et naturel' },
  { id: 'ash', label: 'Ash — homme, chaleureux' },
  { id: 'onyx', label: 'Onyx — homme, voix grave' },
  { id: 'ballad', label: 'Ballad — homme, doux' },
]

export function readVoiceSettings(): VoiceSettings {
  try {
    const rate = Number(localStorage.getItem(RATE_KEY))
    const online = localStorage.getItem(ONLINE_VOICE_KEY)
    return {
      engine: localStorage.getItem(ENGINE_KEY) === 'appareil' ? 'appareil' : 'enligne',
      onlineVoice: ONLINE_VOICES.some((v) => v.id === online) ? online! : 'coral',
      voiceURI: localStorage.getItem(VOICE_KEY),
      rate: rate >= 0.6 && rate <= 1.5 ? rate : 1,
    }
  } catch { return { engine: 'enligne', onlineVoice: 'coral', voiceURI: null, rate: 1 } }
}

export function saveVoiceSettings(v: Partial<VoiceSettings>) {
  try {
    if (v.engine !== undefined) localStorage.setItem(ENGINE_KEY, v.engine)
    if (v.onlineVoice !== undefined) localStorage.setItem(ONLINE_VOICE_KEY, v.onlineVoice)
    if (v.voiceURI !== undefined) { if (v.voiceURI) localStorage.setItem(VOICE_KEY, v.voiceURI); else localStorage.removeItem(VOICE_KEY) }
    if (v.rate !== undefined) localStorage.setItem(RATE_KEY, String(v.rate))
  } catch { /* réglage non mémorisé */ }
}

/** Voix du téléphone utilisée : celle choisie si elle existe encore, sinon la mieux notée. */
export function bestVoice(): SpeechSynthesisVoice | null {
  const voices = frenchVoices()
  const chosen = readVoiceSettings().voiceURI
  return voices.find((v) => v.voiceURI === chosen) ?? [...voices].sort((a, b) => score(b) - score(a))[0] ?? null
}

/** Découpe en phrases courtes : les longs textes sont coupés ou accélérés par certains navigateurs. */
function sentences(text: string): string[] {
  const parts = text.match(/[^.!?…;:]+[.!?…;:]*\s*/g) ?? [text]
  const out: string[] = []
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (out.length && (out[out.length - 1].length + p.length) < 160) out[out.length - 1] += ' ' + p
    else out.push(p)
  }
  return out
}

let speechRun = 0

/** Lecture avec une voix du téléphone. */
function speakDevice(text: string, run: number, onEnd: (() => void) | undefined, s: VoiceSettings) {
  if (!speechSupported()) { onEnd?.(); return }
  const synth = window.speechSynthesis
  synth.cancel()
  const voice = (s.voiceURI && frenchVoices().find((v) => v.voiceURI === s.voiceURI)) || bestVoice()
  const chunks = sentences(speakable(text))
  let i = 0
  const next = () => {
    if (run !== speechRun) return // une autre lecture a commencé, ou arrêt
    if (i >= chunks.length) { onEnd?.(); return }
    const u = new SpeechSynthesisUtterance(chunks[i++])
    u.lang = voice?.lang ?? 'fr-FR'
    if (voice) u.voice = voice
    u.rate = s.rate
    u.pitch = 1
    u.onend = next
    u.onerror = () => { if (run === speechRun) onEnd?.() }
    synth.speak(u)
  }
  next()
}

// ---------------------------------------------------------------------------
// Voix en ligne : l'audio est fabriqué par la fonction serveur « comptes-voix ».
// Un seul lecteur audio, « débloqué » au premier geste de l'utilisateur (sinon
// iPhone et Android refusent de jouer un son arrivé plus tard).
// ---------------------------------------------------------------------------
let player: HTMLAudioElement | null = null
const SILENCE = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'

/** À appeler pendant un geste (toucher le micro, 🔊) pour autoriser la lecture qui suivra. */
export function unlockAudio() {
  if (typeof Audio === 'undefined') return
  if (!player) player = new Audio()
  if (player.dataset.unlocked) return
  player.src = SILENCE
  player.play().then(() => { player!.dataset.unlocked = '1' }, () => {})
}

const audioCache = new Map<string, string>()

async function fetchOnlineAudio(text: string, s: VoiceSettings): Promise<string> {
  const pace = s.rate < 0.95 ? 'lente' : s.rate > 1.05 ? 'rapide' : 'normale'
  const key = `${s.onlineVoice}|${pace}|${text}`
  const cached = audioCache.get(key)
  if (cached) return cached
  const { supabase, supabaseUrl, supabaseAnonKey } = await import('./supabase')
  const { data } = await supabase.auth.getSession()
  const res = await fetch(`${supabaseUrl}/functions/v1/comptes-voix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey, Authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify({ text, voice: s.onlineVoice, pace }),
  })
  if (!res.ok || !(res.headers.get('Content-Type') ?? '').startsWith('audio/')) throw new Error(`voix en ligne indisponible (${res.status})`)
  const url = URL.createObjectURL(await res.blob())
  audioCache.set(key, url)
  if (audioCache.size > 30) { const first = audioCache.keys().next().value!; URL.revokeObjectURL(audioCache.get(first)!); audioCache.delete(first) }
  return url
}

/**
 * La voix en ligne n'existe que si une clé est configurée sur le serveur. Vérifié une fois :
 * la fonction répond 503 sans clé, 400 avec clé (le texte vide est refusé).
 */
let onlineAvailable: boolean | null = null
let probing: Promise<boolean> | null = null
export function checkOnlineVoice(): Promise<boolean> {
  if (onlineAvailable !== null) return Promise.resolve(onlineAvailable)
  probing ??= (async () => {
    try {
      const { supabase, supabaseUrl, supabaseAnonKey } = await import('./supabase')
      const { data } = await supabase.auth.getSession()
      const res = await fetch(`${supabaseUrl}/functions/v1/comptes-voix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey, Authorization: `Bearer ${data.session?.access_token ?? ''}` },
        body: JSON.stringify({ text: '' }),
      })
      onlineAvailable = res.status === 400
    } catch {
      probing = null // pas de réseau : on réessaiera plus tard
      return false
    }
    return onlineAvailable
  })()
  return probing
}

/** Dernière erreur de la voix en ligne (affichée dans les Paramètres). */
export let lastOnlineError: string | null = null

/**
 * Lit un texte à voix haute ; onEnd est appelé à la fin (ou à l'arrêt).
 * Voix en ligne par défaut, voix du téléphone si elle est choisie ou en cas de souci.
 */
export function speak(text: string, onEnd?: () => void, override?: Partial<VoiceSettings>) {
  const s = { ...readVoiceSettings(), ...override }
  stopSpeaking()
  const run = speechRun
  const clean = speakable(text)
  if (!clean) { onEnd?.(); return }
  if (s.engine !== 'enligne' || onlineAvailable === false || (typeof navigator !== 'undefined' && !navigator.onLine)) { speakDevice(text, run, onEnd, s); return }
  if (!player) player = new Audio()
  const p = player
  checkOnlineVoice().then((ok) => {
    if (!ok) throw new Error('voix en ligne non configurée')
    return fetchOnlineAudio(clean, s)
  }).then((url) => {
    if (run !== speechRun) return
    lastOnlineError = null
    p.onended = () => { if (run === speechRun) onEnd?.() }
    p.onerror = () => { if (run === speechRun) speakDevice(text, run, onEnd, s) }
    p.src = url
    p.playbackRate = 1
    p.play().catch(() => { if (run === speechRun) speakDevice(text, run, onEnd, s) })
  }).catch((e: Error) => {
    lastOnlineError = e.message
    if (run === speechRun) speakDevice(text, run, onEnd, s)
  })
}

export function stopSpeaking() {
  speechRun++
  if (player && !player.paused) player.pause()
  if (speechSupported()) window.speechSynthesis.cancel()
}
