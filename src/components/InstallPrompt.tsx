import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// L'événement peut arriver avant que React n'affiche le bandeau : on le garde ici.
let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    listeners.forEach((l) => l())
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    listeners.forEach((l) => l())
  })
}

const DISMISS_KEY = 'comptes.install.dismissed'
const DISMISS_DAYS = 7

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function isIos(): boolean {
  const ua = navigator.userAgent
  return /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

function recentlyDismissed(): boolean {
  try {
    const t = Number(localStorage.getItem(DISMISS_KEY))
    return Boolean(t) && Date.now() - t < DISMISS_DAYS * 864e5
  } catch {
    return false
  }
}

/**
 * Bandeau « Installer l'application » :
 *  - Android / Chrome / Edge : bouton qui ouvre la fenêtre d'installation native ;
 *  - iPhone / iPad (Safari) : explication, car Safari n'a pas de bouton automatique.
 */
export function InstallPrompt() {
  const [, force] = useState(0)
  const [hidden, setHidden] = useState(() => isStandalone() || recentlyDismissed())
  const [showIosHelp, setShowIosHelp] = useState(false)

  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])

  if (hidden || isStandalone()) return null
  const ios = isIos()
  if (!deferred && !ios) return null

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* ignoré */ }
    setHidden(true)
  }

  async function install() {
    if (ios) { setShowIosHelp(true); return }
    if (!deferred) return
    await deferred.prompt()
    const { outcome } = await deferred.userChoice
    deferred = null
    if (outcome === 'accepted') setHidden(true)
    else force((n) => n + 1)
  }

  return (
    <div className="card install" role="region" aria-label="Installer l'application">
      <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <img src="./icon-192.png" alt="" width={44} height={44} style={{ borderRadius: 10 }} />
        <div className="grow">
          <strong>Installer « Comptes » sur ce téléphone</strong>
          <div className="small ink2">Elle s'ouvrira comme une vraie application, depuis l'écran d'accueil, pour encoder les achats directement au magasin.</div>
        </div>
      </div>
      {showIosHelp ? (
        <ol className="small" style={{ margin: '12px 0 0', paddingLeft: 20 }}>
          <li>Touchez le bouton <strong>Partager</strong> <span aria-hidden="true">(carré avec une flèche ↑)</span> en bas de Safari.</li>
          <li>Choisissez <strong>« Sur l'écran d'accueil »</strong>.</li>
          <li>Touchez <strong>Ajouter</strong>.</li>
        </ol>
      ) : null}
      <div className="row" style={{ marginTop: 12 }}>
        {!showIosHelp && <button className="btn-primary" onClick={install}>Installer l'application</button>}
        <button className="btn-ghost" onClick={dismiss}>Plus tard</button>
      </div>
    </div>
  )
}
