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

## Status (Nov 24, 2026)

Live at https://morganlangille.com/jarrvis-web/. The first prompts and most of version 1 are done; details of how each piece works are in `CLAUDE.md` and `docs/design.html` (the app's About page).

### Done

- Inputs: 4-column JarrVis format, PICRUSt2 contrib, legacy contrib and wide stratified, HUMAnN 2/3 stratified, auto-detected with a Format menu to override. Metadata file with any number of group columns. Optional taxonomy file (QIIME 2 `taxonomy.tsv`, DADA2 rank columns or a plain lineage) mapping sequence IDs to lineages. Validation messages and sample ID cross-checks for all of them. Tested by hand on real PICRUSt2 output with its QIIME 2 taxonomy (`test-data/picrust2/chemerin/`), which collapses correctly.
- Shared settings: group-by column, taxonomic level (phylum to species, by rank prefix), mean or total, function search, ranking by highest total or largest difference between groups.
- Views, in page order: Sankey (click-to-highlight, draggable nodes, 4 to 30 taxa, choice of function count), stacked bar for the selected function (per group or per sample, absolute or relative), heatmap with a difference column, grouped table (optional higher-rank columns).
- Export: SVG and PNG of each chart, TSV of the full summary behind each view.
- Demo button loading the full TSD dataset; About page from `docs/design.html`; GitHub Pages deploy with check, test and build in CI.

### Not done yet

- Saved views and shareable URLs (designed below, not started)
- PDF export
- Contribution threshold and prevalence filters (only top N exists); abundance range filter from the original
- Choosing which samples or groups to include, and reordering groups (e.g. months)
- Searching and picking individual taxa; picking individual functions for the Sankey beyond search and top N
- Locking a highlight and side-by-side comparison of two groups
- Microbiome Helper input
- Testing on the Bedford Basin PICRUSt2 and IBD HUMAnN2 data from the preprint

### Next: saved views and shareable links (design agreed in outline, decisions open)

A link can't carry data, since nothing is uploaded. It carries only the view state in `src/lib/view.svelte.ts` (plus the input format choice), so the person opening it loads the same files and the screen is restored.

- **Shareable link.** State that differs from the defaults is encoded after `#` in the URL (never sent to any server). Opening a link shows a banner asking for the files (naming the ones it was made with); once they validate, the settings apply. Settings that don't fit the data (a missing group column or function) are skipped with a note. The link carries a light data fingerprint (file names, row and sample counts) to detect different data. A link made on the demo data can load the demo automatically. The app should note next to the button that the link contains names (selected function, search text, group column and group or taxon names), though no data values.
- **Saved views.** "Save view" stores the state under a name in the browser's local storage, with rename, delete and restore. Views made with the currently loaded data (by fingerprint) are listed first. Export and import of views as a small JSON file, for other devices or collaborators.
- **Not saved:** dragged Sankey node positions, scroll position.
- **Decisions still open** (recommendations in brackets):
  1. Update the address bar live as settings change, or only on "Copy link"? [live, using replaceState so back history isn't filled]
  2. Order: link first, then saved views with export and import, each verified and committed separately? [yes]
  3. Should demo links load the example data automatically? [yes]
  4. If the fingerprint differs: warn only, or refuse to apply? [warn only]

## Later

- ~~Direct import of PICRUSt2 and HUMAnN outputs~~ (done)
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
