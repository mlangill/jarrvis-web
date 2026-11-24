// Taxonomy parsing and group-level aggregation over the clean `strat` and `metadata` tables.
import { sqlIdent as id, sqlString, type Sql } from './sql'
import { META, STRAT } from './validate'

export const TAXONOMY = 'taxonomy'
export const GROUPED = 'grouped'

/** Ranks recognized from prefixes like p__ or g__, highest first. */
export const RANKS = [
  { key: 'kingdom', label: 'Kingdom', prefix: '[kd]' },
  { key: 'phylum', label: 'Phylum', prefix: 'p' },
  { key: 'class', label: 'Class', prefix: 'c' },
  { key: 'order', label: 'Order', prefix: 'o' },
  { key: 'family', label: 'Family', prefix: 'f' },
  { key: 'genus', label: 'Genus', prefix: 'g' },
  { key: 'species', label: 'Species', prefix: 's' },
] as const

export type Rank = (typeof RANKS)[number]['key']
/** A rank to collapse to, or 'taxon' to keep taxa exactly as given. */
export type Level = Rank | 'taxon'
export type Stat = 'mean' | 'sum'

export const LEVEL_LABELS: Record<Level, string> = {
  ...(Object.fromEntries(RANKS.map((r) => [r.key, r.label])) as Record<Rank, string>),
  taxon: 'Taxon as given',
}

/** Rank values that mean "not assigned". */
const UNASSIGNED = ['', 'na', 'nan', 'none', 'unclassified', 'unknown', 'unassigned']

/**
 * Split each distinct taxon in `strat` into ranks and store them in TAXONOMY.
 * Handles ';' and '|' separators and HUMAnN's 'g__X.s__Y'. Returns the ranks that have
 * at least one assigned value, i.e. the levels the data can be collapsed to.
 */
export async function buildTaxonomy(sql: Sql): Promise<Rank[]> {
  const cols = RANKS.map((r) => {
    const re = sqlString(`^${r.prefix}__`)
    const raw = `trim(regexp_replace(list_filter(parts, x -> regexp_matches(x, ${re}))[1], ${re}, ''))`
    return `CASE WHEN lower(coalesce(${raw}, '')) IN (${UNASSIGNED.map(sqlString).join(', ')}) THEN NULL ELSE ${raw} END AS ${id(r.key)}`
  })
  await sql.query(`
    CREATE OR REPLACE TABLE ${id(TAXONOMY)} AS
    WITH p AS (
      SELECT taxon,
             regexp_split_to_array(regexp_replace(taxon, '\\.([a-z]__)', ';\\1', 'g'), '\\s*[;|]\\s*') AS parts
      FROM (SELECT DISTINCT taxon FROM ${id(STRAT)})
    )
    SELECT taxon, ${cols.join(',\n           ')} FROM p`)
  const [counts] = await sql.query(
    `SELECT ${RANKS.map((r) => `count(${id(r.key)}) AS ${id(r.key)}`).join(', ')} FROM ${id(TAXONOMY)}`,
  )
  return RANKS.filter((r) => Number(counts[r.key]) > 0).map((r) => r.key)
}

/** SQL for the grouping key and display label of each taxon at `level`, over TAXONOMY. */
function taxonExprs(level: Level): { key: string; label: string; path: string } {
  if (level === 'taxon') return { key: 'taxon', label: 'taxon', path: 'taxon' }
  const upTo = RANKS.slice(0, RANKS.findIndex((r) => r.key === level) + 1).map((r) => id(r.key))
  // Key: the full path down to `level`, so same-named taxa under different parents stay apart.
  const key = `concat_ws('|', ${upTo.map((c) => `coalesce(${c}, '')`).join(', ')})`
  // Label: the name at `level`, or "Unclassified <deepest known parent>".
  const parent = `coalesce(${[...upTo.slice(0, -1)].reverse().join(', ') || 'NULL'})`
  const label = `coalesce(${upTo.at(-1)}, CASE WHEN ${parent} IS NULL THEN 'Unclassified' ELSE 'Unclassified ' || ${parent} END)`
  // Path: the assigned ranks for display (concat_ws skips NULLs).
  const path = `concat_ws(' > ', ${upTo.join(', ')})`
  return { key, label, path }
}

