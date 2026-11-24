<script lang="ts">
  import GroupedView from './components/GroupedView.svelte'
  import InputPanel, { type PanelState } from './components/InputPanel.svelte'
  import { buildTaxonomy, type Level } from './lib/aggregate'
  import { view } from './lib/view.svelte'
  import Issues from './components/Issues.svelte'
  import { duckdbVersion, getSql } from './lib/db'
  import { describeTable, LoadError, loadTable, previewRows } from './lib/load'
  import type { Sql } from './lib/sql'
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
      const loaded = await loadTable(sql, file.name, file, { table: rawTable, allVarchar: true })
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
        err instanceof LoadError ? err.message : `Something went wrong: ${err instanceof Error ? err.message : err}`
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
    stratSummary = await loadInto(strat, file, STRAT_RAW, STRAT, validateStratified)
    strat.summary = stratSummary
      ? `${plural(stratSummary.rows, 'row')} · ${plural(stratSummary.samples, 'sample')} · ${plural(stratSummary.taxa, 'taxon', 'taxa')} · ${plural(stratSummary.functions, 'function')}`
      : null
    if (stratSummary) {
      levels = [...(await buildTaxonomy(await getSql())), 'taxon']
      if (!levels.includes(view.level)) view.level = levels.includes('genus') ? 'genus' : levels[0]
    }
    await updateCross()
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

  const ready = $derived(
    stratSummary && metaSummary && cross?.summary && metaSummary.groupColumns.length > 0 ? cross.summary : null,
  )
</script>

<main>
  <header>
    <h1>JarrVis</h1>
    <p>Stratified microbiome function explorer. Runs entirely in your browser; your files never leave your computer.</p>
  </header>

  <div class="inputs">
    <InputPanel
      title="1. Stratified table"
      description="Four columns in this order: sample, taxon, function, contribution. A header line is required."
      label="Choose the table"
      panel={strat}
      onfile={onStrat}
    />
    <InputPanel
      title="2. Sample metadata"
      description="Sample IDs in the first column (e.g. sample_id), then one or more columns to group samples by."
      label="Choose the metadata"
      panel={meta}
      onfile={onMeta}
    />
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
    <GroupedView groupColumns={metaSummary.groupColumns} {levels} {dataVersion} />
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
  header p {
    margin-top: 0;
    color: var(--muted);
  }
  .inputs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
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
