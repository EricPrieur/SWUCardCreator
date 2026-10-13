import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const artDir = resolve(import.meta.dirname, 'public/art')

function artFiles() {
  return readdirSync(artDir)
    .filter((file) => /\.(png|jpe?g|webp|avif)$/i.test(file))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => `/art/${file}`)
}

// Exposes the images in public/art as `virtual:art-list`, so the Card Creator
// can offer them without an upload. When the folder changes, the open page is
// sent the new list as an `art-list` event rather than reloaded, so a card
// being worked on is left alone.
function artList(): Plugin {
  const id = 'virtual:art-list'
  return {
    name: 'art-list',
    resolveId: (source) => (source === id ? '\0' + id : undefined),
    load(loaded) {
      if (loaded === '\0' + id) return `export default ${JSON.stringify(artFiles())}`
    },
    configureServer(server) {
      const refresh = (file: string) => {
        if (!resolve(file).startsWith(artDir)) return
        // A page loaded later must get the new list too
        const module = server.moduleGraph.getModuleById('\0' + id)
        if (module) server.moduleGraph.invalidateModule(module)
        server.ws.send({ type: 'custom', event: 'art-list', data: artFiles() })
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
