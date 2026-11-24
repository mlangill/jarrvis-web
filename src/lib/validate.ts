// Checks for the two version-1 inputs: the 4-column stratified table and the sample metadata.
// Both are loaded as all-text tables (STRAT_RAW, META_RAW); validation finds problems and, when
// there are no errors, writes the clean typed tables (STRAT, META) that every view reads from.
import { conversion, detectFormat, type StratFormat } from './formats'
import { describeTable, type Column } from './load'
import { sqlIdent as id, sqlString, type Sql } from './sql'

export const STRAT_RAW = 'strat_raw'
/** STRAT_RAW converted to the 4 columns, when it was in another format. */
export const STRAT_CONVERTED = 'strat_converted'
export const STRAT = 'strat'
export const META_RAW = 'metadata_raw'
export const META = 'metadata'

/** error blocks the data from being used; warning and info don't. */
export type Severity = 'error' | 'warning' | 'info'

export interface Issue {
  severity: Severity
  message: string
  examples?: string[]
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === 'error')

export interface StratifiedSummary {
  /** The format the table was read as. */
  format: StratFormat
  rows: number
  samples: number
  taxa: number
  functions: number
}

export interface GroupColumn {
  name: string
  levels: number
}

export interface MetadataSummary {
  samples: number
  idColumn: string
  groupColumns: GroupColumn[]
}

export interface CrossSummary {
  matched: number
}

export interface Result<S> {
  issues: Issue[]
  /** Present only when there are no errors. */
  summary?: S
}

const EXAMPLES = 5
/** Contribution values treated as missing rather than malformed. */
const MISSING = ['', 'NA', 'N/A', 'NaN', 'nan', 'null', 'NULL', '-']
const missingList = MISSING.map(sqlString).join(', ')

