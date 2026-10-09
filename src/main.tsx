import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { captureInstallPrompt } from './components/InstallPrompt'
import './styles.css'

captureInstallPrompt()

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
