// Stratified table formats other than the 4-column one, and their conversion to it.
// Each conversion is a SELECT over the all-text raw table that yields the four text columns
// sample, taxon, function, contribution, which then go through the normal 4-column checks.
import type { Column } from './load'
import { sqlIdent as id } from './sql'

export type StratFormat = 'jarrvis' | 'picrust2-contrib' | 'picrust2-legacy' | 'picrust2-wide' | 'humann'

export const STRAT_FORMATS: { key: StratFormat; label: string; short: string }[] = [
  { key: 'jarrvis', label: '4-column (sample, taxon, function, contribution)', short: '4-column' },
  { key: 'picrust2-contrib', label: 'PICRUSt2 contributions (metagenome_contrib)', short: 'PICRUSt2 contributions' },
  { key: 'picrust2-legacy', label: 'PICRUSt2 legacy contributions', short: 'PICRUSt2 legacy contributions' },
  { key: 'picrust2-wide', label: 'PICRUSt2 wide stratified (pred_metagenome_strat, path_abun_strat)', short: 'PICRUSt2 wide stratified' },
  { key: 'humann', label: 'HUMAnN 2 or 3 stratified (gene families or pathways)', short: 'HUMAnN stratified' },
]

export const formatShort = (f: StratFormat) => STRAT_FORMATS.find((x) => x.key === f)!.short

/** HUMAnN rows that aren't real functions. */
const HUMANN_SPECIAL = ['UNMAPPED', 'UNINTEGRATED', 'UNGROUPED']
/** Suffixes HUMAnN adds to sample names in joined tables, e.g. "S1_Abundance-RPKs". */
const HUMANN_SUFFIX = '_(Abundance|Coverage)(-[A-Za-z]+)?$'

/** The format the columns look like. Anything unrecognized is treated as the 4-column format. */
export function detectFormat(columns: Column[]): StratFormat {
  const names = columns.map((c) => c.name)
  const has = (n: string) => names.includes(n)
  if (has('taxon_function_abun') || has('norm_taxon_function_contrib')) return 'picrust2-contrib'
  if (has('CountContributedByOTU') || has('ContributionPercentOfSample')) return 'picrust2-legacy'
  if (/^#/.test(names[0] ?? '')) return 'humann'
  if (names.length >= 3 && names[1].toLowerCase() === 'sequence') return 'picrust2-wide'
  return 'jarrvis'
}

export type Conversion =
  | { select: string; note: string; check?: { sql: string; error: string } }
  | { error: string }

/** SQL that turns `raw` (in `format`) into sample, taxon, function, contribution. */
export function conversion(format: Exclude<StratFormat, 'jarrvis'>, columns: Column[], raw: string): Conversion {
  const names = columns.map((c) => c.name)
  const missing = (need: string[]) => need.filter((n) => !names.includes(n))
  const wrongShape = (what: string, need: string) =>
    `This doesn't look like ${what}: expected ${need}. Found: ${names.join(', ')}.`
  const nonZero = (v: string) => `TRY_CAST(${v} AS DOUBLE) IS DISTINCT FROM 0`

  switch (format) {
    case 'picrust2-contrib': {
      const need = ['sample', 'function', 'taxon', 'taxon_function_abun']
      if (missing(need).length) return { error: wrongShape('PICRUSt2 contributions output', `columns ${need.join(', ')}`) }
      return {
        select: `SELECT "sample", "taxon", "function", "taxon_function_abun" AS contribution FROM ${raw}`,
        note: 'Read as PICRUSt2 contributions output. Contribution is taxon_function_abun; taxa are the sequence IDs.',
      }
    }
    case 'picrust2-legacy': {
      const need = ['Gene', 'Sample', 'OTU', 'CountContributedByOTU']
      if (missing(need).length) return { error: wrongShape('legacy PICRUSt2 contributions output', `columns ${need.join(', ')}`) }
      return {
        select: `SELECT "Sample" AS sample, "OTU" AS taxon, "Gene" AS function, "CountContributedByOTU" AS contribution FROM ${raw}`,
        note: 'Read as legacy PICRUSt2 contributions output. Contribution is CountContributedByOTU; taxa are the OTU IDs.',
      }
    }
    case 'picrust2-wide': {
      if (names.length < 3) {
        return { error: wrongShape('PICRUSt2 wide stratified output', 'a function column, a sequence column, then one column per sample') }
      }
      const [fn, seq] = names.map(id)
      return {
        select: `
          SELECT sample, ${seq} AS taxon, ${fn} AS function, contribution
          FROM (UNPIVOT ${raw} ON COLUMNS(* EXCLUDE (${fn}, ${seq})) INTO NAME sample VALUE contribution)
          WHERE ${nonZero('contribution')}`,
        note: `Read as PICRUSt2 wide stratified output: ${names.length - 2} sample columns; zero values are left out. Taxa are the sequence IDs.`,
      }
    }
    case 'humann': {
      if (names.length < 2 || !names[0].startsWith('#')) {
        return { error: wrongShape('HUMAnN output', 'a first column like "# Gene Family" or "# Pathway", then one column per sample') }
      }
      const feature = id(names[0])
      const special = HUMANN_SPECIAL.map((s) => `'${s}'`).join(', ')
      return {
        select: `
          SELECT regexp_replace(sample, '${HUMANN_SUFFIX}', '', 'i') AS sample,
                 substr(${feature}, strpos(${feature}, '|') + 1) AS taxon,
                 split_part(${feature}, '|', 1) AS function,
                 contribution
          FROM (UNPIVOT ${raw} ON COLUMNS(* EXCLUDE (${feature})) INTO NAME sample VALUE contribution)
          WHERE strpos(${feature}, '|') > 0
            AND split_part(${feature}, '|', 1) NOT IN (${special})
            AND ${nonZero('contribution')}`,
        note:
          `Read as HUMAnN stratified output: ${names.length - 1} sample columns. Only per-taxon rows (function|taxon) are used; ` +
          `community totals, ${HUMANN_SPECIAL.join(', ')} and zero values are left out. Suffixes such as "_Abundance-RPKs" are removed from sample names.`,
        check: {
          sql: `SELECT count(*) AS n FROM ${raw} WHERE strpos(${feature}, '|') > 0`,
          error:
            'This HUMAnN table has no per-taxon rows (function|taxon). Use the stratified output, for example from humann_split_stratified_table, or the full joined table.',
        },
      }
    }
  }
}