export interface GroupInfo {
  name: string
  samples: number
}

export type GroupedRow = {
  group: string
  taxon: string
  /** Assigned ranks down to the level, e.g. "Firmicutes > Bacilli", for tooltips. Equal to taxon when level is 'taxon'. */
  path: string
  function: string
  value: number
}

export interface GroupedResult {
  groups: GroupInfo[]
  /** Samples with data but no value in the grouping column; left out. */
  ungroupedSamples: number
  totalRows: number
  /** Largest values first, at most `limit`. */
  rows: GroupedRow[]
}

export interface GroupOptions {
  groupBy: string
  level: Level
  stat: Stat
  /** Only this function, if set. */
  fn?: string | null
  limit?: number
}

/**
 * CTEs shared by every group-level query: `gs` maps each sample that has data and a value in
 * `groupBy` to its group, and `n` counts those samples per group.
 */
function groupCtes(groupBy: string): string {
  const g = id(groupBy)
  return `
      gs AS (
        SELECT sample_id, ${g} AS grp FROM ${id(META)}
        WHERE ${g} IS NOT NULL AND sample_id IN (SELECT DISTINCT sample FROM ${id(STRAT)})
      ),
      n AS (SELECT grp, count(*) AS samples FROM gs GROUP BY grp)`
}

/** Groups in display order, and how many samples with data have no group value. */
async function groupInfo(sql: Sql, groupBy: string): Promise<{ groups: GroupInfo[]; ungroupedSamples: number }> {
  const g = id(groupBy)
  const groups = await sql.query<{ name: string; samples: bigint }>(
    `WITH ${groupCtes(groupBy)} SELECT grp AS name, samples FROM n ORDER BY grp`,
  )
  const [{ ungrouped }] = await sql.query(`
    SELECT count(*) AS ungrouped FROM ${id(META)}
    WHERE ${g} IS NULL AND sample_id IN (SELECT DISTINCT sample FROM ${id(STRAT)})`)
  return { groups: groups.map((r) => ({ name: r.name, samples: Number(r.samples) })), ungroupedSamples: Number(ungrouped) }
}

/**
 * Collapse taxa to `level`, then summarize contributions per group × taxon × function into GROUPED.
 * Mean is the group total divided by the number of samples in the group that have data, so a
 * sample with no row for a taxon/function counts as zero.
 */
export async function groupTable(sql: Sql, { groupBy, level, stat, fn = null, limit = 200 }: GroupOptions): Promise<GroupedResult> {
  const tx = taxonExprs(level)
  const value = stat === 'mean' ? 'a.total / n.samples' : 'a.total'
  await sql.query(`
    CREATE OR REPLACE TABLE ${id(GROUPED)} AS
    WITH
      tx AS (SELECT taxon, ${tx.key} AS tkey, ${tx.label} AS tlabel, ${tx.path} AS tpath FROM ${id(TAXONOMY)}),
      ${groupCtes(groupBy)},
      a AS (
        SELECT gs.grp, tx.tkey, any_value(tx.tlabel) AS tlabel, any_value(tx.tpath) AS tpath, s.function, sum(s.contribution) AS total
        FROM ${id(STRAT)} s JOIN gs ON s.sample = gs.sample_id JOIN tx USING (taxon)
        ${fn === null ? '' : `WHERE s.function = ${sqlString(fn)}`}
        GROUP BY gs.grp, tx.tkey, s.function
      )
    SELECT a.grp AS "group", a.tlabel AS taxon, a.tpath AS path, a.function, ${value} AS value, n.samples
    FROM a JOIN n USING (grp)`)

  const info = await groupInfo(sql, groupBy)
  const [{ n }] = await sql.query(`SELECT count(*) AS n FROM ${id(GROUPED)}`)
  const rows = await sql.query<GroupedRow>(`
    SELECT "group", taxon, path, function, value FROM ${id(GROUPED)}
    ORDER BY value DESC, "group", taxon, function LIMIT ${Math.max(0, Math.floor(limit))}`)

  return { ...info, totalRows: Number(n), rows }
}

