// Checks for the two version-1 inputs: the 4-column stratified table and the sample metadata.
// Both are loaded as all-text tables (STRAT_RAW, META_RAW); validation finds problems and, when
// there are no errors, writes the clean typed tables (STRAT, META) that every view reads from.
import { conversion, detectFormat, type StratFormat } from './formats'
import { describeTable, releaseTable, type Column } from './load'
import { sqlIdent as id, sqlString, type Sql } from './sql'

export const STRAT_RAW = 'strat_raw'
/** A view of STRAT_RAW as the 4 columns, when it was in another format (a view, so big inputs aren't copied). */
export const STRAT_CONVERTED = 'strat_converted'
export const STRAT = 'strat'
/** Counts and distinct names from the first pass over the stratified table. */
const STRAT_NAMES = 'strat_names'
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
/** Chunk sizes for big stratified tables; tests lower them to exercise chunking. */
export const chunking = {
  /** Rows built per pass over the file when making STRAT (about 0.7 GB before compression). */
  build: 30_000_000,
  /** Rows per chunk when checking for repeated rows. */
  dupes: 2_000_000,
}
/** Contribution values treated as missing rather than malformed. */
const MISSING = ['', 'NA', 'N/A', 'NaN', 'nan', 'null', 'NULL', '-']
const missingList = MISSING.map(sqlString).join(', ')

