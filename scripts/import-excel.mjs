// Import des données du fichier Excel « Comptes privés » vers Supabase.
//
// Usage : node scripts/import-excel.mjs "Documents/Comptes privés 2025.xlsx" papa@exemple.be [année]
//
// Génère supabase/seed.sql, à exécuter UNE fois dans le SQL Editor de Supabase
// après schema.sql et après avoir créé le compte utilisateur. Le script lit les
// feuilles « Détail … » (achats) et la feuille « Global Octobre » (modèle du
// Global) et affiche un contrôle des totaux par bloc.
import ExcelJS from 'exceljs'
import { writeFileSync } from 'node:fs'

const [, , file, email, yearArg] = process.argv
if (!file || !email) {
  console.error('Usage : node scripts/import-excel.mjs <fichier.xlsx> <email-du-compte> [année]')
  process.exit(1)
}
const YEAR = Number(yearArg ?? 2026)

// --- Référentiels ----------------------------------------------------------

const CATEGORIES = [
  { name: 'Légumes', re: /^l[ée]gumes/i, weighed: true, inflation: true },
  { name: 'Café', re: /^caf[ée]/i },
  { name: 'Lait', re: /^lait/i },
  { name: 'Poulet & poisson', re: /poulet/i },
  { name: 'Pain', re: /^pain$/i },
  { name: 'Viande & jambon', re: /^viande/i },
  { name: 'Œufs', re: /^(œ|oe)ufs/i },
  { name: 'Médocs & toubibs', re: /^m[ée]docs/i },
  { name: 'Divers', re: /^divers/i, inflation: true },
  { name: 'Restos & sorties', re: /^restos/i },
  { name: 'Frais extra', re: /^frais extra/i },
]
const FUEL_RE = /^essence$/i

const STORE_ALIASES = {
  delh: 'Delhaize', carre: 'Carrefour', inter: 'Intermarché', interm: 'Intermarché', intermarche: 'Intermarché', carrefour: 'Carrefour', delhaize: 'Delhaize', colruyt: 'Colruyt', col: 'Colruyt', lidl: 'Lidl',
  aldi: 'Aldi', spar: 'Spar', berlo: 'Berlo', qpark: 'Q-Park', 'q-park': 'Q-Park',
  'linière': 'Pharmacie Linière', liniere: 'Pharmacie Linière', provélo: 'Pro Vélo', 'provelo': 'Pro Vélo',
}

// Variantes d'écriture rencontrées dans le fichier (clé sans accents, espaces ni « ! »)
const EXTRA_ALIASES = [
  [/^(deh|del|dlh)$/, 'Delhaize'], [/^carr$/, 'Carrefour'], [/^colr$/, 'Colruyt'], [/^ction$/, 'Action'],
  [/^st-?luc\d*$/, 'Saint-Luc'], [/^medi-?m/, 'Medi-Market'], [/^pharma$/, 'Pharmacie'], [/^linieres?$/, 'Pharmacie Linière'],
  [/^ikea$/, 'Ikea'], [/^flemal$/, 'Flémal'], [/^spar/, 'Spar'], [/^(chinois|chinoislln)$/, 'Chinois LLN'], [/^(pasta)?fresca$/, 'Pasta Fresca'],
]

const MONTH_NAMES =['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre']

const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
const clean = (s) => s.replace(/\s+/g, ' ').trim()
const capitalize = (s) => (s ? s[0].toLocaleUpperCase('fr') + s.slice(1) : s)

function sheetMonth(name) {
  const n = deaccent(name).toLowerCase()
  const i = MONTH_NAMES.findIndex((m) => n.includes(m))
  return i >= 0 ? i + 1 : null
}

function cellValue(cell) {
  const v = cell?.value
  if (v == null) return null
  if (typeof v === 'object') {
    if (v instanceof Date) return v
    if ('result' in v) return v.result ?? null
    if ('richText' in v) return v.richText.map((t) => t.text).join('')
    if ('text' in v) return v.text
    if ('error' in v) return null
  }
  return v
}
const text = (v) => (v == null ? '' : v instanceof Date ? '' : clean(String(v)))
const number = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+([.,]\d+)?$/.test(v.trim()) ? Number(v.replace(',', '.')) : null)

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
function dateFromSerial(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + n * 864e5)
  return d.toISOString().slice(0, 10)
}
function dateFromValue(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number' && v > 40000 && v < 60000) return dateFromSerial(v)
  return null
}