/** Every row of the last groupTable result (GROUPED), largest first, for export. */
export async function groupedRows(sql: Sql): Promise<GroupedRow[]> {
  return sql.query<GroupedRow>(`
    SELECT "group", taxon, path, function, value FROM ${id(GROUPED)} ORDER BY value DESC, "group", taxon, function`)
}

/**
 * How functions are ranked for the top-N cut: by the sum of their group values (most abundant
 * overall), or by the gap between their highest and lowest group (largest difference).
 */
export type FunctionRank = 'total' | 'difference'

/** Highest minus lowest group value of a function in `v`; groups without a row count as 0. */
const DIFFERENCE = `CASE WHEN count(*) < (SELECT count(*) FROM n)
    THEN greatest(max(value), 0) - least(min(value), 0)
    ELSE max(value) - min(value) END`

export interface HeatmapOptions {
  groupBy: string
  stat: Stat
  /** Case-insensitive substring a function must contain; empty for all. */
  search?: string
  /** How many functions to keep, highest score first. */
  top: number
  /** What the score is; defaults to 'total'. */
  rank?: FunctionRank
}

export interface HeatmapResult {
  groups: GroupInfo[]
  ungroupedSamples: number
  /** Functions shown, highest score first. */
  functions: string[]
  /** scores[f]: the ranking score of functions[f] (sum of group values, or max − min group). */
  scores: number[]
  /** Functions matching the search before the top-N cut. */
  matchingFunctions: number
  /** values[f][g]: value for functions[f] in groups[g]; 0 where the function is absent. */
  values: number[][]
}

/**
 * Function × group values, summed over all taxa, cut to the `top` highest-scoring functions.
 * With rank 'total' the score is the sum of the group values (so with 'mean', groups weigh
 * equally whatever their size). With 'difference' it is the highest group value minus the
 * lowest, where a group with no data for the function counts as zero.
 */
export async function functionHeatmap(
  sql: Sql,
  { groupBy, stat, search = '', top, rank = 'total' }: HeatmapOptions,
): Promise<HeatmapResult> {
  const value = stat === 'mean' ? 'f.total / n.samples' : 'f.total'
  const term = search.trim()
  const where = term ? `WHERE contains(lower(s.function), ${sqlString(term.toLowerCase())})` : ''
  const cells = await sql.query<{ grp: string; function: string; value: number; score: number; matching: bigint }>(`
    WITH
      ${groupCtes(groupBy)},
      f AS (
        SELECT gs.grp, s.function, sum(s.contribution) AS total
        FROM ${id(STRAT)} s JOIN gs ON s.sample = gs.sample_id ${where}
        GROUP BY gs.grp, s.function
      ),
      v AS (SELECT f.grp, f.function, ${value} AS value FROM f JOIN n USING (grp)),
      ranked AS (
        SELECT function, ${rank === 'difference' ? DIFFERENCE : 'sum(value)'} AS score, count(*) OVER () AS matching FROM v
        GROUP BY function ORDER BY score DESC, function LIMIT ${Math.max(1, Math.floor(top))}
      )
    SELECT v.grp, v.function, v.value, ranked.score, ranked.matching
    FROM v JOIN ranked USING (function) ORDER BY ranked.score DESC, v.function`)

  const info = await groupInfo(sql, groupBy)
  const functions = [...new Set(cells.map((c) => c.function))]
  const fIndex = new Map(functions.map((f, i) => [f, i]))
  const gIndex = new Map(info.groups.map((g, i) => [g.name, i]))
  const values = functions.map(() => info.groups.map(() => 0))
  const scores = functions.map(() => 0)
  for (const c of cells) {
    values[fIndex.get(c.function)!][gIndex.get(c.grp)!] = Number(c.value)
    scores[fIndex.get(c.function)!] = Number(c.score)
  }

  return { ...info, functions, scores, matchingFunctions: Number(cells[0]?.matching ?? 0), values }
}