const num = (v: unknown) => Number(v ?? 0)
const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : pluralWord}`

/**
 * Validate the stratified table in STRAT_RAW and, if it has no errors, build STRAT. A table in
 * another format (detected, or as given) is first converted into STRAT_CONVERTED; STRAT_RAW is
 * left as loaded, so it can be validated again as a different format.
 */
export async function validateStratified(
  sql: Sql,
  rawColumns: Column[],
  requested: StratFormat | 'auto' = 'auto',
): Promise<Result<StratifiedSummary>> {
  await sql.query(`DROP TABLE IF EXISTS ${id(STRAT)}`)
  await sql.query(`DROP TABLE IF EXISTS ${id(STRAT_CONVERTED)}`)
  const issues: Issue[] = []
  const format = requested === 'auto' ? detectFormat(rawColumns) : requested
  let raw = id(STRAT_RAW)
  let columns = rawColumns

  if (format !== 'jarrvis') {
    const conv = conversion(format, rawColumns, raw)
    if ('error' in conv) return { issues: [{ severity: 'error', message: conv.error }] }
    if (conv.check) {
      const [{ n }] = await sql.query(conv.check.sql)
      if (num(n) === 0) return { issues: [{ severity: 'error', message: conv.check.error }] }
    }
    await sql.query(`CREATE TABLE ${id(STRAT_CONVERTED)} AS SELECT * FROM (${conv.select})`)
    raw = id(STRAT_CONVERTED)
    columns = await describeTable(sql, STRAT_CONVERTED)
    issues.push({ severity: 'info', message: conv.note })
  }

  if (columns.length !== 4) {
    issues.push({
      severity: 'error',
      message: `Expected 4 columns in this order: sample, taxon, function, contribution. Instead found ${plural(columns.length, 'column')}: ${columns.map((c) => c.name).join(', ')}.`,
    })
    return { issues }
  }

  const [s, t, f, c] = columns.map((col) => id(col.name))
  const valueCol = columns[3].name
  const value = `trim(coalesce(${c}, ''))`
  const isMissing = `${value} IN (${missingList})`
  const isBad = `NOT ${isMissing} AND TRY_CAST(${value} AS DOUBLE) IS NULL`
  const blank = (col: string) => `trim(coalesce(${col}, '')) = ''`

  // A numeric "column name" in the contribution slot means the file has no header line.
  if (valueCol.trim() !== '' && !Number.isNaN(Number(valueCol))) {
    issues.push({
      severity: 'error',
      message: `The first line looks like data rather than a header (its last value is ${valueCol}). Add a header line, such as: sample, taxon, function, contribution.`,
    })
    return { issues }
  }

  const [counts] = await sql.query(`
    SELECT
      count(*) AS n,
      count(*) FILTER (WHERE ${blank(s)}) AS no_sample,
      count(*) FILTER (WHERE ${blank(f)}) AS no_function,
      count(*) FILTER (WHERE ${blank(t)}) AS no_taxon,
      count(*) FILTER (WHERE ${isMissing}) AS no_value,
      count(*) FILTER (WHERE ${isBad}) AS bad_value,
      count(*) FILTER (WHERE TRY_CAST(${value} AS DOUBLE) < 0) AS negative
    FROM ${raw}`)
  const n = num(counts.n)

  const badValues = num(counts.bad_value)
  if (badValues > 0) {
    const examples = await sql.query<{ v: string }>(
      `SELECT DISTINCT ${value} AS v FROM ${raw} WHERE ${isBad} LIMIT ${EXAMPLES}`,
    )
    issues.push({
      severity: 'error',
      message:
        `${plural(badValues, 'row has', 'rows have')} a contribution (column 4, "${valueCol}") that isn't a number.` +
        (badValues === n ? ' Check the column order: sample, taxon, function, contribution.' : ''),
      examples: examples.map((e) => e.v),
    })
  }
  if (num(counts.no_sample) > 0) {
    issues.push({ severity: 'error', message: `${plural(num(counts.no_sample), 'row has', 'rows have')} no sample ID (column 1, "${columns[0].name}").` })
  }
  if (num(counts.no_function) > 0) {
    issues.push({ severity: 'error', message: `${plural(num(counts.no_function), 'row has', 'rows have')} no function (column 3, "${columns[2].name}").` })
  }
  if (num(counts.no_taxon) > 0) {
    issues.push({ severity: 'warning', message: `${plural(num(counts.no_taxon), 'row has', 'rows have')} no taxon (column 2, "${columns[1].name}"). They'll be grouped as "unclassified".` })
  }
  if (num(counts.no_value) > 0) {
    issues.push({
      severity: 'warning',
      message: `${plural(num(counts.no_value), 'row has', 'rows have')} no contribution value (empty or NA) and will be left out.`,
    })
  }
  if (num(counts.negative) > 0) {
    issues.push({ severity: 'warning', message: `${plural(num(counts.negative), 'row has', 'rows have')} a negative contribution.` })
  }

  const dupes = await sql.query<{ k: string; n: bigint }>(`
    SELECT concat_ws(' / ', trim(${s}), trim(${t}), trim(${f})) AS k, count(*) OVER () AS n
    FROM ${raw} GROUP BY trim(${s}), trim(${t}), trim(${f}) HAVING count(*) > 1 LIMIT 3`)
  if (dupes.length > 0) {
    issues.push({
      severity: 'info',
      message: `${plural(num(dupes[0].n), 'sample / taxon / function combination appears', 'sample / taxon / function combinations appear')} more than once. Their contributions will be added together (common when several strains share a species name).`,
      examples: dupes.map((d) => d.k),
    })
  }

  if (hasErrors(issues)) return { issues }

  await sql.query(`
    CREATE TABLE ${id(STRAT)} AS
    SELECT
      trim(${s}) AS sample,
      coalesce(nullif(trim(${t}), ''), 'unclassified') AS taxon,
      trim(${f}) AS function,
      CAST(${value} AS DOUBLE) AS contribution
    FROM ${raw}
    WHERE NOT ${isMissing}`)

  const [sum] = await sql.query(`
    SELECT count(*) AS rows, count(DISTINCT sample) AS samples, count(DISTINCT taxon) AS taxa,
           count(DISTINCT function) AS functions, count(*) FILTER (WHERE contribution <> 0) AS nonzero
    FROM ${id(STRAT)}`)
  if (num(sum.rows) === 0) {
    await sql.query(`DROP TABLE ${id(STRAT)}`)
    return { issues: [...issues, { severity: 'error', message: 'No rows have a contribution value.' }] }
  }
  if (num(sum.nonzero) === 0) issues.push({ severity: 'warning', message: 'Every contribution is zero.' })

  return {
    issues,
    summary: { format, rows: num(sum.rows), samples: num(sum.samples), taxa: num(sum.taxa), functions: num(sum.functions) },
  }
}

