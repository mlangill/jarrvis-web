<script lang="ts">
  import type { Issue } from '../lib/validate'

  let { issues }: { issues: Issue[] } = $props()

  const LABEL = { error: 'Error', warning: 'Warning', info: 'Note' } as const
</script>

{#if issues.length > 0}
  <ul class="issues">
    {#each issues as issue}
      <li class={issue.severity} role={issue.severity === 'error' ? 'alert' : undefined}>
        <span class="label">{LABEL[issue.severity]}</span>
        <span class="msg">{issue.message}</span>
        {#if issue.examples?.length}
          <span class="examples">
            {#each issue.examples as ex}<code>{ex}</code>{/each}
          </span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .issues {
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.4rem;
  }
  li {
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    border-left: 4px solid;
    font-size: 0.9rem;
  }
  .error {
    background: var(--error-bg);
    border-color: var(--error);
  }
  .warning {
    background: var(--warning-bg);
    border-color: var(--warning);
  }
  .info {
    background: var(--accent-bg);
    border-color: var(--accent);
  }
  .label {
    font-weight: 600;
    margin-right: 0.35rem;
  }
  .error .label {
    color: var(--error);
  }
  .warning .label {
    color: var(--warning);
  }
  .info .label {
    color: var(--accent);
  }
  .examples {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.35rem;
  }
  code {
    font-family: var(--mono);
    font-size: 0.8rem;
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
    background: var(--bg);
    border: 1px solid var(--border);
    overflow-wrap: anywhere;
  }
</style>
