import { productIcon } from '../lib/icons'

/** Petite icône d'un produit (émoji), décorative : le nom est toujours écrit à côté. */
export function ProductIcon({ name, category, icon }: { name: string; category?: string; icon?: string | null }) {
  return <span className="picon" aria-hidden="true">{productIcon(name, category, icon)}</span>
}
