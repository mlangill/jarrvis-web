<script lang="ts">
  import { onMount } from 'svelte'
  import { functionHeatmap, sankeyData, type SankeyData, type SankeyLink } from '../lib/aggregate'
  import { getSql } from '../lib/db'
  import { chartTheme, initChart, MAX_SERIES, type echarts } from '../lib/echarts'
  import { saveChart, type ChartFormat } from '../lib/chartExport'
  import { download, safeFileName, toTsv } from '../lib/export'
  import ExportButtons from './ExportButtons.svelte'
  import { view } from '../lib/view.svelte'

  let { dataVersion }: { dataVersion: number } = $props()

  const fmt = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 })
  const FUNCTION_COUNTS = [5, 10, 15, 20]
  const TAXA_COUNTS = [4, 6, 8]

  let result = $state<SankeyData | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)
  let dark = $state(false)
  let el: HTMLDivElement
  let chart: echarts.ECharts | null = null
  let request = 0

  $effect(() => {
    const opts = {
      groupBy: view.groupBy,
      level: view.level,
      stat: view.stat,
      search: view.search,
      rank: view.rank,
      n: view.sankeyFunctions,
      topTaxa: Math.min(view.sankeyTaxa, MAX_SERIES),
      fn: view.fn,
    }
    void dataVersion
    if (!opts.groupBy) return
    const mine = ++request
    busy = true
    ;(async () => {
      try {
        const sql = await getSql()
        const top = await functionHeatmap(sql, { groupBy: opts.groupBy!, stat: opts.stat, search: opts.search, top: opts.n, rank: opts.rank })
        // Always include the selected function so it can be highlighted.
        const functions = opts.fn && !top.functions.includes(opts.fn) ? [...top.functions, opts.fn] : top.functions
        const r = await sankeyData(sql, { ...opts, groupBy: opts.groupBy!, functions })
        if (mine === request) {
          ;[result, error] = [r, null]
          // A highlighted group or taxon may not exist after the data or level changes.
          if (view.highlight && !r.nodes.some((n) => n.id === view.highlight)) view.highlight = null
        }
      } catch (err) {
        if (mine === request) error = err instanceof Error ? err.message : String(err)
        console.error(err)
      } finally {
        if (mine === request) busy = false
      }
    })()
  })

  /** Node whose paths are highlighted: a clicked group or taxon, else the selected function. */
  const focus = $derived(view.highlight ?? (view.fn ? `f:${view.fn}` : null))

  interface DrawnLink extends SankeyLink {
    active: boolean
  }

  /**
   * The links to draw for a highlight. A taxon highlights all its links. A group or function
   * highlights only its own share of each link on its paths (e.g. group B's part of a taxon →
   * function link), drawn as a separate highlighted link beside the faded remainder.
   */
  function drawnLinks(r: SankeyData, node: string | null): DrawnLink[] {
    if (!node) return r.links.map((l) => ({ ...l, active: false }))
    if (node.startsWith('t:')) return r.links.map((l) => ({ ...l, active: l.source === node || l.target === node }))
    const mine = r.flows.filter((f) => (node.startsWith('g:') ? f.group : f.fn) === node)
    const share = new Map<string, number>()
    const bump = (s: string, t: string, v: number) => share.set(`${s}\u0001${t}`, (share.get(`${s}\u0001${t}`) ?? 0) + v)
    for (const f of mine) {
      bump(f.group, f.taxon, f.value)
      bump(f.taxon, f.fn, f.value)
    }
    return r.links.flatMap((l) => {
      const part = share.get(`${l.source}\u0001${l.target}`) ?? 0
      const rest = l.value - part
      const out: DrawnLink[] = []
      if (part > 0) out.push({ ...l, value: part, active: true })
      if (rest > l.value * 1e-9) out.push({ ...l, value: rest, active: false })
      return out
    })
  }

  function escape(s: string) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  }

  function render(forExport = false) {
    if (!chart || !result || result.nodes.length === 0) return
    const r = result
    const t = chartTheme(dark && !forExport)
    const byId = new Map(r.nodes.map((n) => [n.id, n]))
    const taxonColor = (id: string) => {
      const slot = byId.get(id)?.colorSlot ?? -1
      return slot >= 0 ? t.categorical[slot] : t.other
    }
    const highlighted = focus && byId.has(focus) ? focus : null
    const links = drawnLinks(r, highlighted)
    const active = highlighted !== null
    const activeNodes = new Set(links.filter((l) => l.active).flatMap((l) => [l.source, l.target]))
    const valueName = view.stat === 'mean' ? 'Mean per sample' : 'Total'

    chart.setOption(
      {
        animation: false,
        backgroundColor: 'transparent',
        textStyle: { fontFamily: 'system-ui, sans-serif', color: t.text },
        tooltip: {
          backgroundColor: t.surface,
          borderColor: t.border,
          textStyle: { color: t.text, fontSize: 12 },
          formatter: (p: { dataType: string; data: { name?: string; source?: string; target?: string }; value: number }) => {
            if (p.dataType === 'edge') {
              const s = byId.get(p.data.source!)!
              const tg = byId.get(p.data.target!)!
              return `${escape(s.label)} → ${escape(tg.label)}<br>${valueName}: <strong>${fmt.format(p.value)}</strong>`
            }
            const n = byId.get(p.data.name!)!
            return `<strong>${escape(n.label)}</strong>${n.title !== n.label ? `<br>${escape(n.title)}` : ''}<br>${valueName}: <strong>${fmt.format(p.value)}</strong>`
          },
        },
        series: [
          {
            type: 'sankey',
            // Room for group labels on the left and function labels on the right, outside the flows.
            left: 72,
            right: 136,
            top: 8,
            bottom: 8,
            nodeWidth: 14,
            nodeGap: 10,
            nodeAlign: 'justify',
            layoutIterations: 0,
            draggable: true,
            emphasis: { disabled: true },
            label: {
              color: t.text,
              fontSize: 12,
              formatter: (p: { name: string }) => byId.get(p.name)?.label ?? p.name,
            },
            data: r.nodes.map((n) => ({
              name: n.id,
              itemStyle: {
                color: n.column === 'taxon' ? taxonColor(n.id) : t.muted,
                borderWidth: 0,
                opacity: active && !activeNodes.has(n.id) ? 0.3 : 1,
              },
              label: {
                position: n.column === 'group' ? 'left' : 'right',
                width: n.column === 'function' ? 128 : n.column === 'group' ? 64 : undefined,
                overflow: 'truncate',
                fontWeight: n.id === focus ? 'bold' : 'normal',
                opacity: active && !activeNodes.has(n.id) ? 0.5 : 1,
              },
            })),
            links: links.map((l) => ({
              source: l.source,
              target: l.target,
              value: l.value,
              lineStyle: {
                color: taxonColor(l.source.startsWith('t:') ? l.source : l.target),
                opacity: active ? (l.active ? 0.65 : 0.06) : 0.35,
                curveness: 0.5,
              },
            })),
          },
        ],
      },
      { notMerge: true },
    )
    chart.resize()
  }

  onMount(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    dark = mq.matches
    const onScheme = () => (dark = mq.matches)
    mq.addEventListener('change', onScheme)
    chart = initChart(el)
    chart.on('click', (p) => {
      if (p.dataType !== 'node') return
      const id = (p.data as { name: string }).name
      if (id.startsWith('f:')) {
        const fn = id.slice(2)
        view.highlight = null
        view.fn = view.fn === fn ? null : fn
      } else {
        view.highlight = view.highlight === id ? null : id
      }
    })
    const ro = new ResizeObserver(() => chart?.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      mq.removeEventListener('change', onScheme)
      chart?.dispose()
      chart = null
    }
  })

  $effect(() => {
    void [result, focus, view.stat, dark]
    render()
  })

  async function onexport(format: ChartFormat | 'tsv') {
    if (!result || !chart) return
    const name = `sankey-${view.groupBy}-${view.level}-${view.stat}`
    if (format === 'tsv') {
      const byId = new Map(result.nodes.map((n) => [n.id, n]))
      const rows = result.flows.map((f) => [
        byId.get(f.group)!.label,
        byId.get(f.taxon)!.label,
        byId.get(f.taxon)!.title,
        byId.get(f.fn)!.label,
        f.value,
      ])
      download(
        toTsv(['group', 'taxon', 'lineage', 'function', view.stat === 'mean' ? 'mean_per_sample' : 'total'], rows),
        `${safeFileName(`jarrvis-${name}`)}.tsv`,
      )
    } else {
      await saveChart(chart, format, name, (forExport) => render(forExport))
    }
  }

  const height = $derived.by(() => {
    if (!result) return 420
    const perColumn = ['group', 'taxon', 'function'].map((c) => result!.nodes.filter((n) => n.column === c).length)
    return Math.max(420, Math.max(...perColumn) * 34 + 40)
  })

  const highlightLabel = $derived(result?.nodes.find((n) => n.id === view.highlight)?.label ?? null)