/** Validate the metadata in META_RAW and, if it has no errors, build META (first column renamed sample_id). */
export async function validateMetadata(sql: Sql, columns: Column[]): Promise<Result<MetadataSummary>> {
  await sql.query(`DROP TABLE IF EXISTS ${id(META)}`)
  const issues: Issue[] = []
  const raw = id(META_RAW)

  if (columns.length < 2) {
    issues.push({
      severity: 'error',
      message: `Metadata needs a sample ID column first, then at least one column to group samples by (for example: sample_id, type). Found only one column, "${columns[0]?.name ?? ''}". If the file has more, check that it's tab- or comma-separated.`,
    })
    return { issues }
  }

  const idColumn = columns[0].name
  const sid = id(idColumn)
  const groups = columns.slice(1).filter((c) => c.name.toLowerCase() !== 'sample_id')
  if (groups.length < columns.length - 1) {
    issues.push({
      severity: 'warning',
      message: `Sample IDs are taken from the first column, "${idColumn}", so the other column named "sample_id" is ignored.`,
    })
  }

  const [counts] = await sql.query(`
    SELECT count(*) FILTER (WHERE trim(coalesce(${sid}, '')) = '') AS blank FROM ${raw}`)
  if (num(counts.blank) > 0) {
    issues.push({ severity: 'error', message: `${plural(num(counts.blank), 'row has', 'rows have')} no sample ID (column 1, "${idColumn}").` })
  }

  const dupes = await sql.query<{ v: string; n: bigint }>(`
    SELECT trim(${sid}) AS v, count(*) OVER () AS n FROM ${raw}
    WHERE trim(coalesce(${sid}, '')) <> ''
    GROUP BY trim(${sid}) HAVING count(*) > 1 LIMIT ${EXAMPLES}`)
  if (dupes.length > 0) {
    issues.push({
      severity: 'error',
      message: `${plural(num(dupes[0].n), 'sample ID appears', 'sample IDs appear')} more than once. Each sample needs exactly one row.`,
      examples: dupes.map((d) => d.v),
    })
  }

  if (hasErrors(issues)) return { issues }

  const select = groups.map((g) => `nullif(trim(${id(g.name)}), '') AS ${id(g.name)}`)
  await sql.query(`
    CREATE TABLE ${id(META)} AS
    SELECT trim(${sid}) AS sample_id${select.length ? ', ' + select.join(', ') : ''} FROM ${raw}`)

  const groupColumns: GroupColumn[] = []
  if (groups.length > 0) {
    const [levels] = await sql.query(
      `SELECT ${groups.map((g, i) => `count(DISTINCT ${id(g.name)}) AS c${i}`).join(', ')} FROM ${id(META)}`,
    )
    groups.forEach((g, i) => {
      const n = num(levels[`c${i}`])
      if (n === 0) issues.push({ severity: 'warning', message: `Column "${g.name}" is empty, so it can't be used for grouping.` })
      else groupColumns.push({ name: g.name, levels: n })
    })
  }
  const [{ n }] = await sql.query(`SELECT count(*) AS n FROM ${id(META)}`)

  return { issues, summary: { samples: num(n), idColumn, groupColumns } }
}

/** Compare sample IDs between STRAT and META. Both must exist (i.e. passed validation). */
export async function crossCheck(sql: Sql): Promise<Result<CrossSummary>> {
  const issues: Issue[] = []
  const [c] = await sql.query(`
    WITH d AS (SELECT DISTINCT sample FROM ${id(STRAT)}), m AS (SELECT sample_id FROM ${id(META)})
    SELECT
      (SELECT count(*) FROM d) AS in_table,
      (SELECT count(*) FROM m) AS in_meta,
      (SELECT count(*) FROM d JOIN m ON sample = sample_id) AS matched,
      (SELECT count(*) FROM d JOIN m ON lower(sample) = lower(sample_id)) AS matched_nocase`)
  const matched = num(c.matched)
  const onlyTable = (limit: number) =>
    sql.query<{ v: string }>(`
      SELECT sample AS v FROM (SELECT DISTINCT sample FROM ${id(STRAT)})
      WHERE sample NOT IN (SELECT sample_id FROM ${id(META)}) ORDER BY sample LIMIT ${limit}`)
  const onlyMeta = (limit: number) =>
    sql.query<{ v: string }>(`
      SELECT sample_id AS v FROM ${id(META)}
      WHERE sample_id NOT IN (SELECT DISTINCT sample FROM ${id(STRAT)}) ORDER BY sample_id LIMIT ${limit}`)

  if (matched === 0) {
    const [t, m] = await Promise.all([onlyTable(3), onlyMeta(3)])
    issues.push({
      severity: 'error',
      message:
        `None of the ${plural(num(c.in_table), 'sample')} in the table match a sample ID in the metadata.` +
        (num(c.matched_nocase) > 0 ? ' They do match if upper and lower case are ignored, so check the capitalization.' : ''),
      examples: [...t.map((r) => `table: ${r.v}`), ...m.map((r) => `metadata: ${r.v}`)],
    })
    return { issues }
  }

  const missingFromMeta = num(c.in_table) - matched
  if (missingFromMeta > 0) {
    issues.push({
      severity: 'warning',
      message: `${plural(missingFromMeta, 'sample')} in the table ${missingFromMeta === 1 ? "isn't" : "aren't"} in the metadata and will be left out.`,
      examples: (await onlyTable(EXAMPLES)).map((r) => r.v),
    })
  }
  const missingFromTable = num(c.in_meta) - matched
  if (missingFromTable > 0) {
    issues.push({
      severity: 'warning',
      message: `${plural(missingFromTable, 'sample')} in the metadata ${missingFromTable === 1 ? 'has' : 'have'} no rows in the table.`,
      examples: (await onlyMeta(EXAMPLES)).map((r) => r.v),
    })
  }
  return { issues, summary: { matched } }
}
