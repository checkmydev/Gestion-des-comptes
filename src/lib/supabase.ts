import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && key)

// Le projet Supabase est partagé : toutes les tables sont dans le schéma « comptes ».
export const supabase = createClient(url ?? 'http://localhost', key ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'comptes-auth' },
  db: { schema: 'comptes' },
})

/** Adresse et clé publique, pour les appels qui renvoient autre chose que du JSON (audio). */
export const supabaseUrl = url ?? 'http://localhost'
export const supabaseAnonKey = key ?? 'missing'
