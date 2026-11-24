// The one shared, serializable view state. Every view reads its settings from here, so a
// selection made in one view can drive the others, and the whole thing can later be saved
// as JSON or in the URL. Keep it plain data: no derived values or query results.
import type { Level, Stat } from './aggregate'

/** How heatmap cells are colored. */
export type HeatScale = 'linear' | 'log' | 'row'

export interface ViewState {
  /** Metadata column that defines sample groups. */
  groupBy: string | null
  /** Taxonomic level to collapse taxa to. */
  level: Level
  /** Per-group value: mean per sample, or total. */
  stat: Stat
  /** Selected function, shared across views; null for none. */
  fn: string | null
  /** Heatmap: function search text. */
  search: string
  /** Heatmap: how many functions to show. */
  top: number
  /** Heatmap: color scale. */
  scale: HeatScale
  /** Stacked bar: one bar per group or per sample. */
  barsBy: 'group' | 'sample'
  /** Stacked bar: absolute values, or each bar as 100%. */
  barScale: 'absolute' | 'relative'
}

export const view: ViewState = $state({
  groupBy: null,
  level: 'genus',
  stat: 'mean',
  fn: null,
  search: '',
  top: 50,
  scale: 'log',
  barsBy: 'group',
  barScale: 'absolute',
})
