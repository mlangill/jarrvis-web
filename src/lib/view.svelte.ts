// The one shared, serializable view state. Every view reads its settings from here, so a
// selection made in one view can drive the others, and the whole thing can later be saved
// as JSON or in the URL. Keep it plain data: no derived values or query results.
import type { Level, Stat } from './aggregate'

export interface ViewState {
  /** Metadata column that defines sample groups. */
  groupBy: string | null
  /** Taxonomic level to collapse taxa to. */
  level: Level
  /** Per-group value: mean per sample, or total. */
  stat: Stat
}

export const view: ViewState = $state({ groupBy: null, level: 'genus', stat: 'mean' })