export interface GroupDifference {
  /** Column label, e.g. "B − A", or "Highest − lowest". */
  label: string
  /** True when values are signed (exactly two groups: second minus first). */
  signed: boolean
  /** values[f]: the difference for function f. */
  values: number[]
  /** For each function, the indexes of its highest and lowest groups. */
  extremes: { high: number; low: number }[]
}

/**
 * Per-function difference between groups, from heatmap values (absent = 0). With two groups it
 * is signed, second minus first; with more it is highest minus lowest. Null with one group.
 */
export function groupDifference(groups: GroupInfo[], values: number[][]): GroupDifference | null {
  if (groups.length < 2) return null
  const extremes = values.map((row) => {
    let high = 0
    let low = 0
    row.forEach((v, i) => {
      if (v > row[high]) high = i
      if (v < row[low]) low = i
    })
    return { high, low }
  })
  if (groups.length === 2) {
    return { label: `${groups[1].name} − ${groups[0].name}`, signed: true, values: values.map((r) => r[1] - r[0]), extremes }
  }
  return { label: 'Highest − lowest', signed: false, values: values.map((r, f) => r[extremes[f].high] - r[extremes[f].low]), extremes }
}

export interface TaxaBarsOptions {
  groupBy: string
  level: Level
  stat: Stat
  fn: string
  /** One bar per group (mean or total, per `stat`), or one per sample (its own contribution). */
  by: 'group' | 'sample'
  /** Taxa shown individually; the rest are folded into "Other". */
  topTaxa?: number
}

export interface Bar {
  /** Group name, or sample ID. */
  label: string
  group: string
  /** Samples behind the bar: the group size, or 1. */
  samples: number
}

export interface BarTaxon {
  label: string
  path: string
}

export interface TaxaBars {
  bars: Bar[]
  /** Shown taxa, largest first. Ranked by the sum of group values in both modes, so the set and
   * its order (and therefore colors) don't change when switching between groups and samples. */
  taxa: BarTaxon[]
  /** values[t][b]: taxa[t] in bars[b]. */
  values: number[][]
  /** Everything outside the shown taxa, per bar. */
  other: number[]
  /** How many taxa were folded into `other`. */
  otherTaxa: number
}

