# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repo is a rebuild of JarrVis (https://github.com/dhwanidesai/JarrVis; preprint: https://www.biorxiv.org/content/10.1101/2025.04.13.648596v1). JarrVis visualizes stratified microbiome function tables (sample groups → taxa → functions). **Read `PLAN.md` before starting work**: it has the scope, the architecture and the order of the first prompts. The app (Vite + Svelte 5 + TypeScript + DuckDB-WASM) can load a TSV, CSV or TXT file (optionally gzipped) into DuckDB and preview it.

## Commands

- `npm run dev`: dev server on http://localhost:5173 (`.claude/launch.json` defines `dev` and `preview` for the browser pane)
- `npm test`: Vitest, run once. Run one file with `npx vitest run src/lib/load.test.ts`, or one test with `-t "<name>"`.
- `npm run check`: type-check (svelte-check for the app, tsc for `vite.config.ts` and for the tests via `tsconfig.test.json`). CI runs this before building.
- `npm run build`: production build to `dist/`
- `npm run preview`: serve the built `dist/`

Pushing to `main` runs `.github/workflows/deploy.yml`, which checks, builds and deploys to GitHub Pages.

## Code layout

- `src/lib/sql.ts`: the `Sql` interface (`query`, `registerFile`, `dropFile`) that all data-layer code takes as a parameter. Write data logic against it, never against DuckDB-WASM directly, so it stays testable in Node.
- `src/test/nodeSql.ts`: the `Sql` implementation for tests. It uses DuckDB-WASM's synchronous Node build (`duckdb-node-blocking.cjs`), so tests run the same engine and SQL as the browser. The async Node worker build doesn't load, so don't switch to it. Tests register files as byte buffers only.
- `src/lib/load.ts`: `loadTable` reads a file into `input_table`. Calls are queued so they run one at a time. `.txt` files are read as tab-separated first, and DuckDB guesses the delimiter only if that yields one column (its guess picks `;` on taxonomy strings). A `.gz` file that is not actually gzipped is read as plain text. It loads into a staging table first and only swaps it in once it passes checks, so a rejected file leaves the previous table intact. Problems the user should see are thrown as `LoadError`. The file is registered under a generated name (keeping the extension, so DuckDB detects `.gz`), and that name is replaced with the user's file name in error messages.
- `src/lib/db.ts`: the one shared DuckDB instance (`getDb()`) and the browser `Sql` (`getSql()`). Browser `File`s are registered with `BROWSER_FILEREADER`, so large files are read lazily instead of copied into memory. The wasm and worker bundles are imported with `?url`, so Vite serves them from this site rather than a CDN. Don't switch to the jsDelivr bundles.
- `vite.config.ts`: `base: './'` keeps asset paths relative, so the build works under the Pages subpath `/jarrvis-web/`. `@duckdb/duckdb-wasm` is excluded from `optimizeDeps`.

## Hard constraints

- **Static, client-side only.** The app is hosted on GitHub Pages. There is no server and no backend, and user data must never leave the browser. Don't add network calls that upload data, or any server-side processing.
- **DuckDB-WASM is the single data engine.** The full table is loaded once into DuckDB. Filtering, grouping, taxonomic collapsing and top-N happen in SQL. Only a capped summary (top N taxa/functions) is passed to the charts, never the raw table, because inputs can be hundreds of MB.

## Planned architecture

- Stack: Vite + TypeScript, a light UI framework (Svelte is the likely choice), Apache ECharts for the Sankey (fall back to D3 + d3-sankey only if custom interactions need it), and a GitHub Actions workflow that deploys to Pages.
- **Linked views over one shared state.** Filters and selections (groups, taxa, functions, thresholds, taxonomic level, mean vs sum, relative vs absolute) live in one store. Each view is just a query on DuckDB plus a chart: the heatmap (the main entry point), stacked bar, Sankey and data table. Selecting something in any view updates all the others. A new view should only need a new query and renderer, not new data plumbing.
- View state must be serializable (JSON / URL), because saving and reloading views is a planned feature. Keep state plain and free of derived data.
- Inputs: version 1 takes the custom 4-column stratified format plus a metadata file. Direct PICRUSt2, HUMAnN and Microbiome Helper input comes later. Validation must give clear messages for malformed files and for sample IDs that don't match between the table and the metadata.
- The data layer is the foundation every view depends on, so give it tests early.

## Test data

`test-data/README.md` lists each file, where it came from and its format. `scripts/fetch-test-data.sh` downloads them all again. `test-data/large/` is gitignored: it holds the full 229k-row TSD file from the original JarrVis repo and is absent on a fresh clone or in CI, so tests must not depend on it. `src/lib/load.testdata.test.ts` loads the committed files. The Bedford Basin PICRUSt2 and IBD HUMAnN2 datasets from the preprint aren't here yet.

In dev, Vite serves `.gz` files with `Content-Encoding: gzip`, so `fetch('/test-data/x.gz')` returns already-decompressed bytes. To test real gzip handling in the browser, use the file picker, not fetch.

## Workflow

The developer previews changes live in a browser via the dev server. Keep each change small and verify it in the browser before moving on. Commit after every working step.
