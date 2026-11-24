<script lang="ts">
  import { getSql } from '../lib/db'
  import { groupedRows, groupTable, higherRanks, LEVEL_LABELS, RANKS, type GroupedResult, type Level } from '../lib/aggregate'
  import { download, safeFileName, toTsv } from '../lib/export'
  import ExportButtons from './ExportButtons.svelte'
  import { view } from '../lib/view.svelte'

  let { levels, dataVersion }: { levels: Level[]; dataVersion: number } = $props()

  const LIMIT = 200
  const fmt = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 })

  let result = $state<GroupedResult | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)
  let request = 0

  $effect(() => {
    const opts = { groupBy: view.groupBy, level: view.level, stat: view.stat, fn: view.fn }
    void dataVersion
    if (!opts.groupBy) return
    const mine = ++request
    busy = true
    ;(async () => {
      try {
        const r = await groupTable(await getSql(), { ...opts, groupBy: opts.groupBy!, limit: LIMIT })
        if (mine === request) {
          result = r
          error = null
        }
      } catch (err) {
        if (mine === request) error = err instanceof Error ? err.message : String(err)
        console.error(err)
      } finally {
        if (mine === request) busy = false
      }
    })()
  })

  async function onexport() {
    const rows = await groupedRows(await getSql())
    const level = view.level
    // The export always has a column per higher rank, whether or not the table shows them.
    const above = shownRanks(true)
    const header = ['group', ...above, level, 'lineage', 'function', view.stat === 'mean' ? 'mean_per_sample' : 'total']
    const name = `table-${view.groupBy}-${view.level}-${view.stat}${view.fn ? `-${view.fn}` : ''}`
    const body = rows.map((r) => {
      const hr = new Map(higherRanks(level, r.ranks).map((h) => [h.rank, h.value ?? '']))
      return [r.group, ...above.map((k) => hr.get(k) ?? ''), r.taxon, r.path, r.function, r.value]
    })
    download(toTsv(header, body), `${safeFileName(`jarrvis-${name}`)}.tsv`)
  }

  /** Ranks above the current level that the data has, highest first (none for 'taxon' or when off). */
  function shownRanks(on: boolean) {
    if (!on || view.level === 'taxon') return []
    const upTo = RANKS.findIndex((r) => r.key === view.level)
    return RANKS.slice(0, upTo).map((r) => r.key).filter((k) => levels.includes(k))
  }

  const valueLabel = $derived(view.stat === 'mean' ? 'Mean per sample' : 'Total')
  const rankCols = $derived(shownRanks(view.tableRanks))
</script>

<section class="grouped" aria-busy={busy}>
  <div class="head">
    <h2>
      {#if view.fn}Table: <span class="fn">{view.fn}</span> by group and taxon{:else}Table: contributions by group, taxon and function{/if}
    </h2>
    <div class="actions">
      {#if view.level !== 'taxon'}
        <label class="check">
          <input type="checkbox" bind:checked={view.tableRanks} />
          Show higher ranks
        </label>
      {/if}
      {#if view.fn}
        <button type="button" onclick={() => (view.fn = null)}>Show all functions</button>
      {/if}
      <ExportButtons {onexport} formats={['tsv']} disabled={!result} />
    </div>
  </div>

  {#if error}
    <p class="error" role="alert">Couldn't build the table: {error}</p>
  {:else if result}
    <p class="groups">
      {#each result.groups as g}
        <span class="chip">{g.name} · {g.samples} {g.samples === 1 ? 'sample' : 'samples'}</span>
      {/each}
    </p>
    {#if result.ungroupedSamples > 0}
      <p class="note">
        {result.ungroupedSamples}
        {result.ungroupedSamples === 1 ? 'sample has' : 'samples have'} no value for "{view.groupBy}" and
        {result.ungroupedSamples === 1 ? 'is' : 'are'} left out.
      </p>
    {/if}
    {#if levels.length === 1}
      <p class="note">No rank prefixes (like p__ or g__) were found in the taxa, so they can't be collapsed.</p>
    {/if}
    <p class="note">
      {result.totalRows.toLocaleString()} {view.fn ? 'group × taxon' : 'group × taxon × function'} rows{#if result.totalRows > result.rows.length}; showing the {result.rows.length} largest{/if}.
    </p>

    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Group</th>
            {#each rankCols as k}<th class="rank">{LEVEL_LABELS[k]}</th>{/each}
            <th>{LEVEL_LABELS[view.level]}</th>
            <th>Function</th>
            <th class="num">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {#each result.rows as row}
            <tr>
              <td>{row.group}</td>
              {#if rankCols.length > 0}
                {@const hr = new Map(higherRanks(view.level, row.ranks).map((h) => [h.rank, h.value]))}
                {#each rankCols as k}
                  {@const v = hr.get(k)}
                  <td class="rank" class:unassigned={!v}>{v ?? '—'}</td>
                {/each}
              {/if}
              <td class="taxon" title={row.path}>{row.taxon}</td>
              <td>{row.function}</td>
              <td class="num">{fmt.format(row.value)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .grouped {
    margin-top: 1rem;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }
  .fn {
    font-family: var(--mono);
    font-size: 1rem;
  }
  button {
    font: inherit;
    font-size: 0.85rem;
    color: var(--accent);
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .groups {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 1rem 0 0.25rem;
  }
  .chip {
    font-size: 0.85rem;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    background: var(--accent-bg);
  }
  .note {
    margin: 0.25rem 0;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .error {
    color: var(--error);
  }
  [aria-busy='true'] .scroll {
    opacity: 0.6;
  }
  .scroll {
    margin-top: 0.5rem;
    overflow: auto;
    max-height: 70vh;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  table {
    border-collapse: collapse;
    font-size: 0.85rem;
    width: 100%;
  }
  th,
  td {
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid var(--border);
    text-align: left;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--bg);
    white-space: nowrap;
  }
  td.taxon {
    cursor: help;
  }
  /* Higher ranks are context for the taxon column, so they recede. */
  .rank {
    color: var(--muted);
  }
  .unassigned {
    opacity: 0.6;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