/** Contributions of each taxon (collapsed to `level`) to one function, per group or per sample. */
export async function taxaForFunction(
  sql: Sql,
  { groupBy, level, stat, fn, by, topTaxa = 8 }: TaxaBarsOptions,
): Promise<TaxaBars> {
  const tx = taxonExprs(level)
  const ctes = `
    WITH
      tx AS (SELECT taxon, ${tx.key} AS tkey, ${tx.label} AS tlabel, ${tx.path} AS tpath FROM ${id(TAXONOMY)}),
      ${groupCtes(groupBy)},
      ps AS (
        SELECT gs.grp, s.sample, tx.tkey, any_value(tx.tlabel) AS tlabel, any_value(tx.tpath) AS tpath,
               sum(s.contribution) AS total
        FROM ${id(STRAT)} s JOIN gs ON s.sample = gs.sample_id JOIN tx USING (taxon)
        WHERE s.function = ${sqlString(fn)}
        GROUP BY gs.grp, s.sample, tx.tkey
      ),
      pg AS (
        SELECT ps.grp, ps.tkey, ${stat === 'mean' ? 'sum(ps.total) / any_value(n.samples)' : 'sum(ps.total)'} AS value
        FROM ps JOIN n USING (grp) GROUP BY ps.grp, ps.tkey
      )`
  const ranked = await sql.query<{ tkey: string; tlabel: string; tpath: string }>(`${ctes},
      names AS (SELECT tkey, any_value(tlabel) AS tlabel, any_value(tpath) AS tpath FROM ps GROUP BY tkey)
    SELECT pg.tkey, any_value(names.tlabel) AS tlabel, any_value(names.tpath) AS tpath
    FROM pg JOIN names USING (tkey) GROUP BY pg.tkey
    ORDER BY sum(pg.value) DESC, pg.tkey`)

  const shown = ranked.slice(0, topTaxa)
  const tIndex = new Map(shown.map((t, i) => [t.tkey, i]))

  let bars: Bar[]
  let cells: { bar: string; tkey: string; value: number }[]
  if (by === 'group') {
    const info = await groupInfo(sql, groupBy)
    bars = info.groups.map((g) => ({ label: g.name, group: g.name, samples: g.samples }))
    cells = (await sql.query<{ grp: string; tkey: string; value: number }>(`${ctes} SELECT grp, tkey, value FROM pg`)).map(
      (c) => ({ bar: c.grp, tkey: c.tkey, value: Number(c.value) }),
    )
  } else {
    const samples = await sql.query<{ sample_id: string; grp: string }>(`
      WITH ${groupCtes(groupBy)} SELECT sample_id, grp FROM gs ORDER BY grp, sample_id`)
    bars = samples.map((s) => ({ label: s.sample_id, group: s.grp, samples: 1 }))
    cells = (await sql.query<{ sample: string; tkey: string; total: number }>(`${ctes} SELECT sample, tkey, total FROM ps`)).map(
      (c) => ({ bar: c.sample, tkey: c.tkey, value: Number(c.total) }),
    )
  }

  const bIndex = new Map(bars.map((b, i) => [b.label, i]))
  const values = shown.map(() => bars.map(() => 0))
  const other = bars.map(() => 0)
  for (const c of cells) {
    const b = bIndex.get(c.bar)
    if (b === undefined) continue
    const t = tIndex.get(c.tkey)
    if (t === undefined) other[b] += c.value
    else values[t][b] += c.value
  }

  return {
    bars,
    taxa: shown.map((t) => ({ label: t.tlabel, path: t.tpath })),
    values,
    other,
    otherTaxa: ranked.length - shown.length,
  }
}

export type SankeyColumn = 'group' | 'taxon' | 'function'

export interface SankeyNode {
  /** Unique across columns: 'g:', 't:' or 'f:' followed by the group name, taxon key or function. */
  id: string
  label: string
  column: SankeyColumn
  /** Longer description for tooltips (the rank path for taxa). */
  title: string
  /** For taxa: index into the categorical palette, or -1 for Other. */
  colorSlot?: number
}

export interface SankeyLink {
  source: string
  target: string
  value: number
}

export interface SankeyFlow {
  group: string
  taxon: string
  fn: string
  value: number
}

export interface SankeyData {
  nodes: SankeyNode[]
  links: SankeyLink[]
  /** The full group → taxon → function breakdown behind the links (node ids), so a highlight can
   * show just one group's or one function's share of each link. */
  flows: SankeyFlow[]
  /** Taxa folded into the Other node. */
  otherTaxa: number
}

export interface SankeyOptions {
  groupBy: string
  level: Level
  stat: Stat
  /** Functions to include, in display order. */
  functions: string[]
  /** Taxa shown individually; the rest become one Other node. */
  topTaxa?: number
}

export const OTHER_TAXA_ID = 't:\u0000other'

/**
 * Three-column flow: groups → taxa → functions, for the given functions. Values are per group
 * (mean or total, per `stat`). A group→taxon link carries that taxon's value summed over the
 * functions; a taxon→function link carries its value summed over the groups, so flow into each
 * taxon equals flow out of it.
 */
