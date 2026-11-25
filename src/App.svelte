<script lang="ts">
  import GroupedView from './components/GroupedView.svelte'
  import Heatmap from './components/Heatmap.svelte'
  import Sankey from './components/Sankey.svelte'
  import StackedBar from './components/StackedBar.svelte'
  import ViewControls from './components/ViewControls.svelte'
  import InputPanel, { type PanelState } from './components/InputPanel.svelte'
  import { buildTaxonomy, type Level } from './lib/aggregate'
  import { view } from './lib/view.svelte'
  import Issues from './components/Issues.svelte'
  import { duckdbVersion, getSql } from './lib/db'
  import { describeTable, LoadError, loadTable, previewRows, userMessage } from './lib/load'
  import type { Sql } from './lib/sql'
  import { formatShort, STRAT_FORMATS, type StratFormat } from './lib/formats'
  import {
    dropTaxonomyMap,
    TAXMAP,
    TAXMAP_RAW,
    taxonomyMatch,
    validateTaxonomyMap,
    type TaxMapSummary,
  } from './lib/taxmap'
  import {
    crossCheck,
    META,
    META_RAW,
    STRAT,
    STRAT_RAW,
    validateMetadata,
    validateStratified,
    type CrossSummary,
    type Issue,
    type MetadataSummary,
    type StratifiedSummary,
  } from './lib/validate'

  const PREVIEW_LIMIT = 100

  const version = duckdbVersion()

  const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`

  const emptyPanel = (): PanelState => ({ loading: null, fileName: null, summary: null, issues: [], columns: [], rows: [] })

  let strat = $state(emptyPanel())
  let meta = $state(emptyPanel())
  let stratSummary = $state<StratifiedSummary | null>(null)
  let tax = $state(emptyPanel())
  let taxSummary = $state<TaxMapSummary | null>(null)
  /** The taxonomy file's own issues; the match against the table is added after them. */
  let taxIssues: Issue[] = []
  /** How to read the stratified table; 'auto' detects it from the columns. */
  let stratFormat = $state<StratFormat | 'auto'>('auto')
  /** The last stratified file, so it can be read again when the format changes. */
  let stratFile: File | null = null
  let metaSummary = $state<MetadataSummary | null>(null)
  let cross = $state<{ issues: Issue[]; summary?: CrossSummary } | null>(null)
  /** Taxonomic levels the current table can be collapsed to (always ends with 'taxon'). */
  let levels = $state<Level[]>(['taxon'])
  /** Bumped whenever the clean tables change, so views re-query. */
  let dataVersion = $state(0)

  /** Load a file into `rawTable`, validate it, and fill the panel. Returns the summary if valid. */
  async function loadInto<S>(
    panel: PanelState,
    file: File,
    rawTable: string,
    cleanTable: string,
    validate: (sql: Sql, columns: Awaited<ReturnType<typeof loadTable>>['columns']) => Promise<{ issues: Issue[]; summary?: S }>,
  ): Promise<S | null> {
    Object.assign(panel, { ...emptyPanel(), loading: file.name })
    try {
      const sql = await getSql()
      const loaded = await loadTable(sql, file.name, file, { table: rawTable, allVarchar: true, lazy: rawTable === STRAT_RAW })
      const result = await validate(sql, loaded.columns)
      const shown = result.summary ? cleanTable : rawTable
      Object.assign(panel, {
        fileName: file.name,
        issues: result.issues,
        columns: await describeTable(sql, shown),
        rows: await previewRows(sql, PREVIEW_LIMIT, shown),
      })
      return result.summary ?? null
    } catch (err) {
      const message =
        err instanceof LoadError ? err.message : `Something went wrong: ${userMessage(err)}`
      if (!(err instanceof LoadError)) console.error(err)
      Object.assign(panel, { fileName: file.name, issues: [{ severity: 'error', message }] })
      // Drop any clean table from an earlier file so nothing downstream uses stale data.
      const sql = await getSql()
      await sql.query(`DROP TABLE IF EXISTS ${cleanTable}`)
      return null
    } finally {
      panel.loading = null
    }
  }

  async function updateCross() {
    cross = stratSummary && metaSummary ? await crossCheck(await getSql()) : null
    dataVersion++
  }

  async function onStrat(file: File) {
    stratFile = file
    const format = stratFormat
    stratSummary = await loadInto(strat, file, STRAT_RAW, STRAT, (sql, columns) => validateStratified(sql, columns, format))
    strat.summary = stratSummary
      ? `${formatShort(stratSummary.format)} · ${plural(stratSummary.rows, 'row')} · ${plural(stratSummary.samples, 'sample')} · ${plural(stratSummary.taxa, 'taxon', 'taxa')} · ${plural(stratSummary.functions, 'function')}`
      : null
    view.fn = null
    view.highlight = null
    await refreshTaxonomy()
    await updateCross()
  }

  /** Re-split the table's taxa into ranks (using the taxonomy file, if any) and recheck the match. */
  async function refreshTaxonomy() {
    const sql = await getSql()
    if (stratSummary) {
      levels = [...(await buildTaxonomy(sql)), 'taxon']
      if (!levels.includes(view.level)) view.level = levels.includes('genus') ? 'genus' : levels[0]
    }
    tax.issues = [...taxIssues, ...(stratSummary && taxSummary ? await taxonomyMatch(sql) : [])]
  }

  async function onTax(file: File) {
    taxSummary = await loadInto(tax, file, TAXMAP_RAW, TAXMAP, validateTaxonomyMap)
    taxIssues = tax.issues
    tax.summary = taxSummary ? `${plural(taxSummary.ids, 'ID')} · lineage from ${taxSummary.source}` : null
    const hadRanks = levels.length > 1
    await refreshTaxonomy()
    // Taxa that were bare IDs now have ranks, so start at genus rather than "as given".
    if (!hadRanks && view.level === 'taxon' && levels.includes('genus')) view.level = 'genus'
    dataVersion++
  }

  async function removeTax() {
    await dropTaxonomyMap(await getSql())
    Object.assign(tax, emptyPanel())
    taxSummary = null
    taxIssues = []
    await refreshTaxonomy()
    dataVersion++
  }

  async function onMeta(file: File) {
    metaSummary = await loadInto(meta, file, META_RAW, META, validateMetadata)
    meta.summary = metaSummary
      ? `${plural(metaSummary.samples, 'sample')} · grouping columns: ${
          metaSummary.groupColumns.map((g) => `${g.name} (${g.levels})`).join(', ') || 'none'
        }`
      : null
    const names = metaSummary?.groupColumns.map((g) => g.name) ?? []
    if (!view.groupBy || !names.includes(view.groupBy)) view.groupBy = names[0] ?? null
    await updateCross()
  }

  let demoError = $state<string | null>(null)
  const busy = $derived(strat.loading !== null || meta.loading !== null)

  /** Fetch the example files shipped with the site and load them as if the user had picked them. */
  async function loadDemo() {
    demoError = null
    try {
      const fetchFile = async (name: string) => {
        const res = await fetch(`${import.meta.env.BASE_URL}demo/${name}`)
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
        return new File([await res.blob()], name)
      }
      const [table, metadata] = await Promise.all([fetchFile('TSD-stratified.tsv.gz'), fetchFile('TSD-metadata.tsv')])
      // The example has its lineages in the table, so a taxonomy file from earlier doesn't apply.
      if (taxSummary || tax.fileName) await removeTax()
      stratFormat = 'auto'
      await onStrat(table)
      await onMeta(metadata)
    } catch (err) {
      demoError = `Couldn't load the example data: ${err instanceof Error ? err.message : err}`
    }
  }

  const ready = $derived(
    stratSummary && metaSummary && cross?.summary && metaSummary.groupColumns.length > 0 ? cross.summary : null,
  )
