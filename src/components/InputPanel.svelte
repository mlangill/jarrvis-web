<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Column } from '../lib/load'
  import type { Issue } from '../lib/validate'
  import FileDrop from './FileDrop.svelte'
  import Issues from './Issues.svelte'
  import PreviewTable from './PreviewTable.svelte'

  export interface PanelState {
    loading: string | null
    fileName: string | null
    summary: string | null
    issues: Issue[]
    columns: Column[]
    rows: Record<string, unknown>[]
  }

  let {
    title,
    description,
    label,
    panel,
    onfile,
    children,
  }: {
    title: string
    description: string
    label: string
    panel: PanelState
    onfile: (file: File) => void
    /** Extra controls shown above the file picker. */
    children?: Snippet
  } = $props()

  const ok = $derived(panel.fileName !== null && panel.summary !== null)
</script>

<section class="panel" class:ok>
  <h2>{title}</h2>
  <p class="desc">{description}</p>
  {@render children?.()}
  <FileDrop {onfile} {label} disabled={panel.loading !== null} />

  {#if panel.loading}
    <p class="file">Loading {panel.loading}…</p>
  {:else if panel.fileName}
    <p class="file">
      <span class="name">{panel.fileName}</span>
      {#if panel.summary}<span class="summary">{panel.summary}</span>{/if}
    </p>
  {/if}

  <Issues issues={panel.issues} />

  {#if panel.rows.length > 0 && !panel.loading}
    <details>
      <summary>Preview first {panel.rows.length} rows</summary>
      <PreviewTable columns={panel.columns} rows={panel.rows} />
    </details>
  {/if}
</section>

<style>
  .panel {
    min-width: 0;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .ok {
    border-color: var(--ok);
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .desc {
    margin: 0.25rem 0 0.75rem;
    font-size: 0.9rem;
    color: var(--muted);
  }
  .file {
    margin: 0.75rem 0 0;
    font-size: 0.9rem;
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .summary {
    display: block;
    color: var(--muted);
  }
  details {
    margin-top: 0.75rem;
  }
  summary {
    cursor: pointer;
    font-size: 0.9rem;
    margin-bottom: 0.5rem;
  }
</style>