/** « Delh 25/9 » → { store: 'Delhaize', date: '2026-09-25' } */
function parseStoreDate(raw, month) {
  const asDate = dateFromValue(raw)
  if (asDate) return { store: null, date: asDate }
  const s = text(raw)
  if (!s) return { store: null, date: null }
  // « Delh 25/9 », « Carre - 27/2 », « CARRE-4/3 », « Lidl 21-3 »
  const m = s.match(/^(.*?)[\s\-–]*(\d{1,2})\s*[/-]\s*(\d{1,2})$/)
  let store = s
  let date = null
  if (m) {
    store = m[1]
    const d = Number(m[2])
    const mo = Number(m[3])
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) date = iso(mo > month + 1 ? YEAR - 1 : YEAR, mo, d)
  }
  store = clean(store.replace(/\s+\d+\s*sem\.?$/i, '').replace(/[\s\-–&.,]+$/, ''))
  if (!store) return { store: null, date }
  const key = deaccent(store).toLowerCase().replace(/[\s!]+/g, '')
  const alias = STORE_ALIASES[key] ?? EXTRA_ALIASES.find(([re]) => re.test(key))?.[1]
  return { store: alias ?? capitalize(store.toLocaleLowerCase('fr')), date }
}

/**
 * « Prunes promo 20% » → nom « Prunes », promo 20
 * « 2 bananes - 1,99€/kg » → nom « Bananes », 1,99 €/kg
 */
function parseItemName(raw, weighed = false) {
  let name = clean(raw)
  let promo = null
  let note = null
  let ppk = null
  // Dans un bloc pesé (Légumes), « Bananes 2,49€ » signifie aussi 2,49 €/kg.
  const k = weighed
    ? name.match(/^(.*?)[\s\-–]*(\d+[.,]\d+)\s*€(?:\s*\/\s*kg)?$/i)
    : name.match(/^(.*?)[\s\-–]*(\d+(?:[.,]\d+)?)\s*€\s*\/\s*kg$/i)
  if (k) {
    ppk = Number(k[2].replace(',', '.'))
    name = k[1].replace(/^\d+\s+(?=\D)/, '') // le nombre de pièces n'a plus d'intérêt avec le €/kg
  }
  const p = name.match(/^(.*?)\s+promo\s*(\d+)\s*%$/i)
  if (p) { name = p[1]; promo = Number(p[2]) }
  else if (/\s+promo$/i.test(name)) { name = name.replace(/\s+promo$/i, ''); note = 'promo' }
  name = name.replace(/[\s\-–]+$/, '')
  return { name: capitalize(name), promo, note, ppk }
}

// --- Lecture du classeur ---------------------------------------------------

const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(file)

const purchases = []
const fuel = []
const report = []

for (const ws of wb.worksheets) {
  if (!/^d[ée]tail/i.test(deaccent(ws.name))) continue
  const month = sheetMonth(ws.name)
  if (!month) { console.warn(`Mois introuvable pour la feuille « ${ws.name} », ignorée.`); continue }
  const period = iso(YEAR, month, 1)
  // Ligne d'en-tête d'un bloc : même ligne ou une des deux suivantes, avec « Magasin / Qui / Occasion / Date » à droite.
  const headerRow = (r, c) => [r, r + 1, r + 2].find((rr) => /magasin|qui|occasion|date/i.test(text(get(rr, c + 1)))) ?? null
  const get = (r, c) => (r > 0 && c > 0 ? cellValue(ws.getRow(r).getCell(c)) : null)

  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= ws.columnCount; c++) {
      const label = text(get(r, c))
      if (!label) continue
      const cat = CATEGORIES.find((x) => x.re.test(label))
      const isFuel = FUEL_RE.test(label)
      if (!cat && !isFuel) continue

      const hr = headerRow(r, c)
      if (!hr) continue
      const cols = {}
      for (let cc = c + 1; cc <= c + 8; cc++) {
        const h = deaccent(text(get(hr, cc))).toLowerCase()
        if (!h) continue
        if (/magasin|qui|occasion/.test(h) && !cols.store) cols.store = cc
        else if (/^date/.test(h) && !cols.date) cols.date = cc
        else if (/q[u]?antit/.test(h)) cols.qty = cc
        else if (/€\/kg|e\/kg/.test(h)) cols.ppk = cc
        else if (/promo/.test(h)) cols.promo = cc
        else if (/montant/.test(h)) cols.amount = cc
        else if (/^total/.test(h)) { cols.total = cc; break }
      }
      if (!cols.amount && !cols.total) continue

      let sum = 0
      let excelTotal = null
      for (let rr = hr + 1; rr <= hr + 80; rr++) {
        const nameRaw = text(get(rr, c))
        if (/^(total|nbre)/i.test(nameRaw)) {
          excelTotal = number(get(rr, cols.total ?? cols.amount))
          break
        }
        if (rr > hr + 1 && (CATEGORIES.some((x) => x.re.test(nameRaw)) || FUEL_RE.test(nameRaw)) && headerRow(rr, c)) break
        if (!nameRaw) continue
        const amount = number(get(rr, cols.amount)) ?? number(get(rr, cols.total))
        if (!amount || amount <= 0) continue
        const sd = parseStoreDate(get(rr, cols.store), month)
        const date = (cols.date && dateFromValue(get(rr, cols.date))) || sd.date
        if (isFuel) {
          fuel.push({ period, station: sd.store ?? capitalize(nameRaw), date: date ?? dateFromValue(get(rr, cols.date ?? 0)), total: amount })
          sum += amount
          continue
        }
        const it = parseItemName(nameRaw, Boolean(cat.weighed))
        purchases.push({
          period, category: cat.name, item: it.name, store: sd.store, date,
          qty: cols.qty ? number(get(rr, cols.qty)) : null,
          ppk: (cols.ppk ? number(get(rr, cols.ppk)) : null) ?? it.ppk,
          promo: (cols.promo ? number(get(rr, cols.promo)) : null) ?? it.promo,
          amount: Math.round(amount * 100) / 100,
          note: it.note,
        })
        sum += amount
      }
      report.push({ feuille: ws.name, bloc: isFuel ? 'Essence' : cat.name, lignes: purchases.filter((p) => p.period === period && p.category === cat?.name).length, importe: Math.round(sum * 100) / 100, totalExcel: excelTotal })
    }
  }
}

