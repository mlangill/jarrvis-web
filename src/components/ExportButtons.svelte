<script lang="ts">
  type Format = 'svg' | 'png' | 'tsv'

  let {
    onexport,
    formats = ['svg', 'png', 'tsv'],
    disabled = false,
  }: { onexport: (format: Format) => Promise<void> | void; formats?: Format[]; disabled?: boolean } = $props()

  const LABEL: Record<Format, string> = { svg: 'SVG', png: 'PNG', tsv: 'TSV' }
  const TITLE: Record<Format, string> = {
    svg: 'Download the chart as an SVG vector image',
    png: 'Download the chart as a high-resolution PNG',
    tsv: 'Download the data behind this view as tab-separated text',
  }

  let working = $state<Format | null>(null)
  let error = $state<string | null>(null)

  async function run(f: Format) {
    working = f
    error = null
    try {
      await onexport(f)
    } catch (err) {
      error = `Export failed: ${err instanceof Error ? err.message : err}`
      console.error(err)
    } finally {
      working = null
    }
  }
</script>

<div class="export" role="group" aria-label="Download">
  <span class="label">Download</span>
  {#each formats as f}
    <button type="button" title={TITLE[f]} disabled={disabled || working !== null} onclick={() => run(f)}>
      {working === f ? '…' : LABEL[f]}
    </button>
  {/each}
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</div>

<style>
  .export {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
  }
  .label {
    font-size: 0.85rem;
    color: var(--muted);
    margin-right: 0.15rem;
  }
  button {
    font: inherit;
    font-size: 0.8rem;
    min-width: 2.75rem;
    color: var(--accent);
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .error {
    font-size: 0.8rem;
    color: var(--error);
  }
</style>
