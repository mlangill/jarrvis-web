<script lang="ts">
  import type { Column } from '../lib/load'

  let { columns, rows }: { columns: Column[]; rows: Record<string, unknown>[] } = $props()

  function show(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return String(value)
  }

  const numeric = (type: string) => /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/.test(type)
</script>

<div class="scroll">
  <table>
    <thead>
      <tr>
        {#each columns as col}
          <th class:num={numeric(col.type)}>
            {col.name}<span class="type">{col.type}</span>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row}
        <tr>
          {#each columns as col}
            <td class:num={numeric(col.type)}>{show(row[col.name])}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .scroll {
    overflow: auto;
    max-height: 60vh;
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
    white-space: nowrap;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--bg);
    font-weight: 600;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .type {
    display: block;
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--muted);
    font-family: var(--mono);
  }
</style>
