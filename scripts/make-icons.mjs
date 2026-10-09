// Génère les icônes PNG de l'application (installation sur GSM) à partir d'un SVG.
// Usage : node scripts/make-icons.mjs
import sharp from 'sharp'

// Icône « maskable » : le symbole reste dans la zone de sécurité centrale (80 %).
const svg = (rounded, scale) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="#1f6f5c"/>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <text x="256" y="350" font-family="Arial, Helvetica, sans-serif" font-size="280" font-weight="700" fill="#ffffff" text-anchor="middle">€</text>
  </g>
</svg>`

const out = [
  ['public/icon-192.png', 192, svg(true, 1)],
  ['public/icon-512.png', 512, svg(true, 1)],
  ['public/icon-maskable-512.png', 512, svg(false, 0.8)],
  ['public/apple-touch-icon.png', 180, svg(false, 0.9)],
]
for (const [file, size, s] of out) {
  await sharp(Buffer.from(s)).resize(size, size).png().toFile(file)
  console.log('✓', file)
}
