import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const artDir = resolve(import.meta.dirname, 'public/art')

// The art folder is this computer's own and is not in git, so the site built on
// GitHub has none: there, card art is only what people upload in their browser
function artFiles() {
  if (!existsSync(artDir)) return []
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

const showcaseDir = resolve(import.meta.dirname, 'public/showcase')

// For the Showroom's Publish button, on this computer only: writes a set's card
// images and list into public/showcase/<SET>, from where the site serves them once
// they are committed. Nothing like it exists on the built site.
//   PUT  /__publish/<SET>/<file>   a card image or the set's showcase.json
//   POST /__publish/<SET>/finish   with the files to keep: drops the set's other files
//                                  and brings public/showcase/index.json up to date
function publishSets(): Plugin {
  const safe = (name: string) => name !== '' && !/[\\/]|\.\./.test(name)
  return {
    name: 'publish-sets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__publish', (req, res) => {
        const [set, file] = (req.url ?? '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent)
        const fail = (status: number, message: string) => {
          res.statusCode = status
          res.end(message)
        }
        if (!set || !/^[A-Za-z0-9_-]+$/.test(set) || !file || !safe(file)) return fail(400, 'Bad set or file')
        const folder = resolve(showcaseDir, set)
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          mkdirSync(folder, { recursive: true })
          if (req.method === 'PUT' && /\.(jpg|json)$/i.test(file)) {
            writeFileSync(resolve(folder, file), body)
            return res.end('ok')
          }
          if (req.method === 'POST' && file === 'finish') {
            const keep = new Set<string>(JSON.parse(body.toString() || '[]'))
            for (const name of readdirSync(folder)) if (!keep.has(name)) rmSync(resolve(folder, name))
            // Every published set, for the site to list
            const sets = readdirSync(showcaseDir, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && existsSync(resolve(showcaseDir, entry.name, 'showcase.json')))
              .map((entry) => {
                const list = JSON.parse(readFileSync(resolve(showcaseDir, entry.name, 'showcase.json'), 'utf-8'))
                return { set: entry.name, title: list.title, cards: list.cards.length }
              })
            writeFileSync(resolve(showcaseDir, 'index.json'), JSON.stringify(sets, null, 2))
            return res.end('ok')
          }
          fail(405, 'Not allowed')
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Relative, so the built site works from any folder: GitHub Pages serves it from /<repo>/
  base: './',
  plugins: [react(), artList(), publishSets()],
})
