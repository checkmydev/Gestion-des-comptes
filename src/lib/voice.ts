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
    .replace(/€\/kg/g, ' euros le kilo')
    .replace(/(\d),(\d{2}) €/g, '$1 euros $2')
    .replace(/ €/g, ' euros')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window

function frenchVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  return voices.find((v) => v.lang === 'fr-BE') ?? voices.find((v) => v.lang === 'fr-FR') ?? voices.find((v) => v.lang.startsWith('fr')) ?? null
}

/** Lit un texte à voix haute ; onEnd est appelé à la fin (ou à l'arrêt). */
export function speak(text: string, onEnd?: () => void) {
  if (!speechSupported()) { onEnd?.(); return }
  const synth = window.speechSynthesis
  synth.cancel()
  const u = new SpeechSynthesisUtterance(speakable(text))
  u.lang = 'fr-BE'
  const v = frenchVoice()
  if (v) u.voice = v
  u.rate = 0.95
  u.onend = () => onEnd?.()
  u.onerror = () => onEnd?.()
  synth.speak(u)
}

export function stopSpeaking() {
  if (speechSupported()) window.speechSynthesis.cancel()
}
