import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Loading } from '../components/Layout'
import { must } from '../lib/api'
import { supabase } from '../lib/supabase'

interface Doc { title: string; html: string; updated_at: string }

// Ajouté dans la page affichée : elle signale sa hauteur pour éviter une double barre de défilement.
const HEIGHT_REPORTER = `<script>(function(){function h(){parent.postMessage({docHeight:document.documentElement.scrollHeight},'*')}
addEventListener('load',h);if(window.ResizeObserver)new ResizeObserver(h).observe(document.documentElement);h()})()</script>`

/**
 * Page privée (point sur les dépenses…) stockée dans Supabase et affichée à
 * l'adresse #/doc/<slug>. Pas de lien dans l'application : on y accède par l'URL.
 * Le contenu est isolé dans un cadre « sandbox » (scripts autorisés, sans
 * accès à la session de l'application).
 */
export default function Document() {
  const { slug } = useParams()
  const [doc, setDoc] = useState<Doc | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState(800)

  useEffect(() => {
    setDoc(undefined)
    supabase.from('documents').select('title, html, updated_at').eq('slug', slug ?? '').maybeSingle()
      .then((res) => setDoc(must(res) as Doc | null))
      .then(undefined, (e: Error) => setError(e.message))
  }, [slug])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const h = (e.data as { docHeight?: number } | null)?.docHeight
      if (typeof h === 'number' && h > 0) setHeight(Math.ceil(h) + 4)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const srcDoc = useMemo(() => {
    if (!doc) return ''
    return doc.html.includes('</body>') ? doc.html.replace('</body>', `${HEIGHT_REPORTER}</body>`) : doc.html + HEIGHT_REPORTER
  }, [doc])

  useEffect(() => { if (doc) document.title = doc.title; return () => { document.title = 'Comptes' } }, [doc])

  if (error) return <p className="error">{error}</p>
  if (doc === undefined) return <Loading />
  if (doc === null) return <p className="alert info">Cette page n'existe pas (ou plus).</p>

  return (
    <iframe
      title={doc.title}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      style={{ width: 'calc(100% + 32px)', margin: '-16px -16px 0', height, border: 0, display: 'block', background: 'transparent' }}
    />
  )
}
