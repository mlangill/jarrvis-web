<script lang="ts">
  import FileDrop from './components/FileDrop.svelte'
  import PreviewTable from './components/PreviewTable.svelte'
  import { duckdbVersion, getSql } from './lib/db'
  import { LoadError, loadTable, previewRows, type LoadedTable } from './lib/load'

  const PREVIEW_LIMIT = 100

  const version = duckdbVersion()

  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

  let loading = $state<string | null>(null)
  let error = $state<string | null>(null)
  let table = $state<LoadedTable | null>(null)
  let rows = $state<Record<string, unknown>[]>([])

  async function onfile(file: File) {
    loading = file.name
    error = null
    try {
      const sql = await getSql()
      const loaded = await loadTable(sql, file.name, file)
      rows = await previewRows(sql, PREVIEW_LIMIT)
      table = loaded
    } catch (err) {
      if (err instanceof LoadError) {
        error = err.message
      } else {
        error = `Something went wrong: ${err instanceof Error ? err.message : err}`
        console.error(err)
      }
    } finally {
      loading = null
    }
  }
</script>

<main>
  <header>
    <h1>JarrVis</h1>
    <p>Stratified microbiome function explorer. Runs entirely in your browser.</p>
  </header>

  <FileDrop {onfile} disabled={loading !== null} />

  <p class="status" role="status">
    {#if loading}
      Loading {loading}…
    {:else}
      {#await version}
        Starting DuckDB…
      {:then v}
        DuckDB {v} ready.
      {:catch err}
        DuckDB failed to start: {err.message}
      {/await}
    {/if}
  </p>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if table}
    <section>
      <h2>{table.fileName}</h2>
      <p class="summary">
        {plural(table.rowCount, 'row')} · {plural(table.columns.length, 'column')}
        {#if table.rowCount > rows.length}· showing first {rows.length}{/if}
      </p>
      <PreviewTable columns={table.columns} {rows} />
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 2rem 16px;
  }
  header p {
    margin-top: 0;
    color: var(--muted);
  }
  .status {
    font-family: var(--mono);
    font-size: 0.85rem;
    color: var(--muted);
  }
  .error {
    padding: 0.75rem 1rem;
    border-radius: 6px;
    background: var(--error-bg);
    color: var(--error);
  }
  h2 {
    margin-bottom: 0;
    font-size: 1.2rem;
    overflow-wrap: anywhere;
  }
  .summary {
    margin-top: 0.25rem;
    color: var(--muted);
  }
</style>
