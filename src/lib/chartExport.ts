// Saving an on-screen chart as SVG or PNG, as arranged, in light colors on white.
import type { ECharts } from 'echarts/core'
import { chartTheme } from './echarts'
import { composeSvg, download, safeFileName, svgToPng, type LegendItem } from './export'

export type ChartFormat = 'svg' | 'png'

/**
 * `draw(forExport)` re-renders the chart: light colors when true, the page's colors when false.
 * It may return legend items to draw under the chart (for views whose legend is HTML).
 */
export async function saveChart(
  chart: ECharts,
  format: ChartFormat,
  name: string,
  draw: (forExport: boolean) => LegendItem[] | void,
): Promise<void> {
  let legend: LegendItem[] | void
  let raw: string
  try {
    legend = draw(true)
    raw = chart.renderToSVGString()
  } finally {
    draw(false)
  }
  const t = chartTheme(false)
  const doc = composeSvg(raw, {
    width: chart.getWidth(),
    height: chart.getHeight(),
    background: t.surface,
    text: t.text,
    legend: legend || undefined,
  })
  const base = safeFileName(`jarrvis-${name}`)
  if (format === 'svg') download(doc.svg, `${base}.svg`, 'image/svg+xml')
  else download(await svgToPng(doc.svg, doc.width, doc.height), `${base}.png`)
}
