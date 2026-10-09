import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useApp } from '../lib/app'
import { MONTHS } from '../lib/format'
import { addMonths, makePeriod, parsePeriod } from '../lib/period'

export function MonthPicker() {
  const { period, setPeriod } = useApp()
  const { year, month } = parsePeriod(period)
  const thisYear = new Date().getFullYear()
  const years = Array.from({ length: 6 }, (_, i) => thisYear - 4 + i)
  if (!years.includes(year)) years.push(year)
  return (
    <div className="monthpicker">
      <button onClick={() => setPeriod(addMonths(period, -1))} aria-label="Mois précédent">‹</button>
      <select aria-label="Mois" value={month} onChange={(e) => setPeriod(makePeriod(year, Number(e.target.value)))}>
        {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
      </select>
      <select aria-label="Année" value={year} onChange={(e) => setPeriod(makePeriod(Number(e.target.value), month))}>
        {years.sort().map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
      <button onClick={() => setPeriod(addMonths(period, 1))} aria-label="Mois suivant">›</button>
    </div>
  )
}

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)

const NAV = [
  { to: '/', label: 'Accueil', d: 'M3 11l9-8 9 8M5 10v10h14V10' },
  { to: '/saisie', label: 'Saisie', d: 'M12 5v14M5 12h14' },
  { to: '/courses', label: 'Courses', d: 'M3 4h2l2.4 11h11.2L21 7H6.2M9 20h.01M18 20h.01' },
  { to: '/detail', label: 'Détail', d: 'M4 6h16M4 12h16M4 18h10' },
  { to: '/global', label: 'Global', d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  { to: '/stats', label: 'Analyses', d: 'M3 17l6-6 4 4 8-8M15 7h6v6' },
]

export function Layout() {
  const { error } = useApp()
  const { pathname } = useLocation()
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/parametres" className="settings-link" aria-label="Paramètres">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </NavLink>
        <MonthPicker />
        <a href="./notice.html" className="settings-link" aria-label="Notice d'utilisation" title="Notice d'utilisation">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
          </svg>
        </a>
      </header>
      <main className="main">
        {error && <p className="alert over">Erreur de connexion à la base : {error}</p>}
        <Outlet />
      </main>
      {pathname !== '/assistant' && !pathname.startsWith('/doc/') && (
        <NavLink to="/assistant" className="fab" aria-label="Poser une question à l'assistant" title="Assistant">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <path d="M8 9h8M8 13h5" />
          </svg>
        </NavLink>
      )}
      <nav className="bottomnav">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive || (n.to === '/courses' && pathname === '/prix') || (n.to === '/saisie' && pathname === '/ticket') ? 'active' : '')}>
            {icon(n.d)}
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

export function Loading() {
  return <p className="muted">Chargement…</p>
}