export async function sankeyData(
  sql: Sql,
  { groupBy, level, stat, functions, topTaxa = 8 }: SankeyOptions,
): Promise<SankeyData> {
  if (functions.length === 0) return { nodes: [], links: [], flows: [], otherTaxa: 0 }
  const tx = taxonExprs(level)
  const rows = await sql.query<{ grp: string; tkey: string; tlabel: string; tpath: string; function: string; value: number }>(`
    WITH
      tx AS (SELECT taxon, ${tx.key} AS tkey, ${tx.label} AS tlabel, ${tx.path} AS tpath FROM ${id(TAXONOMY)}),
      ${groupCtes(groupBy)},
      c AS (
        SELECT gs.grp, tx.tkey, any_value(tx.tlabel) AS tlabel, any_value(tx.tpath) AS tpath, s.function,
               sum(s.contribution) AS total
        FROM ${id(STRAT)} s JOIN gs ON s.sample = gs.sample_id JOIN tx USING (taxon)
        WHERE s.function IN (${functions.map(sqlString).join(', ')})
        GROUP BY gs.grp, tx.tkey, s.function
      )
    SELECT c.grp, c.tkey, c.tlabel, c.tpath, c.function, ${stat === 'mean' ? 'c.total / n.samples' : 'c.total'} AS value
    FROM c JOIN n USING (grp)
    WHERE c.total > 0`)

  // Rank taxa by their total flow and keep the top N.
  const taxonTotals = new Map<string, { label: string; path: string; total: number }>()
  for (const r of rows) {
    const t = taxonTotals.get(r.tkey) ?? { label: r.tlabel, path: r.tpath, total: 0 }
    t.total += Number(r.value)
    taxonTotals.set(r.tkey, t)
  }
  const ranked = [...taxonTotals.entries()].sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1))
  const shown = ranked.slice(0, topTaxa)
  const shownIds = new Map(shown.map(([key], i) => [key, i]))
  const taxonId = (key: string) => (shownIds.has(key) ? `t:${key}` : OTHER_TAXA_ID)

  const linkMap = new Map<string, SankeyLink>()
  const add = (source: string, target: string, value: number) => {
    const k = `${source}\u0001${target}`
    const l = linkMap.get(k)
    if (l) l.value += value
    else linkMap.set(k, { source, target, value })
  }
  const groupsUsed = new Set<string>()
  const functionsUsed = new Set<string>()
  const flowMap = new Map<string, SankeyFlow>()
  for (const r of rows) {
    const v = Number(r.value)
    const [g, t, f] = [`g:${r.grp}`, taxonId(r.tkey), `f:${r.function}`]
    add(g, t, v)
    add(t, f, v)
    const k = `${g}\u0001${t}\u0001${f}`
    const flow = flowMap.get(k)
    if (flow) flow.value += v
    else flowMap.set(k, { group: g, taxon: t, fn: f, value: v })
    groupsUsed.add(r.grp)
    functionsUsed.add(r.function)
  }

  const { groups } = await groupInfo(sql, groupBy)
  const nodes: SankeyNode[] = [
    ...groups
      .filter((g) => groupsUsed.has(g.name))
      .map((g) => ({
        id: `g:${g.name}`,
        label: g.name,
        column: 'group' as const,
        title: `${g.name} (${g.samples} ${g.samples === 1 ? 'sample' : 'samples'})`,
      })),
    ...shown.map(([key, t], i) => ({ id: `t:${key}`, label: t.label, column: 'taxon' as const, title: t.path, colorSlot: i })),
  ]
  const otherTaxa = ranked.length - shown.length
  if (otherTaxa > 0) {
    nodes.push({
      id: OTHER_TAXA_ID,
      label: `Other (${otherTaxa} ${otherTaxa === 1 ? 'taxon' : 'taxa'})`,
      column: 'taxon',
      title: 'All other taxa combined',
      colorSlot: -1,
    })
  }
  nodes.push(
    ...functions
      .filter((f) => functionsUsed.has(f))
      .map((f) => ({ id: `f:${f}`, label: f, column: 'function' as const, title: f })),
  )

  return { nodes, links: [...linkMap.values()], flows: [...flowMap.values()], otherTaxa }
}
