import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { PurchaseForm } from '../components/PurchaseForm'
import { useApp } from '../lib/app'
import { eur } from '../lib/format'
import { periodLabel } from '../lib/period'
import type { Category, Item, Purchase } from '../lib/types'

type Step = 'category' | 'item' | 'details' | 'again' | 'consult'

const STEP_INDEX: Record<Step, number> = { category: 1, item: 2, details: 3, again: 4, consult: 4 }

/**
 * Saisie d'un achat, étape par étape comme décrit dans la demande :
 * mois → catégorie → article → infos → « un autre article ? » → consulter.
 */
export default function Saisie() {
  const { period, categories, items, ensureItem } = useApp()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const active = categories.filter((c) => !c.archived)

  const preset = active.find((c) => c.id === Number(params.get('cat')))
  const [step, setStep] = useState<Step>(preset ? 'item' : 'category')
  const [category, setCategory] = useState<Category | null>(preset ?? null)
  const [item, setItem] = useState<Item | null>(null)
  const [search, setSearch] = useState('')
  const [lastSaved, setLastSaved] = useState<Purchase | null>(null)
  // Magasin et date sont gardés d'un article à l'autre (un ticket de caisse = un magasin).
  const [sticky, setSticky] = useState<{ storeId: number | null; date?: string }>({ storeId: null })
  const [error, setError] = useState<string | null>(null)

  const categoryItems = useMemo(() => {
    if (!category) return []
    const q = search.trim().toLocaleLowerCase('fr')
    return items
      .filter((i) => i.category_id === category.id)
      .filter((i) => !q || i.name.toLocaleLowerCase('fr').includes(q))
  }, [items, category, search])

  const exact = categoryItems.some((i) => i.name.toLocaleLowerCase('fr') === search.trim().toLocaleLowerCase('fr'))

  function chooseCategory(c: Category) {
    setCategory(c)
    setSearch('')
    setStep('item')
  }

  async function createItem() {
    if (!category || !search.trim()) return
    try {
      setItem(await ensureItem(category.id, search))
      setStep('details')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!active.length) {
    return (
      <div className="card stack">
        <h1>Saisie</h1>
        <p>Aucune catégorie n'existe encore. Créez-en dans les <a href="#/parametres">paramètres</a>.</p>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="steps" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => <span key={n} className={n <= STEP_INDEX[step] ? 'done' : ''} />)}
      </div>

      <div className="small ink2">
        Mois comptable : <strong className="capitalize">{periodLabel(period)}</strong>
        <span className="muted"> (à changer en haut de l'écran)</span>
      </div>

      {step === 'category' && (
        <section className="stack">
          <h1>Quelle catégorie ?</h1>
          <div className="tiles">
            {active.map((c) => (
              <button key={c.id} className="tile" onClick={() => chooseCategory(c)}>
                {c.name}
                <span className="sub">{items.filter((i) => i.category_id === c.id).length} articles</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 'item' && category && (
        <section className="stack">
          <div className="spread">
            <h1>{category.name} : quel article ?</h1>
            <button className="btn-ghost" onClick={() => setStep('category')}>Changer</button>
          </div>
          <input
            autoFocus
            placeholder="Rechercher ou taper un nouvel article…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              if (categoryItems.length === 1 && search.trim()) { setItem(categoryItems[0]); setStep('details') }
              else if (!exact && search.trim()) void createItem()
            }}
          />
          {search.trim() && !exact && (
            <button className="btn-primary" onClick={createItem}>+ Ajouter « {search.trim()} » dans {category.name}</button>
          )}
          {error && <p className="error">{error}</p>}
          <div className="list">
            {categoryItems.map((i) => (
              <button key={i.id} onClick={() => { setItem(i); setStep('details') }}>
                {i.name} <span className="muted">›</span>
              </button>
            ))}
            {!categoryItems.length && !search && <p className="muted" style={{ padding: 12 }}>Aucun article : tapez un nom ci-dessus pour le créer.</p>}
          </div>
        </section>
      )}

      {step === 'details' && category && item && (
        <section className="stack">
          <div className="spread">
            <div>
              <div className="muted small">{category.name}</div>
              <h1>{item.name}</h1>
            </div>
            <button className="btn-ghost" onClick={() => setStep('item')}>Changer</button>
          </div>
          <PurchaseForm
            key={item.id}
            category={category}
            item={item}
            period={period}
            defaultStoreId={sticky.storeId}
            defaultDate={sticky.date}
            onSaved={(p) => {
              setLastSaved(p)
              setSticky({ storeId: p.store_id, date: p.purchased_on ?? undefined })
              setStep('again')
            }}
          />
        </section>
      )}

      {step === 'again' && (
        <section className="card stack">
          <p className="strong">✓ Enregistré{lastSaved && item ? ` : ${item.name}, ${eur(lastSaved.amount)}` : ''}</p>
          <h1>Voulez-vous enregistrer un autre article ?</h1>
          <button className="btn-primary btn-big" onClick={() => { setItem(null); setSearch(''); setStep('item') }}>
            Oui, dans {category?.name}
          </button>
          <button className="btn-big" onClick={() => { setItem(null); setStep('category') }}>Oui, autre catégorie</button>
          <button className="btn-big" onClick={() => setStep('consult')}>Non</button>
        </section>
      )}

      {step === 'consult' && (
        <section className="card stack">
          <h1>Que voulez-vous consulter ?</h1>
          <button className="btn-big" onClick={() => navigate('/detail')}>Détail du mois</button>
          <button className="btn-big" onClick={() => navigate('/global')}>Global du mois (essence, trajets…)</button>
          <button className="btn-big" onClick={() => navigate('/inflation')}>Inflation des prix</button>
          <button className="btn-big" onClick={() => navigate('/stats')}>Statistiques et tendances</button>
          <button className="btn-big" onClick={() => navigate('/courses')}>Liste de courses</button>
          <button className="btn-ghost" onClick={() => setStep('category')}>Nouvelle saisie</button>
        </section>
      )}
    </div>
  )
}
