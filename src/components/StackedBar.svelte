<script lang="ts">
  import { onMount } from 'svelte'
  import { taxaForFunction, type TaxaBars } from '../lib/aggregate'
  import { getSql } from '../lib/db'
  import { chartTheme, echarts, MAX_SERIES } from '../lib/echarts'
  import { view } from '../lib/view.svelte'

  let { dataVersion }: { dataVersion: number } = $props()

  const fmt = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 })
  const pct = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

  let result = $state<TaxaBars | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)
  let dark = $state(false)
  let el: HTMLDivElement
  let chart: echarts.ECharts | null = null
  let request = 0
  /** Legend entries, largest first (the bottom of the stack). Rendered as HTML so it wraps at any width. */
  let legend = $state<{ name: string; color: string; title: string }[]>([])

  $effect(() => {
    const opts = { groupBy: view.groupBy, level: view.level, stat: view.stat, fn: view.fn, by: view.barsBy }
    void dataVersion
    if (!opts.groupBy || !opts.fn) {
      result = null
      return
    }
    const mine = ++request
    busy = true
    ;(async () => {
      try {
        const r = await taxaForFunction(await getSql(), {
          ...opts,
          groupBy: opts.groupBy!,
          fn: opts.fn!,
          topTaxa: MAX_SERIES,
        })
        if (mine === request) [result, error] = [r, null]
      } catch (err) {
        if (mine === request) error = err instanceof Error ? err.message : String(err)
        console.error(err)
      } finally {
        if (mine === request) busy = false
      }
    })()
  })

  const valueLabel = $derived(
    view.barScale === 'relative'
      ? 'Share of bar'
      : view.barsBy === 'sample'
        ? 'Contribution'
        : view.stat === 'mean'
          ? 'Mean per sample'
          : 'Total',
  )

  function escape(s: string) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  }

  function render() {
    if (!chart || !result) return
    const r = result
    const t = chartTheme(dark)
    const relative = view.barScale === 'relative'
    const totals = r.bars.map((_, b) => r.values.reduce((a, row) => a + row[b], 0) + r.other[b])
    const scaled = (v: number, b: number) => (relative ? (totals[b] > 0 ? (v / totals[b]) * 100 : 0) : v)

    // Series names must be unique for the legend.
    const seen = new Map<string, number>()
    const names = r.taxa.map((taxon) => {
      const n = (seen.get(taxon.label) ?? 0) + 1
      seen.set(taxon.label, n)
      return n === 1 ? taxon.label : `${taxon.label} (${n})`
    })
    const series: Record<string, unknown>[] = r.taxa.map((_, i) => ({
      name: names[i],
      type: 'bar',
      stack: 'taxa',
      data: r.values[i].map(scaled),
      itemStyle: { color: t.categorical[i], borderColor: t.surface, borderWidth: 1 },
      barMaxWidth: 64,
    }))
    if (r.otherTaxa > 0) {
      series.push({
        name: `Other (${r.otherTaxa} ${r.otherTaxa === 1 ? 'taxon' : 'taxa'})`,
        type: 'bar',
        stack: 'taxa',
        data: r.other.map(scaled),
        itemStyle: { color: t.other, borderColor: t.surface, borderWidth: 1 },
        barMaxWidth: 64,
      })
    }

    // In sample mode, shade alternate groups and label them above the bars.
    if (view.barsBy === 'sample' && series.length > 0) {
      const spans: { group: string; from: string; to: string }[] = []
      for (const b of r.bars) {
        const last = spans.at(-1)
        if (last && last.group === b.group) last.to = b.label
        else spans.push({ group: b.group, from: b.label, to: b.label })
      }
      series[0].markArea = {
        silent: true,
        label: { position: 'top', color: t.muted, fontSize: 12 },
        data: spans.map((s, i) => [
          { name: s.group, xAxis: s.from, itemStyle: { color: i % 2 ? 'transparent' : t.border, opacity: 0.35 } },
          { xAxis: s.to },
        ]),
      }
    }

    legend = [
      ...r.taxa.map((x, i) => ({ name: names[i], color: t.categorical[i], title: x.path })),
      ...(r.otherTaxa > 0 ? [{ name: String(series.at(-1)!.name), color: t.other, title: 'All other taxa combined' }] : []),
    ]
    chart.setOption(
      {
        animation: false,
        backgroundColor: 'transparent',
        textStyle: { fontFamily: 'system-ui, sans-serif', color: t.text },
        grid: { top: view.barsBy === 'sample' ? 48 : 32, right: 16, bottom: 8, left: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          backgroundColor: t.surface,
          borderColor: t.border,
          textStyle: { color: t.text, fontSize: 12 },
          formatter: (ps: { dataIndex: number; seriesIndex: number; marker: string; seriesName: string }[]) => {
            const b = ps[0].dataIndex
            const bar = r.bars[b]
            const head =
              view.barsBy === 'sample'
                ? `<strong>${escape(bar.label)}</strong> (${escape(bar.group)})`
                : `<strong>${escape(bar.label)}</strong> (${bar.samples} ${bar.samples === 1 ? 'sample' : 'samples'})`
            const raw = (i: number) => (i < r.taxa.length ? r.values[i][b] : r.other[b])
            const lines = ps
              .filter((p) => raw(p.seriesIndex) > 0)
              .reverse()
              .map(
                (p) =>
                  `${p.marker}${escape(p.seriesName)}: <strong>${fmt.format(raw(p.seriesIndex))}</strong>` +
                  (totals[b] > 0 ? ` (${pct.format((raw(p.seriesIndex) / totals[b]) * 100)}%)` : ''),
              )
            return `${head}<br>${lines.join('<br>') || 'No contribution'}<br>Total: <strong>${fmt.format(totals[b])}</strong>`
          },
        },
        xAxis: {
          type: 'category',
          data: r.bars.map((b) => b.label),
          axisLine: { lineStyle: { color: t.border } },
          axisTick: { show: false },
          axisLabel: { color: t.text, fontSize: 12, interval: 0, rotate: view.barsBy === 'sample' && r.bars.length > 12 ? 45 : 0 },
        },
        yAxis: {
          type: 'value',
          name: valueLabel,
          nameTextStyle: { color: t.muted, fontSize: 11, align: 'left' },
          max: relative ? 100 : undefined,
          axisLabel: { color: t.muted, fontSize: 11, formatter: relative ? '{value}%' : undefined },
          splitLine: { lineStyle: { color: t.border } },
        },
        series,
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
    chart = echarts.init(el)
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
    void [result, view.barScale, view.stat, dark]
    render()
  })

  const width = $derived(
    result && view.barsBy === 'group' ? `min(100%, ${240 + result.bars.length * 110}px)` : '100%',
  )
</script>

<section class="bars" aria-busy={busy}>
  <h2>
    {#if view.fn}Taxa contributing to <span class="fn">{view.fn}</span>{:else}Taxa contributing to a function{/if}
  </h2>

  {#if !view.fn}
    <p class="desc">Click a function in the heatmap to see which taxa contribute to it.</p>
  {:else}
    <div class="controls">
      <label>
        Bars
        <select bind:value={view.barsBy}>
          <option value="group">One per group</option>
          <option value="sample">One per sample</option>
        </select>
      </label>
      <label>
        Scale
        <select bind:value={view.barScale}>
          <option value="absolute">Absolute values</option>
          <option value="relative">Relative (each bar 100%)</option>
        </select>
      </label>
    </div>
    {#if error}
      <p class="error" role="alert">Couldn't build the chart: {error}</p>
    {:else if result}
      <p class="note">
        Top {result.taxa.length} {result.taxa.length === 1 ? 'taxon' : 'taxa'} at this level{#if result.otherTaxa > 0}; {result.otherTaxa} more grouped as Other{/if}.
        {view.barsBy === 'group' ? (view.stat === 'mean' ? 'Mean per sample in each group.' : 'Total per group.') : 'Each sample’s own contribution.'}
      </p>
    {/if}
  {/if}

  <div
    class="chart"
    class:hidden={!view.fn || !result}
    bind:this={el}
    style:width={width}
    role="img"
    aria-label="Stacked bar chart of taxa contributing to the selected function"
  ></div>

  {#if view.fn && result && legend.length > 0}
    <ul class="legend" aria-label="Legend">
      {#each legend as item}
        <li title={item.title}><span class="swatch" style:background={item.color}></span>{item.name}</li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .bars {
    margin-top: 1rem;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .fn {
    font-family: var(--mono);
    font-size: 1rem;
  }
  .desc {
    margin: 0.25rem 0 0;
    font-size: 0.9rem;
    color: var(--muted);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.25rem;
    margin-top: 0.75rem;
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
    height: 380px;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 1rem;
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
    font-size: 0.85rem;
  }
  .legend li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .swatch {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    flex: none;
  }
  .hidden {
    display: none;
  }
  [aria-busy='true'] .chart {
    opacity: 0.6;
  }
</style>
