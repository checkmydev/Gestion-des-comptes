import { useState } from 'react'
import { FormModal } from '../components/Modal'
import { deleteRow, must, saveRow, saveSettings, updateRow } from '../lib/api'
import { useApp } from '../lib/app'
import { eur } from '../lib/format'
import { supabase } from '../lib/supabase'
import type { Category, Item, Store } from '../lib/types'
import type { FormSpec } from './Global'
import { ProductIcon } from '../components/ProductIcon'
import { productIcon } from '../lib/icons'
import { readTextSize, saveTextSize, TEXT_SIZES, type TextSize } from '../lib/textsize'

/** Catégories reprises du fichier Excel (modèle d'octobre). */
export const DEFAULT_CATEGORIES: Partial<Category>[] = [
  { name: 'Légumes', weighed: true, track_inflation: true },
  { name: 'Café' },
  { name: 'Lait' },
  { name: 'Poulet & poisson' },
  { name: 'Pain' },
  { name: 'Viande & jambon' },
  { name: 'Œufs' },
  { name: 'Médocs & toubibs' },
  { name: 'Divers', track_inflation: true, counted: true },
  { name: 'Restos & sorties' },
  { name: 'Frais extra' },
]

export default function Parametres() {
  const { categories, items, stores, settings, reload } = useApp()
  const [form, setForm] = useState<FormSpec | null>(null)
  const [itemCat, setItemCat] = useState<number | null>(categories[0]?.id ?? null)
  const [error, setError] = useState<string | null>(null)
  const [textSize, setTextSize] = useState<TextSize>(readTextSize)

  const run = async (f: () => Promise<unknown>) => {
    try { await f(); await reload() } catch (e) { setError((e as Error).message) }
  }

  const editCategory = (c?: Category) => setForm({
    title: c ? c.name : 'Nouvelle catégorie',
    fields: [
      { key: 'name', label: 'Nom', type: 'text', required: true },
      { key: 'monthly_budget', label: 'Budget mensuel (€)', type: 'amount', hint: 'facultatif' },
      { key: 'weighed', label: 'Colonnes Quantité / €/kg / Promo', type: 'checkbox' },
      { key: 'counted', label: 'Colonne Nombre (1 par défaut)', type: 'checkbox' },
      { key: 'track_inflation', label: 'Inclure dans les statistiques d\'inflation', type: 'checkbox' },
      ...(c ? [{ key: 'archived', label: 'Archivée (masquée de la saisie)', type: 'checkbox' as const }] : []),
    ],
    initial: c ?? {},
    onSave: async (v) => run(() => saveRow('categories', { ...v, sort_order: c?.sort_order ?? categories.length }, c?.id)),
    onDelete: c ? async () => {
      if (items.some((i) => i.category_id === c.id)) throw new Error('Cette catégorie contient des articles : archivez-la plutôt.')
      await run(() => deleteRow('categories', c.id))
    } : undefined,
  })

  async function move(c: Category, dir: -1 | 1) {
    const list = [...categories]
    const i = list.findIndex((x) => x.id === c.id)
    const j = i + dir
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    await run(() => Promise.all(list.map((x, k) => (x.sort_order === k ? null : updateRow('categories', x.id, { sort_order: k })))))
  }

  async function createDefaults() {
    await run(async () => must(await supabase.from('categories').insert(
      DEFAULT_CATEGORIES.map((c, i) => ({ ...c, sort_order: i })),
    )))
  }

  const editStore = (s: Store) => setForm({
    title: s.name,
    fields: [{ key: 'name', label: 'Nom du magasin', type: 'text', required: true }],
    initial: s,
    onSave: async (v) => run(() => saveRow('stores', v, s.id)),
    onDelete: async () => run(() => deleteRow('stores', s.id)),
  })

  const editItem = (it: Item) => setForm({
    title: it.name,
    fields: [
      { key: 'name', label: 'Nom de l\'article', type: 'text', required: true },
      { key: 'icon', label: 'Icône (un émoji)', type: 'text', placeholder: productIcon(it.name, categories.find((c) => c.id === it.category_id)?.name), hint: 'laisser vide pour l\'icône automatique' },
      { key: 'category_id', label: 'Catégorie', type: 'select', options: categories.map((c) => ({ value: String(c.id), label: c.name })) },
    ],
    initial: { ...it, category_id: String(it.category_id) },
    onSave: async (v) => run(() => saveRow('items', { ...v, category_id: Number(v.category_id) }, it.id)),
    onDelete: async () => {
      const { count } = await supabase.from('purchases').select('id', { count: 'exact', head: true }).eq('item_id', it.id)
      if (count) throw new Error(`Cet article a ${count} achat(s) : impossible de le supprimer. Renommez-le ou déplacez-le.`)
      await run(() => deleteRow('items', it.id))
    },
  })

  const editSettings = () => setForm({
    title: 'Objectifs',
    fields: [
      { key: 'annual_budget', label: 'Plafond des dépenses annuelles (€)', type: 'amount', required: true },
      { key: 'emergency_target', label: 'Réserve « imprévus » visée sur l\'épargne (€)', type: 'amount', required: true, hint: 'ex. 3 mois de dépenses' },
    ],
    initial: { ...settings },
    onSave: async (v) => run(() => saveSettings({ annual_budget: Number(v.annual_budget), emergency_target: Number(v.emergency_target) })),
  })

  return (
    <div className="stack">
      <h1>Paramètres</h1>
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>Taille du texte</h2>
        <div className="chips" role="radiogroup" aria-label="Taille du texte">
          {TEXT_SIZES.map((t) => (
            <button key={t.value} role="radio" aria-checked={textSize === t.value}
              className={`chip ${textSize === t.value ? 'selected' : ''}`}
              onClick={() => { saveTextSize(t.value); setTextSize(t.value) }}>
              {textSize === t.value && '✓ '}{t.label}
            </button>
          ))}
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>Réglage propre à cet appareil (GSM, tablette…).</p>
      </section>

      <section className="card">
        <div className="spread"><h2>Objectifs</h2><button className="btn-ghost" onClick={editSettings}>Modifier</button></div>
        <p className="small">Plafond annuel : <strong>{eur(settings.annual_budget)}</strong> · Réserve imprévus : <strong>{eur(settings.emergency_target)}</strong></p>
      </section>

      <section className="card">
        <div className="spread"><h2>Catégories</h2><button className="btn-ghost" onClick={() => editCategory()}>+ Ajouter</button></div>
        {!categories.length && <button className="btn-primary" onClick={createDefaults}>Créer les catégories de l'Excel</button>}
        <div className="list">
          {categories.map((c, i) => (
            <div key={c.id} className="row" style={{ flexWrap: 'nowrap' }}>
              <button className="btn-ghost grow" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 0, padding: 0, color: 'var(--ink)' }} onClick={() => editCategory(c)}>
                <span className={c.archived ? 'muted' : ''}>{c.name}</span>
                <span className="muted small">
                  {[c.weighed && '€/kg', c.counted && 'nombre', c.track_inflation && 'inflation', c.monthly_budget && `budget ${eur(c.monthly_budget)}`, c.archived && 'archivée'].filter(Boolean).join(' · ')}
                </span>
              </button>
              <button className="btn-ghost" aria-label="Monter" disabled={i === 0} onClick={() => move(c, -1)}>↑</button>
              <button className="btn-ghost" aria-label="Descendre" disabled={i === categories.length - 1} onClick={() => move(c, 1)}>↓</button>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Articles</h2>
        <select value={itemCat ?? ''} onChange={(e) => setItemCat(Number(e.target.value))} style={{ marginBottom: 12 }}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="list">
          {items.filter((i) => i.category_id === itemCat).map((i) => (
            <button key={i.id} onClick={() => editItem(i)}><span className="pname"><ProductIcon name={i.name} category={categories.find((c) => c.id === i.category_id)?.name} icon={i.icon} />{i.name}</span> <span className="muted">›</span></button>
          ))}
        </div>
        <p className="muted small">Les nouveaux articles se créent directement depuis la saisie.</p>
      </section>

      <section className="card">
        <h2>Magasins</h2>
        <div className="list">
          {stores.map((s) => <button key={s.id} onClick={() => editStore(s)}>{s.name} <span className="muted">›</span></button>)}
        </div>
      </section>

      <a className="btn" href="./notice.html">Notice d'utilisation</a>
      <button onClick={() => supabase.auth.signOut()}>Se déconnecter</button>

      {form && <FormModal {...form} onClose={() => setForm(null)} />}
    </div>
  )
}
