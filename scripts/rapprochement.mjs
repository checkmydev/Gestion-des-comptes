// Rapprochement : totaux par catégorie des feuilles « Global » de l'Excel vs achats importés (supabase/seed.sql).
// Usage : node scripts/rapprochement.mjs "Documents/Comptes privés 2025.xlsx" supabase/seed.sql
import ExcelJS from 'exceljs'
import { readFileSync } from 'node:fs'

const [file, seedFile] = process.argv.slice(2)
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(file)
const MAP = [
  [/fruits|l[ée]gumes/i, 'Légumes'], [/caf[ée]/i, 'Café'], [/^lait/i, 'Lait'], [/poulet/i, 'Poulet & poisson'],
  [/^pain/i, 'Pain'], [/viande/i, 'Viande & jambon'], [/(œ|oe)ufs/i, 'Œufs'], [/m[ée]docs/i, 'Médocs & toubibs'],
  [/^divers/i, 'Divers'], [/restos/i, 'Restos & sorties'], [/frais extra/i, 'Frais extra'],
]
const MONTHS = { fevrier: '02', mars: '03', avril: '04', mai: '05', juin: '06', juillet: '07', aout: '08', septembre: '09', octobre: '10' }
const deacc = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const excel = {}
for (const ws of wb.worksheets) {
  const n = deacc(ws.name)
  if (!/global|frais reels/.test(n)) continue
  const m = Object.entries(MONTHS).find(([k]) => n.includes(k))?.[1]
  if (!m) continue
  ws.eachRow((row) => {
    const label = String(row.getCell(2).value ?? '').trim()
    const cat = MAP.find(([re]) => re.test(label))?.[1]
    if (!cat) return
    const v = row.getCell(3).value
    const val = typeof v === 'number' ? v : v && typeof v === 'object' && 'result' in v ? v.result : null
    if (typeof val === 'number') excel[`${m}|${cat}`] = (excel[`${m}|${cat}`] ?? 0) + val
  })
}
// seed : somme par mois et catégorie
const seed = readFileSync(seedFile, 'utf8')
const rows = seed.split('insert into purchases')[1].split(') as v(')[0].split('\n').filter((l) => l.startsWith('    ('))
const mine = {}
for (const r of rows) {
  const m = r.match(/^\s*\('2026-(\d\d)-01', '((?:[^']|'')+)', .*, ([\d.]+), (?:null|'(?:[^']|'')*')\),?$/)
  if (!m) continue
  const k = `${m[1]}|${m[2].replace(/''/g, "'")}`
  mine[k] = (mine[k] ?? 0) + Number(m[3])
}
const keys = [...new Set([...Object.keys(excel), ...Object.keys(mine)])].sort()
const diffs = keys.map((k) => ({ mois: k.split('|')[0], categorie: k.split('|')[1], excel: Math.round((excel[k] ?? 0) * 100) / 100, importe: Math.round((mine[k] ?? 0) * 100) / 100 }))
  .map((d) => ({ ...d, ecart: Math.round((d.importe - d.excel) * 100) / 100 }))
  .filter((d) => Math.abs(d.ecart) > 0.5 && d.mois !== '10')
console.table(diffs)
const byMonth = {}
for (const d of diffs) byMonth[d.mois] = Math.round(((byMonth[d.mois] ?? 0) + d.ecart) * 100) / 100
console.log('écart net par mois (importé − Excel) :', byMonth)
