<script lang="ts">
  import { duckdbVersion } from './lib/db'

  const version = duckdbVersion()
</script>

<main>
  <h1>JarrVis</h1>
  <p>Stratified microbiome function explorer. Runs entirely in your browser.</p>
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
    max-width: 960px;
    margin: 0 auto;
    padding: 2rem 16px;
  }
  .status {
    font-family: var(--mono);
    font-size: 0.9rem;
  }
</style>