</script>

<main>
  <header>
    <div class="title">
      <h1>JarrVis</h1>
      <!-- A new tab, so following it never loses the files loaded here. -->
      <a href="./about.html" target="_blank" rel="noopener">About and how it works</a>
    </div>
    <p>Stratified microbiome function explorer. Runs entirely in your browser; your files never leave your computer.</p>
  </header>

  <div class="demo">
    <button onclick={loadDemo} disabled={busy}>Try the example data</button>
    <span>
      The TSD metagenomes from the original JarrVis: 10 samples in two groups, Kraken2 taxonomy, 995 EC functions (2 MB
      download).
    </span>
    {#if demoError}<p class="error">{demoError}</p>{/if}
  </div>

  <div class="inputs">
    <InputPanel
      title="1. Stratified table"
      description="The 4-column format (sample, taxon, function, contribution), PICRUSt2 contribution or stratified output, HUMAnN stratified output, or Microbiome Helper 2 stratified output. A header line is required."
      label="Choose the table"
      panel={strat}
      onfile={onStrat}
    >
      <label class="format">
        Format
        <select
          bind:value={stratFormat}
          disabled={strat.loading !== null}
          onchange={() => stratFile && onStrat(stratFile)}
        >
          <option value="auto">Auto-detect</option>
          {#each STRAT_FORMATS as f}<option value={f.key}>{f.label}</option>{/each}
        </select>
      </label>
    </InputPanel>
    <InputPanel
      title="2. Sample metadata"
      description="Sample IDs in the first column (e.g. sample_id), then one or more columns to group samples by."
      label="Choose the metadata"
      panel={meta}
      onfile={onMeta}
    />
    <InputPanel
      title="3. Taxonomy (optional)"
      description="Only needed when the table's taxa are IDs without a lineage, such as PICRUSt2 sequence IDs or Microbiome Helper 2's Kraken names. IDs (or NCBI taxids) in the first column, then a lineage column (a QIIME 2 taxonomy.tsv works) or one column per rank (Kingdom … Species)."
      label="Choose the taxonomy"
      panel={tax}
      onfile={onTax}
    >
      {#if tax.fileName && !tax.loading}
        <button type="button" class="remove" onclick={removeTax}>Remove taxonomy file</button>
      {/if}
    </InputPanel>
  </div>

  {#if cross}
    <section class="cross">
      <h2>Sample IDs</h2>
      {#if ready}
        <p class="ready">
          Ready: {plural(ready.matched, 'sample')} matched between the table and the metadata.
        </p>
      {/if}
      <Issues issues={cross.issues} />
    </section>
  {/if}

  {#if ready && metaSummary}
    <ViewControls groupColumns={metaSummary.groupColumns} {levels} />
    <Sankey {dataVersion} />
    <StackedBar {dataVersion} />
    <Heatmap {dataVersion} />
    <GroupedView {levels} {dataVersion} />
  {/if}

  <p class="status">
    {#await version}
      Starting DuckDB…
    {:then v}
      DuckDB {v} ready.
    {:catch err}
      DuckDB failed to start: {err.message}
    {/await}
  </p>
</main>

<style>
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem 16px;
  }
  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1rem;
  }
  .title a {
    font-size: 0.95rem;
    color: var(--accent);
  }
  header p {
    margin-top: 0;
    color: var(--muted);
  }
  .demo {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.9rem;
    color: var(--muted);
  }
  .demo button {
    font: inherit;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-bg);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 0.35rem 0.8rem;
    cursor: pointer;
  }
  .demo button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .demo .error {
    flex-basis: 100%;
    margin: 0;
    color: var(--error);
  }
  .remove {
    font: inherit;
    font-size: 0.85rem;
    color: var(--accent);
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.25rem 0.6rem;
    margin-bottom: 0.75rem;
    cursor: pointer;
  }
  .format {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin-bottom: 0.75rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .format select {
    font: inherit;
    font-size: 0.9rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
    max-width: 100%;
  }
  .inputs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
    gap: 1rem;
  }
  .cross {
    margin-top: 1rem;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .cross h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .ready {
    margin: 0.5rem 0 0;
    font-weight: 600;
    color: var(--ok);
  }
  .status {
    margin-top: 2rem;
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--muted);
  }
</style>
