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
import { SVGRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  HeatmapChart,
  SankeyChart,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  TooltipComponent,
  VisualMapComponent,
  SVGRenderer,
])

export { echarts }

/**
 * Start a chart in `el`. Charts render as SVG so an export is exactly what is on screen,
 * including dragged Sankey nodes.
 */
export const initChart = (el: HTMLElement) => echarts.init(el, null, { renderer: 'svg' })

/** Sequential blue ramp (steps 100, 250, 400, 550, 700), near-zero first. */
const BLUE = ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b']

/**
 * Categorical hues in their fixed, CVD-validated order (blue, orange, aqua, yellow, magenta,
 * green, violet, red). Assign by slot, never cycle: a ninth series folds into "Other".
 */
const CATEGORICAL_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const CATEGORICAL_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767']
export const MAX_SERIES = CATEGORICAL_LIGHT.length

/** Surface and text tokens, matching app.css. Fixed here so an export can use light colors on a dark page. */
const TOKENS = {
  light: { surface: '#ffffff', text: '#2b2a30', muted: '#6b6875', border: '#e5e4e7' },
  dark: { surface: '#16151a', text: '#e6e4ea', muted: '#a19eab', border: '#2e2c34' },
}

/** Chart colors for a color scheme. Exports always use light. */
export function chartTheme(dark: boolean) {
  return {
    dark,
    ...TOKENS[dark ? 'dark' : 'light'],
    // Near-zero recedes toward the surface: light-to-dark on light, dark-to-light on dark.
    sequential: dark ? [...BLUE].reverse() : BLUE,
    categorical: dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT,
    /** Diverging poles (blue ↔ red) for signed differences. */
    diverging: dark ? { neg: CATEGORICAL_DARK[0], pos: CATEGORICAL_DARK[7] } : { neg: CATEGORICAL_LIGHT[0], pos: CATEGORICAL_LIGHT[7] },
    /** Neutral for series past the 8 categorical slots that stay individually labelled (e.g. Sankey taxa 9+). */
    extra: dark ? '#77757f' : '#9c9aa6',
    /** Neutral for "Other", outside the categorical set. */
    other: dark ? '#52514e' : '#c3c2b7',
  }
}
