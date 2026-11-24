# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This repo is a rebuild of JarrVis (https://github.com/dhwanidesai/JarrVis; preprint: https://www.biorxiv.org/content/10.1101/2025.04.13.648596v1). JarrVis visualizes stratified microbiome function tables (sample groups → taxa → functions). **Read `PLAN.md` before starting work**: it has the scope, the architecture and the order of the first prompts. The app (Vite + Svelte 5 + TypeScript + DuckDB-WASM) loads a 4-column stratified table and a sample metadata file, validates both and checks that their sample IDs match. It then shows a function × group heatmap (ECharts) and a groups → taxa → functions Sankey with click-to-highlight. Clicking a function in either drives a stacked bar of the taxa behind it (per group or per sample, absolute or relative) and a grouped table that filters to that function. Both follow shared settings: group-by column, taxonomic level, and mean or total.

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
- `src/lib/validate.ts`: the version-1 input contract. Both files are loaded as all-text tables (`strat_raw`, `metadata_raw`, via `loadTable(..., { allVarchar: true })`), so IDs keep leading zeros. `validateStratified` and `validateMetadata` return `Issue`s, with severity `error` (blocks use), `warning` or `info`. Only when there are no errors do they build the clean tables that views should query:
  - `strat(sample, taxon, function, contribution DOUBLE)`: text trimmed, empty taxa become `unclassified`, rows with an empty or NA contribution are dropped.
  - `metadata(sample_id, <group columns>)`: the first column is renamed to `sample_id`.
  A failed validation drops the old clean table. `crossCheck` compares sample IDs between the two tables. The table is read by column position, not by header name. Known other formats (PICRUSt2 contrib, legacy, or wide; HUMAnN) are recognized and get an explanatory error.
- `src/lib/aggregate.ts`:
  - `buildTaxonomy` splits each distinct taxon in `strat` into ranks, stored in the `taxonomy` table. Ranks are found by their `k__`/`d__`…`s__` prefix, not by position. It handles `;` and `|` separators and HUMAnN's `g__X.s__Y`, and treats `NA`/`unclassified`/empty as unassigned. It returns the ranks present in the data.
  - `groupTable` builds the `grouped` table (group × collapsed taxon × function). **Mean is the group total divided by the number of samples in the group that have data**, so an absent row counts as zero. Samples with no group value, or with no data, are left out.
  - Collapsed taxa are grouped by their full rank path, so homonyms stay separate. They're labelled with the rank name or "Unclassified <nearest known parent>".
- `functionHeatmap` (also in `aggregate.ts`): function × group values summed over all taxa, ranked by the sum of group values and cut to the top N, with optional case-insensitive search. Both it and `groupTable` build on `groupCtes()`, so group membership and sample counts are defined in one place.
- `taxaForFunction` (also in `aggregate.ts`): per-taxon contributions to one function, per group or per sample. The top 8 taxa are shown and the rest folded into Other. Taxa are ranked by their group values in both modes, so the set and its colours don't change when switching modes.
- `sankeyData` (also in `aggregate.ts`): links for the given functions. Group→taxon links are summed over the functions and taxon→function links over the groups, so flow balances at each taxon. It also returns the full `flows` (group × taxon × function), so a highlighted group or function can draw just its own share of each link. Each such link is split into a highlighted part and a faded remainder, which keeps the layout fixed. Node ids carry `g:`/`t:`/`f:` prefixes because names can repeat across columns.
- View order on the page is heatmap → Sankey → stacked bar → table. Selecting something only changes views below it, so the page doesn't jump.
- `src/lib/view.svelte.ts`: the shared view state (`groupBy`, `level`, `stat`, the selected `fn`, and heatmap `search`/`top`/`scale`). Views bind to it and re-query when it changes. Selecting a function in one view sets `view.fn` for all of them. Keep it plain and serializable.
- `src/components/ViewControls.svelte`: the sticky toolbar for settings shared by every view. Settings for a single view stay in that view.
- `src/lib/echarts.ts`: modular ECharts imports (register new chart types there), `initChart()` (SVG renderer, so exports are vector) and `chartTheme(dark)`, which uses fixed light/dark colour tokens mirroring the CSS ones. With the SVG renderer, category axes with many labels need `interval: 0` or ECharts hides some. Sequential colour is one blue ramp, light to dark on a light background and reversed on dark. Cells have a 2 px border in the surface colour. Charts re-render when `prefers-color-scheme` changes.
  - Categorical colour uses 8 fixed, CVD-validated slots, assigned by slot and never cycled (`MAX_SERIES`). Anything past slot 8 folds into a neutral "Other".
  - Legends with many entries are HTML, not ECharts legends, so they wrap instead of paging. Text uses text tokens, never series colours.
- Export: each view has `ExportButtons` (SVG, PNG, TSV; the table is TSV only). `src/lib/chartExport.ts` `saveChart` re-renders the chart in light colours, takes `renderToSVGString()`, restores the on-screen theme, and wraps it with `composeSvg` from `src/lib/export.ts` (white background, plus any HTML legend redrawn as SVG, as the stacked bar does). PNG is that SVG rasterized at 3×. TSVs hold the full summary behind each view, not just what's drawn.
- `src/App.svelte` / `src/components/InputPanel.svelte`: one panel per input file. Loading a file reruns that file's validation and then `crossCheck`.
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
