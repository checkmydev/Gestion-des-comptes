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
  /** L'article appartient-il à une catégorie pesée (prix au kilo) ? */
  isWeighedItem: (itemId: number) => boolean
  /** Crée l'article s'il n'existe pas encore dans la catégorie. */
  ensureItem: (categoryId: number, name: string) => Promise<Item>
  ensureStore: (name: string) => Promise<Store>
  /** Augmente quand l'assistant a modifié des données : l'écran affiché se recharge. */
  dataVersion: number
  dataChanged: () => void
  /** Panneau de l'assistant ouvert par-dessus l'écran en cours. */
  assistantOpen: boolean
  setAssistantOpen: (open: boolean) => void
}

const Ctx = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  // L'application s'ouvre toujours sur le mois en cours (qui commence le 26).
  const [period, setPeriodState] = useState(() => currentPeriod())
  // Tant que l'utilisateur n'a pas choisi un autre mois, on suit le mois en cours.
  const [followCurrent, setFollowCurrent] = useState(true)
  const [categories, setCategories] = useState<Category[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dataVersion, setDataVersion] = useState(0)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const dataChanged = useCallback(() => setDataVersion((v) => v + 1), [])

  const setPeriod = useCallback((p: string) => {
    setPeriodState(p)
    setFollowCurrent(p === currentPeriod())
  }, [])

  // Passage automatique au mois suivant le 26, même si l'application est restée
  // ouverte (GSM en veille) : vérifié au retour dans l'application et chaque minute.
  useEffect(() => {
    if (!followCurrent) return
    const sync = () => setPeriodState((p) => (p === currentPeriod() ? p : currentPeriod()))
    const timer = window.setInterval(sync, 60_000)
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', sync)
    sync()
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', sync)
    }
  }, [followCurrent])

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
      dataVersion, dataChanged, assistantOpen, setAssistantOpen,
      categoryById: (id) => categories.find((c) => c.id === id),
      itemById: (id) => items.find((i) => i.id === id),
      storeById: (id) => (id == null ? undefined : stores.find((s) => s.id === id)),
      isWeighedItem: (itemId) => {
        const it = items.find((i) => i.id === itemId)
        return Boolean(it && categories.find((c) => c.id === it.category_id)?.weighed)
      },
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
  }, [period, setPeriod, categories, items, stores, settings, loading, error, reload, dataVersion, dataChanged, assistantOpen])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp hors AppProvider')
  return v
}
