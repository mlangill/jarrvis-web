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
  limit?: number
}

/**
 * Collapse taxa to `level`, then summarize contributions per group × taxon × function into GROUPED.
 * Mean is the group total divided by the number of samples in the group that have data, so a
 * sample with no row for a taxon/function counts as zero.
 */
export async function groupTable(sql: Sql, { groupBy, level, stat, limit = 200 }: GroupOptions): Promise<GroupedResult> {
  const tx = taxonExprs(level)
  const g = id(groupBy)
  const value = stat === 'mean' ? 'a.total / n.samples' : 'a.total'
  await sql.query(`
    CREATE OR REPLACE TABLE ${id(GROUPED)} AS
    WITH
      tx AS (SELECT taxon, ${tx.key} AS tkey, ${tx.label} AS tlabel, ${tx.path} AS tpath FROM ${id(TAXONOMY)}),
      gs AS (
        SELECT sample_id, ${g} AS grp FROM ${id(META)}
        WHERE ${g} IS NOT NULL AND sample_id IN (SELECT DISTINCT sample FROM ${id(STRAT)})
      ),
      n AS (SELECT grp, count(*) AS samples FROM gs GROUP BY grp),
      a AS (
        SELECT gs.grp, tx.tkey, any_value(tx.tlabel) AS tlabel, any_value(tx.tpath) AS tpath, s.function, sum(s.contribution) AS total
        FROM ${id(STRAT)} s JOIN gs ON s.sample = gs.sample_id JOIN tx USING (taxon)
        GROUP BY gs.grp, tx.tkey, s.function
      )
    SELECT a.grp AS "group", a.tlabel AS taxon, a.tpath AS path, a.function, ${value} AS value, n.samples
    FROM a JOIN n USING (grp)`)

  const groups = await sql.query<{ name: string; samples: bigint }>(`
    SELECT ${g} AS name, count(*) AS samples FROM ${id(META)}
    WHERE ${g} IS NOT NULL AND sample_id IN (SELECT DISTINCT sample FROM ${id(STRAT)})
    GROUP BY ${g} ORDER BY ${g}`)
  const [{ ungrouped }] = await sql.query(`
    SELECT count(*) AS ungrouped FROM ${id(META)}
    WHERE ${g} IS NULL AND sample_id IN (SELECT DISTINCT sample FROM ${id(STRAT)})`)
  const [{ n }] = await sql.query(`SELECT count(*) AS n FROM ${id(GROUPED)}`)
  const rows = await sql.query<GroupedRow>(`
    SELECT "group", taxon, path, function, value FROM ${id(GROUPED)}
    ORDER BY value DESC, "group", taxon, function LIMIT ${Math.max(0, Math.floor(limit))}`)

  return {
    groups: groups.map((r) => ({ name: r.name, samples: Number(r.samples) })),
    ungroupedSamples: Number(ungrouped),
    totalRows: Number(n),
    rows,
  }
}
