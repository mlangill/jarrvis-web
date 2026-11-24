// ECharts with only the pieces the app uses, to keep the bundle small.
import { HeatmapChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([HeatmapChart, GridComponent, TooltipComponent, VisualMapComponent, CanvasRenderer])

export { echarts }

/** Sequential blue ramp (steps 100, 250, 400, 550, 700), near-zero first. */
const BLUE = ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b']

/** Chart colors for the current color scheme, read from the page's CSS tokens. */
export function chartTheme(dark: boolean) {
  const css = getComputedStyle(document.documentElement)
  const token = (name: string) => css.getPropertyValue(name).trim()
  return {
    dark,
    surface: token('--bg'),
    text: token('--text'),
    muted: token('--muted'),
    border: token('--border'),
    // Near-zero recedes toward the surface: light-to-dark on light, dark-to-light on dark.
    sequential: dark ? [...BLUE].reverse() : BLUE,
  }
}
