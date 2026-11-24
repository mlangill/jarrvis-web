<script lang="ts">
  import { onMount } from 'svelte'
  import { functionHeatmap, type HeatmapResult } from '../lib/aggregate'
  import { getSql } from '../lib/db'
  import { chartTheme, echarts } from '../lib/echarts'
  import { view, type HeatScale } from '../lib/view.svelte'

  let { dataVersion }: { dataVersion: number } = $props()

  const fmt = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 })
  const TOPS = [25, 50, 100, 200]
  const ROW = 22

  let result = $state<HeatmapResult | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)
  let dark = $state(false)
  let el: HTMLDivElement
  let chart: echarts.ECharts | null = null
  let request = 0
  let searchInput = $state(view.search)
  let searchTimer: ReturnType<typeof setTimeout>

  // Query whenever the inputs change.
  $effect(() => {
    const opts = { groupBy: view.groupBy, stat: view.stat, search: view.search, top: view.top }
    void dataVersion
    if (!opts.groupBy) return
    const mine = ++request
    busy = true
    ;(async () => {
      try {
        const r = await functionHeatmap(await getSql(), { ...opts, groupBy: opts.groupBy! })
        if (mine === request) [result, error] = [r, null]
      } catch (err) {
        if (mine === request) error = err instanceof Error ? err.message : String(err)
        console.error(err)
      } finally {
        if (mine === request) busy = false
      }
    })()
  })

  function onSearch() {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => (view.search = searchInput), 250)
  }

  /** The value used for color under each scale, plus the color-bar range and label. */
  function colorValues(r: HeatmapResult, scale: HeatScale) {
    if (scale === 'row') {
      const cv = r.values.map((row) => {
        const max = Math.max(...row)
        return row.map((v) => (max > 0 ? v / max : 0))
      })
      return { cv, min: 0, max: 1, label: (x: number) => `${Math.round(x * 100)}%`, caption: 'Share of the function’s highest group' }
    }
    if (scale === 'log') {
      const cv = r.values.map((row) => row.map((v) => Math.log10(1 + Math.max(0, v))))
      const max = Math.max(0.001, ...cv.flat())
      // Start the colors at the smallest non-zero value so the top functions don't all look alike.
      const min = Math.min(max, ...cv.flat().filter((x) => x > 0))
      return { cv, min: min < max ? min : 0, max, label: (x: number) => fmt.format(10 ** x - 1), caption: 'Log scale' }
    }
    const max = Math.max(0.001, ...r.values.flat())
    return { cv: r.values, min: 0, max, label: (x: number) => fmt.format(x), caption: 'Linear scale' }
  }

  function render() {
    if (!chart || !result || result.functions.length === 0) return
    const r = result
    const t = chartTheme(dark)
    const { cv, min, max, label, caption } = colorValues(r, view.scale)
    const selected = view.fn
    const valueName = view.stat === 'mean' ? 'Mean per sample' : 'Total'

    const data = r.functions.flatMap((f, fi) =>
      r.groups.map((_, gi) => {
        const item: Record<string, unknown> = { value: [gi, fi, cv[fi][gi], r.values[fi][gi]] }
        if (f === selected) item.itemStyle = { borderColor: t.text, borderWidth: 2 }
        return item
      }),
    )

    chart.setOption(
      {
        animation: false,
        backgroundColor: 'transparent',
        textStyle: { fontFamily: 'system-ui, sans-serif', color: t.text },
        grid: { top: 36, right: 16, bottom: 56, left: 8, containLabel: true },
        tooltip: {
          backgroundColor: t.surface,
          borderColor: t.border,
          textStyle: { color: t.text, fontSize: 12 },
          formatter: (p: { value: [number, number, number, number] }) => {
            const [gi, fi, , raw] = p.value
            const g = r.groups[gi]
            return `<strong>${escape(r.functions[fi])}</strong><br>${escape(g.name)} (${g.samples} ${
              g.samples === 1 ? 'sample' : 'samples'
            })<br>${valueName}: <strong>${fmt.format(raw)}</strong>`
          },
        },
        xAxis: {
          type: 'category',
          position: 'top',
          data: r.groups.map((g) => g.name),
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: t.text, fontSize: 12, interval: 0 },
          splitArea: { show: false },
        },
        yAxis: {
          type: 'category',
          inverse: true,
          data: r.functions,
          axisLine: { show: false },
          axisTick: { show: false },
          triggerEvent: true,
          axisLabel: {
            color: t.muted,
            fontSize: 11,
            width: 220,
            overflow: 'truncate',
            formatter: (v: string) => (v === selected ? `{sel|${v}}` : v),
            rich: { sel: { color: t.text, fontWeight: 'bold', fontSize: 11 } },
          },
        },
        visualMap: {
          min,
          max,
          dimension: 2,
          calculable: false,
          orient: 'horizontal',
          left: 'center',
          bottom: 4,
          itemWidth: 12,
          itemHeight: 160,
          text: [label(max), `${label(min)}   ${caption}`],
          textStyle: { color: t.muted, fontSize: 11 },
          inRange: { color: t.sequential },
        },
        series: [
          {
            type: 'heatmap',
            data,
            itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 2 },
            emphasis: { itemStyle: { borderColor: t.text, borderWidth: 1 } },
          },
        ],
      },
      { notMerge: true },
    )
    chart.resize()
  }

  function escape(s: string) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  }

  onMount(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    dark = mq.matches
    const onScheme = () => (dark = mq.matches)
    mq.addEventListener('change', onScheme)
    chart = echarts.init(el)
    chart.on('click', (p) => {
      const fn =
        p.componentType === 'yAxis'
          ? String((p as unknown as { value: string }).value)
          : result?.functions[(p.value as number[])[1]]
      if (fn) view.fn = view.fn === fn ? null : fn
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

  // Redraw when the data, scale, selection or color scheme changes.
  $effect(() => {
    void [result, view.scale, view.fn, view.stat, dark]
    render()
  })

  const height = $derived(result ? Math.max(160, result.functions.length * ROW + 100) : 160)
  // Cap each group's column so a few groups don't stretch into long bars.
  const width = $derived(result ? `min(100%, ${300 + result.groups.length * 120}px)` : '100%')
</script>

<section class="heatmap" aria-busy={busy}>
  <h2>Functions by group</h2>
  <p class="desc">Click a function to see which taxa contribute to it.</p>

  <div class="controls">
    <label>
      Search functions
      <input type="search" bind:value={searchInput} oninput={onSearch} placeholder="e.g. EC:2.1 or K00" />
    </label>
    <label>
      Show
      <select bind:value={view.top}>
        {#each TOPS as n}<option value={n}>Top {n}</option>{/each}
      </select>
    </label>
    <label>
      Color
      <select bind:value={view.scale}>
        <option value="log">Value, log scale</option>
        <option value="linear">Value, linear scale</option>
        <option value="row">Relative within each function</option>
      </select>
    </label>
  </div>

  {#if error}
    <p class="error" role="alert">Couldn't build the heatmap: {error}</p>
  {:else if result}
    <p class="note">
      {#if result.functions.length === 0}
        No functions match "{view.search}".
      {:else}
        {result.matchingFunctions.toLocaleString()}
        {view.search ? `functions match "${view.search}"` : 'functions'}{#if result.matchingFunctions > result.functions.length}; showing the {result.functions.length} with the highest values{/if}.
        {view.stat === 'mean' ? 'Mean per sample in each group' : 'Total per group'}, summed over all taxa.
      {/if}
    </p>
  {/if}

  <div
    class="chart"
    class:hidden={!result || result.functions.length === 0}
    bind:this={el}
    style:height="{height}px"
    style:width={width}
    role="img"
    aria-label="Heatmap of function contributions by sample group"
  ></div>
</section>

<style>
  .heatmap {
    margin-top: 1rem;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
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
    gap: 0.75rem 1.25rem;
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
