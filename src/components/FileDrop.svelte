<script lang="ts">
  let { onfile, disabled = false }: { onfile: (file: File) => void; disabled?: boolean } = $props()

  let dragging = $state(false)
  let input: HTMLInputElement

  function pick(files: FileList | null | undefined) {
    const file = files?.[0]
    if (file) onfile(file)
  }
</script>

<label
  class="drop"
  class:dragging
  class:disabled
  ondragover={(e) => {
    e.preventDefault()
    dragging = true
  }}
  ondragleave={() => (dragging = false)}
  ondrop={(e) => {
    e.preventDefault()
    dragging = false
    if (!disabled) pick(e.dataTransfer?.files)
  }}
>
  <input
    bind:this={input}
    type="file"
    accept=".tsv,.tab,.txt,.csv,.gz"
    {disabled}
    onchange={() => {
      pick(input.files)
      input.value = ''
    }}
  />
  <strong>Choose a file</strong> or drop it here
  <span class="hint">TSV, CSV or TXT, optionally gzipped. The file stays on your computer.</span>
</label>

<style>
  .drop {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 2rem 1rem;
    border: 2px dashed var(--border);
    border-radius: 8px;
    text-align: center;
    cursor: pointer;
  }
  .drop:hover,
  .dragging {
    border-color: var(--accent);
    background: var(--accent-bg);
  }
  .disabled {
    opacity: 0.6;
    cursor: progress;
  }
  input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .drop:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  strong {
    color: var(--accent);
  }
  .hint {
    font-size: 0.85rem;
    color: var(--muted);
  }
</style>
