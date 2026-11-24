# JarrVis rebuild plan

Nov 23, 2026 · @Morgan Langille

Rebuild JarrVis as a static web app that runs entirely in the user's browser: drop in a stratified table, slice it interactively, and export publication-ready Sankey plots. No server, no R install, data never leaves the user's machine.

## Keep from the original

- Three-column Sankey: sample groups → taxa → functions
- Datatype agnostic: metagenomic or metatranscriptomic RPKM, PICRUSt2, HUMAnN, genomes
- Group samples by any metadata column; mean contribution per group
- Collapse taxonomy to phylum through species
- Click a node to highlight its paths through all three columns; drag nodes; hover for values
- Abundance range filter to drop low-abundance noise

## Fix from the original

- Input friction: read PICRUSt2, HUMAnN and Microbiome Helper stratified outputs directly, not only the custom 4-column format
- Performance: query the full table in DuckDB-WASM and send only a capped summary (top N taxa and functions) to the chart
- Thresholds: start from data-driven defaults (top N by contribution) rather than a fixed 5 to 10 range
- Export: one-click SVG, PNG and PDF of the plot as arranged, plus the filtered table as TSV
- Reproducibility: save and reload the full view state (filters, grouping, layout) as a small JSON file or a shareable URL
- Robustness: clear validation messages for malformed files and mismatched sample IDs

## Architecture

| Layer | Choice | Why |
| --- | --- | --- |
| Hosting | GitHub Pages (static) | Free, no server to maintain, fits morganlangille.com |
| Data engine | DuckDB-WASM | Fast SQL slicing of hundreds of MB in the browser; reads TSV, CSV, Parquet, gzip |
| Chart | Apache ECharts Sankey to start; D3 + d3-sankey if custom interactions need it | Canvas rendering copes with many ribbons |
| UI | Plain TypeScript with a light framework (e.g. Svelte) | Small, fast, easy to maintain solo |

## Linked views

The Sankey becomes one of several views over the same table. DuckDB holds the data once; filters and selections live in one shared state, and each view is a different query and chart on it. Selecting a pathway, taxon or group in any view updates all the others.

- Heatmap: functions by sample groups, the overview and main entry point
- Stacked bar: taxa contributing to a selected function, per group or per sample
- Sankey: groups → taxa → functions, for presenting a focused selection
- Data table: the filtered rows, sortable and exportable

New views can be added later at little cost, since the data layer is shared.

## Interactions to support

- Choose samples or groups to include; reorder groups (e.g. months in a time series)
- Search and pick functions or pathways; search and pick taxa
- Filter by contribution threshold, top N, prevalence across samples
- Toggle between mean and summed contribution, and relative versus absolute values
- Lock a highlight and compare two groups side by side

## Version 1 scope

1. Load the 4-column format plus metadata; validate and preview
2. Group by a metadata column, collapse to a chosen taxonomic level, filter by function search and top N
3. Render an interactive Sankey with click-to-highlight and hover values
4. Export SVG and PNG
5. Test on the Bedford Basin PICRUSt2 data and the IBD HUMAnN2 data from the preprint

## Getting started with Claude Code

Build on your own laptop, not the server: the app is static, so Claude Code can run a dev server and you see each change live in your browser.

### Setup

1. Install Claude Code on your laptop, following the instructions at docs.claude.com.
2. Create an empty GitHub repo (e.g. `jarrvis-web`, MIT licence) and clone it.
3. Export this doc as Markdown and save it in the repo as `PLAN.md`.
4. Make a `test-data/` folder with the small sample files from the old JarrVis repo, a PICRUSt2 stratified output and one large lab file. Add the large file to `.gitignore`.
5. Open a terminal in the repo, run `claude`, then run `/init` so it writes a `CLAUDE.md` describing the project.

### First prompts, one at a time

1. "Read PLAN.md. Scaffold a Vite + TypeScript app with DuckDB-WASM and a GitHub Actions workflow that deploys to GitHub Pages. No features yet."
2. "Add a file picker that loads a TSV, CSV or gzipped file into DuckDB and shows the row count and first 100 rows."
3. "Validate the 4-column format and the metadata file, and show clear errors for bad input. Test it on the files in test-data/."
4. "Add grouping by a metadata column and collapsing to a chosen taxonomic level, shown as a table."
5. Then the heatmap, the stacked bar and the Sankey, each as its own prompt.

### Habits that help

- Keep each request small, and check it works in the browser before the next one.
- Commit after every working step, so a bad change is one command to undo.
- For bigger changes, ask it to propose a plan first and approve it before it writes code.
- When something breaks, paste the exact error or describe what you see; don't fix it by hand first.
- Ask it to add tests for the data layer early, since every view depends on it.

## Later

- Direct import of PICRUSt2 and HUMAnN outputs
- Saved views and shareable URLs
- Side-by-side comparison mode
- Publish the rebuild and the preprint together

## Open questions

- Largest real dataset to test against, and its size
- Whether to keep the JarrVis name
- Licence and where the repo lives (lab GitHub or personal)

## Sources

- [JarrVis preprint, bioRxiv 2025](https://www.biorxiv.org/content/10.1101/2025.04.13.648596v1)
- [JarrVis GitHub repository](https://github.com/dhwanidesai/JarrVis)
