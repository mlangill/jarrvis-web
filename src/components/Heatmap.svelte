<script lang="ts">
  import { onMount } from 'svelte'
  import { functionHeatmap, groupDifference, type HeatmapResult } from '../lib/aggregate'
  import { getSql } from '../lib/db'
  import { chartTheme, initChart, type echarts } from '../lib/echarts'
  import { saveChart, type ChartFormat } from '../lib/chartExport'
  import { download, safeFileName, toTsv } from '../lib/export'
  import ExportButtons from './ExportButtons.svelte'
  import { view, type HeatScale } from '../lib/view.svelte'

  let { dataVersion }: { dataVersion: number } = $props()

  const fmt = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 })
  const TOPS = [25, 50, 100, 200]
  const ROW = 22
  /** Width of the difference column, in px. */
  const DIFF_W = 120
  /** Function labels longer than this are truncated. */
  const LABEL_MAX = 220

  let result = $state<HeatmapResult | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)
  let dark = $state(false)
  let el: HTMLDivElement
  let chart: echarts.ECharts | null = null
  let request = 0

  // Query whenever the inputs change.
  $effect(() => {
    const opts = { groupBy: view.groupBy, stat: view.stat, search: view.search, top: view.top, rank: view.rank }
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

  function render(forExport = false) {
    if (!chart || !result || result.functions.length === 0) return
    const r = result
    const t = chartTheme(dark && !forExport)
    const { cv, min, max, label, caption } = colorValues(r, view.scale)
    const selected = view.fn
    const valueName = view.stat === 'mean' ? 'Mean per sample' : 'Total'
    const diff = groupDifference(r.groups, r.values)
    const sampleCount = (n: number) => `${n} ${n === 1 ? 'sample' : 'samples'}`

    const data = r.functions.flatMap((f, fi) =>
      r.groups.map((_, gi) => {
        const item: Record<string, unknown> = { value: [gi, fi, cv[fi][gi], r.values[fi][gi]] }
        if (f === selected) item.itemStyle = { borderColor: t.text, borderWidth: 2 }
        return item
      }),
    )

    // The difference column: a bar per function, sharing the heatmap's rows.
    const reach = diff ? Math.max(1e-9, ...diff.values.map(Math.abs)) : 1
    const diffBars = diff?.values.map((d, fi) => ({
      value: d,
      itemStyle: {
        color: diff.signed ? (d >= 0 ? t.diverging.pos : t.diverging.neg) : t.sequential[2],
        borderRadius: d >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3],
        ...(r.functions[fi] === selected ? { borderColor: t.text, borderWidth: 1.5 } : {}),
      },
    }))
    const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumSignificantDigits: 2 })

    chart.setOption(
      {
        animation: false,
        backgroundColor: 'transparent',
        textStyle: { fontFamily: 'system-ui, sans-serif', color: t.text },
        // Fixed pixel grids (no containLabel), so the heatmap rows and the difference bars line up.
        grid: [
          { top: 36, right: diff ? DIFF_W + 40 : 16, bottom: 56, left: labelWidth(r.functions) + 16 },
          ...(diff ? [{ top: 36, right: 24, bottom: 56, width: DIFF_W }] : []),
        ],
        tooltip: {
          backgroundColor: t.surface,
          borderColor: t.border,
          textStyle: { color: t.text, fontSize: 12 },
          formatter: (p: { seriesIndex: number; dataIndex: number; value: number | [number, number, number, number] }) => {
            if (p.seriesIndex === 1 && diff) {
              const fi = p.dataIndex
              const { high, low } = diff.extremes[fi]
              const d = diff.values[fi]
              const where =
                d === 0
                  ? 'No difference'
                  : diff.signed
                    ? `Higher in ${escape(r.groups[d > 0 ? 1 : 0].name)}`
                    : `Highest in ${escape(r.groups[high].name)}, lowest in ${escape(r.groups[low].name)}`
              return `<strong>${escape(r.functions[fi])}</strong><br>${escape(diff.label)} (${valueName.toLowerCase()}): <strong>${fmt.format(d)}</strong><br>${where}`
            }
            const [gi, fi, , raw] = p.value as [number, number, number, number]
            const g = r.groups[gi]
            return `<strong>${escape(r.functions[fi])}</strong><br>${escape(g.name)} (${sampleCount(g.samples)})<br>${valueName}: <strong>${fmt.format(raw)}</strong>`
          },
        },
        xAxis: [
          {
            type: 'category',
            position: 'top',
            data: r.groups.map((g) => g.name),
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: { color: t.text, fontSize: 12, interval: 0 },
            splitArea: { show: false },
          },
          ...(diff
            ? [
                {
                  type: 'value',
                  gridIndex: 1,
                  position: 'top',
                  min: diff.signed ? -reach : 0,
                  max: reach,
                  name: diff.label,
                  nameLocation: 'middle',
                  nameGap: 24,
                  nameTextStyle: { color: t.text, fontSize: 12 },
                  axisLine: { show: false },
                  axisTick: { show: false },
                  // Ticks only at the ends and zero.
                  interval: reach,
                  splitLine: { lineStyle: { color: t.border } },
                  axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => compact.format(v) },
                },
              ]
            : []),
        ],
        yAxis: [
          {
            type: 'category',
            inverse: true,
            data: r.functions,
            axisLine: { show: false },
            axisTick: { show: false },
            triggerEvent: true,
            axisLabel: {
              color: t.muted,
              fontSize: 11,
              interval: 0,
              width: LABEL_MAX,
              overflow: 'truncate',
              formatter: (v: string) => (v === selected ? `{sel|${v}}` : v),
              rich: { sel: { color: t.text, fontWeight: 'bold', fontSize: 11 } },
            },
          },
          ...(diff
            ? [
                {
                  type: 'category',
                  gridIndex: 1,
                  inverse: true,
                  data: r.functions,
                  axisLabel: { show: false },
                  axisTick: { show: false },
                  // The zero line.
                  axisLine: { show: true, onZero: true, lineStyle: { color: t.muted } },
                },
              ]
            : []),
        ],
        visualMap: {
          seriesIndex: 0,
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
          ...(diff
            ? [{ type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: diffBars, barWidth: '60%', emphasis: { disabled: true } }]
            : []),
        ],
      },
      { notMerge: true },
    )
    chart.resize()
  }

  let measureCtx: CanvasRenderingContext2D | null = null
  /** Width the function labels need (bold, the widest case), capped like the axis truncation. */
  function labelWidth(labels: string[]) {
    measureCtx ??= document.createElement('canvas').getContext('2d')
    if (!measureCtx) return LABEL_MAX
    measureCtx.font = 'bold 11px system-ui, sans-serif'
    return Math.min(LABEL_MAX, Math.ceil(Math.max(0, ...labels.map((l) => measureCtx!.measureText(l).width))))
  }

  function escape(s: string) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  }

  onMount(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    dark = mq.matches
    const onScheme = () => (dark = mq.matches)
    mq.addEventListener('change', onScheme)
    chart = initChart(el)
    chart.on('click', (p) => {
      const fn =
        p.componentType === 'yAxis'
          ? String((p as unknown as { value: string }).value)
          : p.seriesIndex === 1
            ? result?.functions[p.dataIndex]
            : result?.functions[(p.value as number[])[1]]
      if (fn) {
        view.highlight = null
        view.fn = view.fn === fn ? null : fn
        if (view.fn) showTaxa()
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

  /** The heatmap sits below the stacked bar, so scroll up to the stacked bar that shows the selected function's taxa. */
  function showTaxa() {
    const target = () => {
      const bars = document.querySelector('section.bars')
      const toolbar = document.querySelector('[aria-label="View settings"]')?.getBoundingClientRect().height ?? 0
      return bars ? bars.getBoundingClientRect().top + scrollY - toolbar - 16 : null
    }
    const first = target()
    if (first === null) return
    scrollTo({ top: first, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    // The Sankey above may grow once it adds the selected function, so re-aim after it updates.
    setTimeout(() => {
      const again = target()
      if (again !== null && Math.abs(again - first) > 4) scrollTo({ top: again, behavior: 'smooth' })
    }, 600)
  }

  // Redraw when the data, scale, selection or color scheme changes.
  $effect(() => {
    void [result, view.scale, view.fn, view.stat, dark]
    render()
  })

  async function onexport(format: ChartFormat | 'tsv') {
    if (!result || !chart) return
    const name = `heatmap-${view.groupBy}-${view.stat}-${view.rank}`
    if (format === 'tsv') {
      const r = result
      const diff = groupDifference(r.groups, r.values)
      const header = ['function', ...r.groups.map((g) => g.name), 'sum_of_groups', ...(diff ? [diff.signed ? diff.label.replace(' − ', ' - ') : 'highest_minus_lowest'] : [])]
      const rows = r.functions.map((f, i) => [f, ...r.values[i], r.values[i].reduce((a, v) => a + v, 0), ...(diff ? [diff.values[i]] : [])])
      download(toTsv(header, rows), `${safeFileName(`jarrvis-${name}`)}.tsv`)
    } else {
      await saveChart(chart, format, name, (forExport) => render(forExport))
    }
  }

  const height = $derived(result ? Math.max(160, result.functions.length * ROW + 100) : 160)
  // Cap each group's column so a few groups don't stretch into long bars.
  const width = $derived(
    result ? `min(100%, ${300 + result.groups.length * 120 + (result.groups.length > 1 ? DIFF_W + 40 : 0)}px)` : '100%',
  )
</script>

<section class="heatmap" aria-busy={busy}>
  <div class="head">
    <h2>Functions by group</h2>
    <ExportButtons {onexport} disabled={!result || result.functions.length === 0} />
  </div>
  <p class="desc">
    Each function's total across all taxa, per group, with the difference between groups on the right. Click a function
    to see which taxa contribute to it.
  </p>

  <div class="controls">
    <label>
      Show
      <select bind:value={view.top}>
        {#each TOPS as n}<option value={n}>Top {n}</option>{/each}
      </select>
    </label>
    <label>
      Ranked by
      <!-- Same setting as the toolbar's "Rank functions by", which also drives the Sankey. -->
      <select bind:value={view.rank}>
        <option value="total">Highest overall</option>
        <option value="difference">Largest difference between groups</option>
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
        {view.search ? `functions match "${view.search}"` : 'functions'}{#if result.matchingFunctions > result.functions.length}; showing the {result.functions.length} {view.rank === 'difference' ? 'with the largest difference between groups (highest − lowest group)' : 'with the highest values summed across groups'}{:else if view.rank === 'difference'}, ordered by the difference between groups (highest − lowest group){/if}.
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
