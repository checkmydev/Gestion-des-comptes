import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base relative : l'app fonctionne quel que soit le nom du dépôt GitHub Pages.
export default defineConfig({
  base: './',
  plugins: [react()],
})
