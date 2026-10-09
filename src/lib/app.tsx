import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, insertRow, loadRefs } from './api'
import { currentPeriod } from './period'
import { supabase } from './supabase'
import type { Category, Item, Store, UserSettings } from './types'

interface AppState {
  period: string
  setPeriod: (p: string) => void
  categories: Category[]
  items: Item[]
  stores: Store[]
  settings: UserSettings
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  categoryById: (id: number) => Category | undefined
  itemById: (id: number) => Item | undefined
  storeById: (id: number | null) => Store | undefined
  /** Crée l'article s'il n'existe pas encore dans la catégorie. */
  ensureItem: (categoryId: number, name: string) => Promise<Item>
  ensureStore: (name: string) => Promise<Store>
}

const Ctx = createContext<AppState | null>(null)

const PERIOD_KEY = 'comptes.period'

function readStoredPeriod(): string {
  try {
    const p = sessionStorage.getItem(PERIOD_KEY)
    if (p && /^\d{4}-\d{2}-01$/.test(p)) return p
  } catch { /* stockage indisponible */ }
  return currentPeriod()
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [period, setPeriodState] = useState(readStoredPeriod)
  const [categories, setCategories] = useState<Category[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const setPeriod = useCallback((p: string) => {
    setPeriodState(p)
    try { sessionStorage.setItem(PERIOD_KEY, p) } catch { /* ignoré */ }
  }, [])

  const reload = useCallback(async () => {
    try {
      const r = await loadRefs()
      setCategories(r.categories)
      setItems(r.items)
      setStores(r.stores)
      setSettings({
        annual_budget: Number(r.settings.annual_budget),
        emergency_target: Number(r.settings.emergency_target),
      })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  // Keep-alive : signale à Supabase que le projet est utilisé (évite la mise en
  // pause après 7 jours d'inactivité). Sans effet sur les comptes ; erreurs ignorées.
  useEffect(() => {
    supabase.rpc('keep_alive', { source: 'app' }).then(() => {}, () => {})
  }, [])

  const value = useMemo<AppState>(() => {
    const norm = (s: string) => s.trim().toLocaleLowerCase('fr')
    return {
      period, setPeriod, categories, items, stores, settings, loading, error, reload,
      categoryById: (id) => categories.find((c) => c.id === id),
      itemById: (id) => items.find((i) => i.id === id),
      storeById: (id) => (id == null ? undefined : stores.find((s) => s.id === id)),
      ensureItem: async (categoryId, name) => {
        const existing = items.find((i) => i.category_id === categoryId && norm(i.name) === norm(name))
        if (existing) return existing
        const created = await insertRow<Item>('items', { category_id: categoryId, name: name.trim() })
        setItems((xs) => [...xs, created].sort((a, b) => a.name.localeCompare(b.name, 'fr')))
        return created
      },
      ensureStore: async (name) => {
        const existing = stores.find((s) => norm(s.name) === norm(name))
        if (existing) return existing
        const created = await insertRow<Store>('stores', { name: name.trim() })
        setStores((xs) => [...xs, created].sort((a, b) => a.name.localeCompare(b.name, 'fr')))
        return created
      },
    }
  }, [period, setPeriod, categories, items, stores, settings, loading, error, reload])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp hors AppProvider')
  return v
}
