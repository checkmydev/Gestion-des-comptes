import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { InstallPrompt } from './components/InstallPrompt'
import { Layout } from './components/Layout'
import { frenchError } from './lib/api'
import { AppProvider } from './lib/app'
import { isConfigured, supabase } from './lib/supabase'
import Accueil from './pages/Accueil'
import Article from './pages/Article'
import Courses from './pages/Courses'
import Detail from './pages/Detail'
import Document from './pages/Document'
import Global from './pages/Global'
import Inflation from './pages/Inflation'
import MeilleursPrix from './pages/MeilleursPrix'
import Parametres from './pages/Parametres'
import Saisie from './pages/Saisie'
import Stats from './pages/Stats'

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setError(error.message === 'Invalid login credentials' ? 'Adresse e-mail ou mot de passe incorrect.' : frenchError(error.message))
    setBusy(false)
  }

  return (
    <div className="center-page" style={{ flexDirection: 'column', gap: 16 }}>
      <InstallPrompt />
      <form className="card stack" onSubmit={submit}>
        <h1>Comptes privés</h1>
        <label className="field">
          Adresse e-mail
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          Mot de passe
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn-primary btn-big" disabled={busy}>Se connecter</button>
        <a href="./notice.html" className="small" style={{ textAlign: 'center' }}>Comment utiliser l'application ?</a>
      </form>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (!isConfigured) {
    return (
      <div className="center-page">
        <div className="card stack">
          <h1>Configuration manquante</h1>
          <p>Les variables <code>VITE_SUPABASE_URL</code> et <code>VITE_SUPABASE_ANON_KEY</code> ne sont pas définies. Voir le README.</p>
        </div>
      </div>
    )
  }
  if (session === undefined) return <div className="center-page muted">Chargement…</div>
  if (!session) return <Login />

  return (
    <AppProvider key={session.user.id}>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Accueil />} />
            <Route path="saisie" element={<Saisie />} />
            <Route path="courses" element={<Courses />} />
            <Route path="prix" element={<MeilleursPrix />} />
            <Route path="detail" element={<Detail />} />
            <Route path="global" element={<Global />} />
            <Route path="stats" element={<Stats />} />
            <Route path="inflation" element={<Inflation />} />
            <Route path="article/:id" element={<Article />} />
            <Route path="parametres" element={<Parametres />} />
            <Route path="doc/:slug" element={<Document />} />
            <Route path="*" element={<Accueil />} />
          </Route>
        </Routes>
      </HashRouter>
    </AppProvider>
  )
}