</script>

<section class="sankey" aria-busy={busy}>
  <div class="head">
    <h2>Groups → taxa → functions</h2>
    <ExportButtons {onexport} disabled={!result || result.nodes.length === 0} />
  </div>
  <p class="desc">
    Click a group, taxon or function to highlight its paths. Drag nodes to rearrange. Functions follow the ranking and search above.
  </p>

  <div class="controls">
    <label>
      Functions
      <select bind:value={view.sankeyFunctions}>
        {#each FUNCTION_COUNTS as n}<option value={n}>Top {n}</option>{/each}
      </select>
    </label>
    <label>
      Taxa
      <select bind:value={view.sankeyTaxa}>
        {#each TAXA_COUNTS as n}<option value={n}>Top {n} + Other</option>{/each}
      </select>
    </label>
    {#if focus}
      <button type="button" onclick={() => ([view.highlight, view.fn] = [null, null])}>
        Clear highlight{highlightLabel ? ` (${highlightLabel})` : view.fn ? ` (${view.fn})` : ''}
      </button>
    {/if}
  </div>

  {#if error}
    <p class="error" role="alert">Couldn't build the Sankey: {error}</p>
  {:else if result && result.nodes.length === 0}
    <p class="note">No functions to show{view.search ? ` for "${view.search}"` : ''}.</p>
  {:else if result}
    <p class="note">
      Functions with {view.rank === 'difference' ? 'the largest difference between groups' : 'the highest values'}. {view.stat === 'mean' ? 'Mean per sample in each group' : 'Total per group'}; link widths are contributions.{#if result.otherTaxa > 0}{' '}{result.otherTaxa} smaller taxa are combined as Other.{/if}
    </p>
  {/if}

  <div
    class="chart"
    class:hidden={!result || result.nodes.length === 0}
    bind:this={el}
    style:height="{height}px"
    role="img"
    aria-label="Sankey diagram of sample groups, taxa and functions"
  ></div>
</section>

<style>
  .sankey {
    margin-top: 1rem;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
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
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.75rem 1.25rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
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
  button {
    font: inherit;
    font-size: 0.85rem;
    color: var(--accent);
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.35rem 0.6rem;
    cursor: pointer;
  }
  .note {
    margin: 0.75rem 0 0.25rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .error {
    color: var(--error);
  }
  .chart {
    width: 100%;
  }
  .hidden {
    display: none;
  }
  [aria-busy='true'] .chart {
    opacity: 0.6;
  }
</style>
