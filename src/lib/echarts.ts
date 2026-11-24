// ECharts with only the pieces the app uses, to keep the bundle small.
import { BarChart, HeatmapChart, SankeyChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  HeatmapChart,
  SankeyChart,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
])

export { echarts }

/** Sequential blue ramp (steps 100, 250, 400, 550, 700), near-zero first. */
const BLUE = ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b']

/**
 * Categorical hues in their fixed, CVD-validated order (blue, orange, aqua, yellow, magenta,
 * green, violet, red). Assign by slot, never cycle: a ninth series folds into "Other".
 */
const CATEGORICAL_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const CATEGORICAL_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767']
export const MAX_SERIES = CATEGORICAL_LIGHT.length

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
    categorical: dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT,
    /** Neutral for "Other", outside the categorical set. */
    other: dark ? '#52514e' : '#c3c2b7',
  }
}