// Fusion des blocs identiques (une même catégorie peut apparaître deux fois)
const merged = new Map()
for (const r of report) {
  const k = `${r.feuille}|${r.bloc}`
  const m = merged.get(k)
  if (m) { m.importe = Math.round((m.importe + r.importe) * 100) / 100; m.totalExcel = (m.totalExcel ?? 0) + (r.totalExcel ?? 0) }
  else merged.set(k, { ...r })
}
console.table([...merged.values()].map(({ lignes, ...r }) => r))

// --- Génération du SQL -----------------------------------------------------

const q = (v) => (v == null ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)

// Articles : dédoublonnage insensible à la casse, on garde la graphie la plus fréquente.
const itemKey = (p) => `${p.category}|${p.item.toLocaleLowerCase('fr')}`
const itemNames = new Map()
for (const p of purchases) {
  const k = itemKey(p)
  const counts = itemNames.get(k) ?? new Map()
  counts.set(p.item, (counts.get(p.item) ?? 0) + 1)
  itemNames.set(k, counts)
}
const canonical = new Map([...itemNames].map(([k, counts]) => [k, [...counts].sort((a, b) => b[1] - a[1])[0][0]]))
for (const p of purchases) p.item = canonical.get(itemKey(p))

// Magasins triés par fréquence : les plus fréquents reçoivent les premières couleurs.
const storeCounts = new Map()
for (const p of purchases) if (p.store) storeCounts.set(p.store, (storeCounts.get(p.store) ?? 0) + 1)
const stores = [...storeCounts].sort((a, b) => b[1] - a[1]).map(([s]) => s)

const oct = iso(YEAR, 10, 1)
const sql = `-- Généré par scripts/import-excel.mjs à partir de « ${file.split(/[\\/]/).pop()} »
-- ${purchases.length} achats, ${canonical.size} articles, ${stores.length} magasins, ${fuel.length} pleins d'essence.
-- À exécuter UNE fois dans Supabase (SQL Editor), après schema.sql.
set search_path to comptes, public;
do $$
declare
  uid uuid;
begin
  select id into uid from auth.users where email = ${q(email)};
  if uid is null then
    raise exception 'Aucun utilisateur avec l''adresse %. Créez-le d''abord (Authentication > Users).', ${q(email)};
  end if;

  insert into categories (user_id, name, sort_order, weighed, track_inflation) values
${CATEGORIES.map((c, i) => `    (uid, ${q(c.name)}, ${i}, ${Boolean(c.weighed)}, ${Boolean(c.inflation)})`).join(',\n')}
  on conflict (user_id, name) do nothing;

  insert into stores (user_id, name) values
${stores.map((s) => `    (uid, ${q(s)})`).join(',\n')}
  on conflict (user_id, name) do nothing;

  insert into items (user_id, category_id, name)
  select uid, c.id, v.name
  from (values
${[...new Set([...canonical].map(([k, n]) => `${k.split('|')[0]}\u0000${n}`))].map((s) => { const [cat, n] = s.split('\u0000'); return `    (${q(cat)}, ${q(n)})` }).join(',\n')}
  ) as v(category, name)
  join categories c on c.user_id = uid and c.name = v.category
  on conflict (category_id, name) do nothing;

  insert into purchases (user_id, period, item_id, store_id, purchased_on, quantity_g, price_per_kg, promo_pct, amount, note)
  select uid, v.period::date, i.id, s.id, v.purchased_on::date, v.qty, v.ppk, v.promo, v.amount, v.note
  from (values
${purchases.map((p) => `    (${q(p.period)}, ${q(p.category)}, ${q(p.item)}, ${q(p.store)}, ${q(p.date)}, ${q(p.qty)}::numeric, ${q(p.ppk)}::numeric, ${q(p.promo)}::numeric, ${p.amount}, ${q(p.note)})`).join(',\n')}
  ) as v(period, category, item, store, purchased_on, qty, ppk, promo, amount, note)
  join categories c on c.user_id = uid and c.name = v.category
  join items i on i.category_id = c.id and i.name = v.item
  left join stores s on s.user_id = uid and s.name = v.store;
${fuel.length ? `
  insert into fuel_fills (user_id, period, station, filled_on, total) values
