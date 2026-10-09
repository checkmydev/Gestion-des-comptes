import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Loading } from '../components/Layout'
import { loadPurchasesForItems, loadReferencesSince } from '../lib/api'
import { useApp } from '../lib/app'
import { compareProducts, storeRanking } from '../lib/bestprices'
import { eur, longDate, pct } from '../lib/format'
import { UNIT_LABEL } from '../lib/prices'
import type { PriceReference, Purchase } from '../lib/types'
import { ProductIcon } from '../components/ProductIcon'

/** Onglets communs aux pages « Liste de courses » et « Meilleurs prix ». */
export function CoursesTabs() {
  return (
    <div className="tabs" role="tablist">
      <NavLink to="/courses" className={({ isActive }) => `btn ${isActive ? 'active' : ''}`}>Liste de courses</NavLink>
      <NavLink to="/prix" className={({ isActive }) => `btn ${isActive ? 'active' : ''}`}>Meilleurs prix</NavLink>
    </div>
  )
}

/**
 * Où les produits habituels sont-ils les moins chers ? Compare les prix relevés
 * (recherches de prix, mises à jour sur demande) avec ce qui est payé d'habitude.
 */
export default function MeilleursPrix() {
  const { items, categories, storeById, isWeighedItem } = useApp()
  const [data, setData] = useState<{ refs: PriceReference[]; purchases: Purchase[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState<number | 'all'>('all')
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10)
    loadReferencesSince(since)
      .then(async (refs) => {
        const ids = [...new Set(refs.map((r) => r.item_id))]
        return { refs, purchases: await loadPurchasesForItems(ids) }
      })
      .then(setData)
      .catch((e) => setError((e as Error).message))
  }, [])

  const products = useMemo(
    () => (data ? compareProducts(items, categories, data.refs, data.purchases, (id) => storeById(id)?.name ?? null, isWeighedItem) : []),
    [data, items, categories, storeById, isWeighedItem],
  )

  if (error) return <p className="error">{error}</p>
  if (!data) return <Loading />

  const lastSearch = data.refs.reduce<string | null>((m, r) => (m === null || r.observed_on > m ? r.observed_on : m), null)
  const ranking = storeRanking(products)
  const cheaperElsewhere = products.filter((p) => p.diffPct != null && p.diffPct < -0.5)
  const avgSaving = cheaperElsewhere.length
    ? cheaperElsewhere.reduce((a, p) => a + p.diffPct!, 0) / cheaperElsewhere.length
    : null
  const cats = categories.filter((c) => products.some((p) => p.item.category_id === c.id))
  const q = search.trim().toLocaleLowerCase('fr')
  const shown = products
    .filter((p) => catFilter === 'all' || p.item.category_id === catFilter)
    .filter((p) => !q || p.item.name.toLocaleLowerCase('fr').includes(q))

  return (
    <div className="stack">
      <CoursesTabs />
      <div>
        <h1>Meilleurs prix</h1>
        <p className="muted small" style={{ margin: '4px 0 0' }}>
          {lastSearch
            ? <>Prix relevés dans les magasins, dernière mise à jour le <strong>{longDate(lastSearch)}</strong>. Comparés au dernier prix que vous avez payé (hors promo).</>
            : 'Les prix des magasins sont mis à jour sur demande.'}
        </p>
      </div>

      {!products.length ? (
        <div className="alert info">
          Aucune recherche de prix pour l'instant. Dès qu'une recherche aura été faite,
          vous verrez ici, pour chacun de vos produits, le magasin le moins cher.
        </div>
      ) : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="label">Produits comparés</div><div className="value">{products.length}</div></div>
            <div className="kpi">
              <div className="label">Moins chers ailleurs</div>
              <div className="value">{cheaperElsewhere.length}</div>
              {avgSaving != null && <div className="hint">en moyenne {pct(avgSaving)}</div>}
            </div>
          </div>

          {ranking.length > 0 && (
            <section className="card">
              <h2>Les magasins les moins chers</h2>
              <p className="muted small" style={{ marginTop: 0 }}>Nombre de vos produits pour lesquels chaque magasin propose le meilleur prix.</p>
              <div className="stack" style={{ gap: 10 }}>
                {ranking.map((r) => (
                  <div key={r.store}>
                    <div className="spread small"><strong>{r.store}</strong><span>{r.count} produit{r.count > 1 ? 's' : ''}</span></div>
                    <div className="meter"><span style={{ width: `${(r.count / ranking[0].count) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="card stack" style={{ gap: 10 }}>
            <input placeholder="Rechercher un produit…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {cats.length > 1 && (
              <div className="chips">
                <button className={`chip ${catFilter === 'all' ? 'selected' : ''}`} onClick={() => setCatFilter('all')}>Tous</button>
                {cats.map((c) => (
                  <button key={c.id} className={`chip ${catFilter === c.id ? 'selected' : ''}`} onClick={() => setCatFilter(c.id)}>{c.name}</button>
                ))}
              </div>
            )}
          </div>

          <div className="stack" style={{ gap: 10 }}>
            {shown.map((p) => {
              const unit = p.best.unit === 'piece' ? '' : `/${p.best.unit}`
              const saving = p.diffPct != null && p.diffPct < -0.5
              const alreadyBest = p.diffPct != null && !saving
              const expanded = open === p.item.id
              return (
                <section key={p.item.id} className="card" style={{ padding: 14 }}>
                  <div className="spread" style={{ alignItems: 'flex-start' }}>
                    <div>
                      <strong className="pname"><ProductIcon name={p.item.name} category={p.category?.name} icon={p.item.icon} />{p.item.name}</strong>
                      <div className="muted small">{p.category?.name} · {UNIT_LABEL[p.best.unit]}</div>
                    </div>
                    {saving && <span className="badge ok" style={{ background: 'var(--accent-soft)', color: 'var(--good-ink)' }}>{pct(p.diffPct!)}</span>}
                    {alreadyBest && <span className="badge plain">✓ déjà au meilleur prix</span>}
                  </div>
                  <div className="grid2" style={{ marginTop: 10, gap: 8 }}>
                    <div>
                      <div className="muted small">Le moins cher</div>
                      <div><strong>{eur(p.best.price)}{unit}</strong></div>
                      <div className="small">{p.best.store}{p.best.promo ? ' · promo' : ''}</div>
                    </div>
                    <div>
                      <div className="muted small">Vous payez</div>
                      {p.paid
                        ? <><div><strong>{eur(p.paid.price)}{unit}</strong></div><div className="small">{p.paid.store ?? '—'}{p.paid.date ? `, ${longDate(p.paid.date)}` : ''}</div></>
                        : <div className="small muted">pas encore acheté</div>}
                    </div>
                  </div>
                  <div className="row" style={{ marginTop: 6 }}>
                    {p.stores.length > 1 && (
                      <button className="btn-ghost small" style={{ padding: '4px 0', minHeight: 32 }} onClick={() => setOpen(expanded ? null : p.item.id)}>
                        {expanded ? '▾' : '▸'} {p.stores.length} magasins comparés
                      </button>
                    )}
                    <Link className="small" to={`/article/${p.item.id}`} style={{ marginLeft: 'auto' }}>Évolution du prix →</Link>
                  </div>
                  {expanded && (
                    <table style={{ marginTop: 6 }}>
                      <tbody>
                        {p.stores.map((s) => (
                          <tr key={s.store}>
                            <td>
                              {s.store}{s.promo && <span className="badge plain" style={{ marginLeft: 6 }}>promo</span>}
                              {s.label && <div className="muted small">{s.label}</div>}
                            </td>
                            <td className="muted small">{longDate(s.date)}</td>
                            <td className="num"><strong>{eur(s.price)}</strong>{unit}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              )
            })}
            {!shown.length && <p className="muted">Aucun produit ne correspond.</p>}
          </div>
        </>
      )}
    </div>
  )
}