const num = (v: unknown) => Number(v ?? 0)
const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : pluralWord}`

/**
 * Validate the stratified table in STRAT_RAW and, if it has no errors, build STRAT. STRAT_RAW is
 * normally a lazy view over the file (loadTable's `lazy`), and a table in another format is read
 * through the STRAT_CONVERTED view, so the input is never copied into memory as text: one pass
 * gathers counts and names, a second builds STRAT. On success STRAT_RAW is released, so reading
 * the file as another format means loading it again. After an error it is kept for the preview.
 */
export async function validateStratified(
  sql: Sql,
  rawColumns: Column[],
  requested: StratFormat | 'auto' = 'auto',
): Promise<Result<StratifiedSummary>> {
  await sql.query(`DROP TABLE IF EXISTS ${id(STRAT)}`)
  await sql.query('CHECKPOINT') // frees the old table's blocks
  await sql.query(`DROP VIEW IF EXISTS ${id(STRAT_CONVERTED)}`)
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
    await sql.query(`CREATE VIEW ${id(STRAT_CONVERTED)} AS SELECT * FROM (${conv.select})`)
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

  // Pass 1 over the file: counts for the checks, and the distinct names for the ENUM types.
  const sample = `trim(${s})`
  const taxon = `coalesce(nullif(trim(${t}), ''), 'unclassified')`
  const fn = `trim(${f})`
  await sql.query(`
    CREATE OR REPLACE TEMP TABLE ${id(STRAT_NAMES)} AS SELECT
      count(*) AS n,
      count(*) FILTER (WHERE ${blank(s)}) AS no_sample,
      count(*) FILTER (WHERE ${blank(f)}) AS no_function,
      count(*) FILTER (WHERE ${blank(t)}) AS no_taxon,
      count(*) FILTER (WHERE ${isMissing}) AS no_value,
      count(*) FILTER (WHERE ${isBad}) AS bad_value,
      count(*) FILTER (WHERE TRY_CAST(${value} AS DOUBLE) < 0) AS negative,
      list(DISTINCT ${sample}) FILTER (WHERE NOT ${blank(s)}) AS samples,
      list(DISTINCT ${taxon}) AS taxa,
      list(DISTINCT ${fn}) FILTER (WHERE NOT ${blank(f)}) AS functions
    FROM ${raw}`)
  const [counts] = await sql.query(`SELECT * EXCLUDE (samples, taxa, functions) FROM ${id(STRAT_NAMES)}`)
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

  if (hasErrors(issues)) {
    await sql.query(`DROP TABLE IF EXISTS ${id(STRAT_NAMES)}`)
    return { issues }
  }

  // Sample, taxon and function names are stored once each, as ENUM types (sorted, so ORDER BY
  // still sorts by name), which makes STRAT about a third of the size with plain text.
  await dropOldTypes(sql)
  const serial = ++typeSerial
  const types = { samples: `strat_sample_${serial}`, taxa: `strat_taxon_${serial}`, functions: `strat_function_${serial}` }
  for (const [col, type] of Object.entries(types)) {
    await sql.query(`CREATE TYPE ${id(type)} AS ENUM (SELECT unnest(list_sort(${col})) FROM ${id(STRAT_NAMES)})`)
    stratTypes.push(type)
  }
  await sql.query(`DROP TABLE ${id(STRAT_NAMES)}`)

  // Pass 2 over the file: the clean table. Rows are held uncompressed until a CHECKPOINT
  // compresses them, so a big table is built in chunks of functions, each a pass over the file,
  // with a checkpoint after each to keep the uncompressed part to about chunking.build rows.
  await sql.query(`
    CREATE TABLE ${id(STRAT)} (sample ${id(types.samples)}, taxon ${id(types.taxa)}, function ${id(types.functions)}, contribution DOUBLE)`)
  const parts = Math.max(1, Math.ceil((n - num(counts.no_value)) / chunking.build))
  for (let i = 0; i < parts; i++) {
    await sql.query(`
      INSERT INTO ${id(STRAT)}
      SELECT ${sample}, ${taxon}, ${fn}, CAST(${value} AS DOUBLE)
      FROM ${raw}
      WHERE NOT ${isMissing} ${parts > 1 ? `AND hash(${fn}) % ${parts} = ${i}` : ''}`)
    await sql.query('CHECKPOINT')
  }

  const [sum] = await sql.query(`
    SELECT count(*) AS rows, count(DISTINCT sample) AS samples, count(DISTINCT taxon) AS taxa,
           count(DISTINCT function) AS functions, count(*) FILTER (WHERE contribution <> 0) AS nonzero
    FROM ${id(STRAT)}`)
  if (num(sum.rows) === 0) {
    await sql.query(`DROP TABLE ${id(STRAT)}`)
    return { issues: [...issues, { severity: 'error', message: 'No rows have a contribution value.' }] }
  }
  if (num(sum.nonzero) === 0) issues.push({ severity: 'warning', message: 'Every contribution is zero.' })

  // Repeated sample / taxon / function rows. Grouping every row at once needs a hash table as big
  // as STRAT, so it runs on chunks of samples of about chunking.dupes rows each.
  const chunks = Math.max(1, Math.ceil(num(sum.rows) / chunking.dupes))
  let dupeCount = 0
  const dupeExamples: string[] = []
  for (let i = 0; i < chunks; i++) {
    const dupes = await sql.query<{ k: string; n: bigint }>(`
      SELECT concat_ws(' / ', sample::VARCHAR, taxon::VARCHAR, function::VARCHAR) AS k, count(*) OVER () AS n
      FROM ${id(STRAT)} ${chunks > 1 ? `WHERE enum_code(sample) % ${chunks} = ${i}` : ''}
      GROUP BY sample, taxon, function HAVING count(*) > 1 LIMIT 3`)
    if (dupes.length === 0) continue
    dupeCount += num(dupes[0].n)
    dupeExamples.push(...dupes.map((d) => d.k))
  }
  if (dupeCount > 0) {
    issues.push({
      severity: 'info',
      message: `${plural(dupeCount, 'sample / taxon / function combination appears', 'sample / taxon / function combinations appear')} more than once. Their contributions will be added together (common when several strains share a species name).`,
      examples: dupeExamples.slice(0, 3),
    })
  }

  // The file isn't needed again: changing the format re-reads it.
  await sql.query(`DROP VIEW IF EXISTS ${id(STRAT_CONVERTED)}`)
  await releaseTable(sql, STRAT_RAW)

  return {
    issues,
    summary: { format, rows: num(sum.rows), samples: num(sum.samples), taxa: num(sum.taxa), functions: num(sum.functions) },
  }
}

let typeSerial = 0
/** ENUM types made for earlier STRAT tables, dropped once nothing uses them. */
let stratTypes: string[] = []

async function dropOldTypes(sql: Sql) {
  const kept: string[] = []
  for (const type of stratTypes) {
    try {
      await sql.query(`DROP TYPE IF EXISTS ${id(type)}`)
    } catch {
      kept.push(type) // still used by a table built from the old STRAT; try again next time
    }
  }
  stratTypes = kept
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