${fuel.map((f) => `    (uid, ${q(f.period)}, ${q(f.station)}, ${q(f.date)}, ${f.total})`).join(',\n')};
` : ''}
  -- Global d'octobre (modèle) : rentrées, dépenses fixes, solde de départ
  insert into months (user_id, period, opening_balance, notes)
  values (uid, ${q(oct)}, 0, 'Solde de départ repris de l''Excel (non renseigné) : à corriger si besoin.')
  on conflict do nothing;

  insert into monthly_lines (user_id, period, section, label, amount, carry_over, sort_order) values
    (uid, ${q(oct)}, 'revenu', 'Retraite', 1623.09, true, 0),
    (uid, ${q(oct)}, 'revenu', 'Remboursements', 0, false, 1),
    (uid, ${q(oct)}, 'fixe', 'Loyer', 1001.36, true, 0),
    (uid, ${q(oct)}, 'fixe', 'BasicFit', 24.99, true, 1),
    (uid, ${q(oct)}, 'fixe', 'Frais bancaires', 5.90, true, 2),
    (uid, ${q(oct)}, 'fixe', 'Électricité', 48.00, true, 3),
    (uid, ${q(oct)}, 'fixe', 'GSM', 76.78, true, 4);

  -- Provisions pour dépenses annuelles ${YEAR}
  insert into annual_provisions (user_id, year, label, annual_amount, sort_order) values
    (uid, ${YEAR}, 'Taxe voiture', 169.32, 0),
    (uid, ${YEAR}, 'Assurance voiture', 476.10, 1),
    (uid, ${YEAR}, 'Assurance incendie', 182.02, 2),
    (uid, ${YEAR}, 'Eau (trimestriel)', 196.00, 3),
    (uid, ${YEAR}, 'Voirie / poubelles', 55.00, 4),
    (uid, ${YEAR}, 'Badminton (trimestriel)', 98.80, 5),
    (uid, ${YEAR}, 'Hospitalia+ (trimestriel)', 744.00, 6),
    (uid, ${YEAR}, 'Collier chat', 54.00, 7);

  insert into annual_payments (user_id, provision_id, paid_on, amount, note)
  select uid, p.id, v.paid_on::date, v.amount, v.note
  from (values
    ('Eau (trimestriel)', '${YEAR}-10-09', 52.81, 'Solde année (échéance 15/10)'),
    ('Badminton (trimestriel)', '${YEAR}-09-30', 98.80, 'Trim. 4, payé en septembre'),
    ('Hospitalia+ (trimestriel)', '${YEAR}-10-08', 186.51, 'Trim. 4')
  ) as v(label, paid_on, amount, note)
  join annual_provisions p on p.user_id = uid and p.year = ${YEAR} and p.label = v.label;

  -- Compte épargne (solde repris de l'Excel, avant les paiements Eau et Hospitalia)
  insert into savings_movements (user_id, moved_on, label, amount, note) values
    (uid, '${YEAR}-10-01', 'Solde épargne (reprise Excel)', 10226.18, null),
    (uid, '${YEAR}-10-08', 'Hospitalia+ trim. 4', -186.51, null),
    (uid, '${YEAR}-10-09', 'Eau trim. 4', -52.81, null);

  insert into user_settings (user_id, annual_budget) values (uid, 2000)
  on conflict (user_id) do nothing;
end $$;
`
writeFileSync('supabase/seed.sql', sql)
console.log(`\nsupabase/seed.sql généré : ${purchases.length} achats, ${canonical.size} articles, ${stores.length} magasins, ${fuel.length} pleins.`)
