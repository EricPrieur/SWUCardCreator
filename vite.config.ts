import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const artDir = resolve(import.meta.dirname, 'public/art')

// Exposes the images in public/art as `virtual:art-list`, so the Card Creator
// can offer them without an upload. The page reloads when the folder changes.
function artList(): Plugin {
  const id = 'virtual:art-list'
  return {
    name: 'art-list',
    resolveId: (source) => (source === id ? '\0' + id : undefined),
    load(loaded) {
      if (loaded !== '\0' + id) return
      const files = readdirSync(artDir)
        .filter((file) => /\.(png|jpe?g|webp|avif)$/i.test(file))
        .sort((a, b) => a.localeCompare(b))
      return `export default ${JSON.stringify(files.map((file) => `/art/${file}`))}`
    },
    configureServer(server) {
      const refresh = (file: string) => {
        if (resolve(file).startsWith(artDir)) server.restart()
      }
      server.watcher.on('add', refresh).on('unlink', refresh)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Relative, so the built site works from any folder: GitHub Pages serves it from /<repo>/
  base: './',
  plugins: [react(), artList()],
})
