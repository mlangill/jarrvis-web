import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig, type Plugin } from 'vite'

/**
 * Serves docs/design.html as the app's About page (about.html), wrapped in a full document with a
 * link back to the app. docs/design.html stays page content only, so the same file can also be
 * published on its own.
 */
function aboutPage(): Plugin {
  const source = fileURLToPath(new URL('./docs/design.html', import.meta.url))
  const page = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="./favicon.svg">
<style>
  body { margin: 0; }
  .app-link { max-width: 760px; margin: 0 auto; padding: 1rem max(16px, env(safe-area-inset-left, 0px)) 0; font: 0.95rem system-ui, sans-serif; }
  .app-link a { color: var(--accent); }
</style>
</head>
<body>
<nav class="app-link"><a href="./">← Open JarrVis</a></nav>
${readFileSync(source, 'utf8')}
</body>
</html>
`
  return {
    name: 'about-page',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/about.html') return next()
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(page())
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'about.html', source: page() })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), aboutPage()],
  // Relative asset paths so the build works under a GitHub Pages project path (/jarrvis-web/).
  base: './',
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
})
