<script lang="ts">
  import { getSql } from '../lib/db'
  import { groupTable, LEVEL_LABELS, type GroupedResult, type Level } from '../lib/aggregate'
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

  const valueLabel = $derived(view.stat === 'mean' ? 'Mean per sample' : 'Total')
</script>

<section class="grouped" aria-busy={busy}>
  <div class="head">
    <h2>
      {#if view.fn}Taxa contributing to <span class="fn">{view.fn}</span>{:else}Contributions by group, taxon and function{/if}
    </h2>
    {#if view.fn}
      <button type="button" onclick={() => (view.fn = null)}>Show all functions</button>
    {/if}
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
            <th>{LEVEL_LABELS[view.level]}</th>
            <th>Function</th>
            <th class="num">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {#each result.rows as row}
            <tr>
              <td>{row.group}</td>
              <td title={row.path}>{row.taxon}</td>
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
  td:nth-child(2) {
    cursor: help;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
