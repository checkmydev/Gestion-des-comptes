// Génère les icônes PNG de l'application (installation sur GSM) à partir d'un SVG.
// Usage : npm run icons
//
// Motif : un panier de courses et une pièce en euro (courses + budget).
import sharp from 'sharp'

const art = `
  <!-- feuilles qui dépassent du panier -->
  <path d="M214 196c-6-46 18-82 62-96 6 44-18 82-62 96z" fill="#9be3c4"/>
  <path d="M248 190c14-40 50-60 92-54-12 40-48 62-92 54z" fill="#7fd3b0"/>
  <!-- anse -->
  <path d="M168 232c0-62 40-104 96-104s96 42 96 104" fill="none" stroke="#ffffff" stroke-width="22" stroke-linecap="round"/>
  <!-- bord du panier -->
  <rect x="112" y="220" width="304" height="44" rx="22" fill="#ffffff"/>
  <!-- corps du panier -->
  <path d="M134 264h260l-30 136a28 28 0 0 1-27 22H191a28 28 0 0 1-27-22z" fill="#ffffff"/>
  <!-- tressage -->
  <g stroke="#1f6f5c" stroke-width="14" stroke-linecap="round" opacity="0.9">
    <line x1="204" y1="296" x2="214" y2="388"/>
    <line x1="264" y1="296" x2="264" y2="388"/>
    <line x1="324" y1="296" x2="314" y2="388"/>
  </g>
  <!-- pièce en euro -->
  <circle cx="372" cy="372" r="78" fill="#1f6f5c"/>
  <circle cx="372" cy="372" r="66" fill="#f6bd2f"/>
  <circle cx="372" cy="372" r="52" fill="none" stroke="#e09b10" stroke-width="6"/>
  <text x="372" y="400" font-family="Arial, Helvetica, sans-serif" font-size="80" font-weight="700" fill="#1f5a49" text-anchor="middle">€</text>
`

const svg = ({ rounded, scale }) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2f9479"/>
      <stop offset="1" stop-color="#1a5f4f"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="url(#bg)"/>
  <g transform="translate(256 262) scale(${scale}) translate(-264 -262)">${art}</g>
</svg>`

const out = [
  // « any » : icône arrondie, le motif occupe presque tout l'espace
  ['public/icon-192.png', 192, svg({ rounded: true, scale: 1 })],
  ['public/icon-512.png', 512, svg({ rounded: true, scale: 1 })],
  // « maskable » (Android) : fond plein, motif dans la zone de sécurité centrale (80 %)
  ['public/icon-maskable-512.png', 512, svg({ rounded: false, scale: 0.78 })],
  // iPhone : iOS arrondit lui-même les coins
  ['public/apple-touch-icon.png', 180, svg({ rounded: false, scale: 0.9 })],
]
for (const [file, size, s] of out) {
  await sharp(Buffer.from(s)).resize(size, size).png().toFile(file)
  console.log('✓', file)
}
