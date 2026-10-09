import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { captureInstallPrompt } from './components/InstallPrompt'
import { applyTextSize, readTextSize } from './lib/textsize'
import './styles.css'

captureInstallPrompt()
applyTextSize(readTextSize())

// Service worker (nécessaire pour l'installation et l'ouverture hors connexion).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* non bloquant */ })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
