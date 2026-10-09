/** Taille du texte choisie sur cet appareil (Paramètres → Taille du texte). */
export type TextSize = 'normal' | 'grand' | 'tres-grand'

const KEY = 'comptes.textSize'

export const TEXT_SIZES: { value: TextSize; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'grand', label: 'Grand' },
  { value: 'tres-grand', label: 'Très grand' },
]

export function readTextSize(): TextSize {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'grand' || v === 'tres-grand' ? v : 'normal'
  } catch { return 'normal' }
}

export function applyTextSize(size: TextSize) {
  if (size === 'normal') document.documentElement.removeAttribute('data-text')
  else document.documentElement.setAttribute('data-text', size)
}

export function saveTextSize(size: TextSize) {
  applyTextSize(size)
  try { localStorage.setItem(KEY, size) } catch { /* ignoré : réglage non mémorisé */ }
}
