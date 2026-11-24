<script lang="ts">
  import { LEVEL_LABELS, type Level } from '../lib/aggregate'
  import type { GroupColumn } from '../lib/validate'
  import { view } from '../lib/view.svelte'

  let { groupColumns, levels }: { groupColumns: GroupColumn[]; levels: Level[] } = $props()

  let searchInput = $state(view.search)
  let searchTimer: ReturnType<typeof setTimeout>
  function onSearch() {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => (view.search = searchInput), 250)
  }
</script>

<!-- Settings shared by every view. -->
  <div class="controls" role="group" aria-label="View settings">
    <label>
      Group samples by
      <select bind:value={view.groupBy}>
        {#each groupColumns as g}
          <option value={g.name}>{g.name} ({g.levels} {g.levels === 1 ? 'group' : 'groups'})</option>
        {/each}
      </select>
    </label>
    <label>
      Taxonomic level
      <select bind:value={view.level}>
        {#each levels as level}
          <option value={level}>{LEVEL_LABELS[level]}</option>
        {/each}
      </select>
    </label>
    <label>
      Value
      <select bind:value={view.stat}>
        <option value="mean">Mean per sample in group</option>
        <option value="sum">Total across group</option>
      </select>
    </label>
    <label>
      Rank functions by
      <select bind:value={view.rank}>
        <option value="total">Highest overall</option>
        <option value="difference">Largest difference between groups</option>
      </select>
    </label>
    <label>
      Search functions
      <input type="search" bind:value={searchInput} oninput={onSearch} placeholder="e.g. EC:2.1 or K00" />
    </label>
  </div>


<style>
  .controls {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.25rem;
    margin-top: 1rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  input,
  select {
    font: inherit;
    font-size: 0.95rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
    max-width: 100%;
  }
</style>
