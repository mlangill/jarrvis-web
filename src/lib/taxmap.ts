// An optional taxonomy file mapping the stratified table's taxon IDs (e.g. PICRUSt2 sequence
// IDs) to lineages. It is normalized into TAXMAP(id, lineage) with rank prefixes, which
// buildTaxonomy then parses in place of the ID.
import type { Column } from './load'
import { sqlIdent as id, sqlString, type Sql } from './sql'
import { STRAT, type Issue, type Result } from './validate'

export const TAXMAP_RAW = 'taxmap_raw'
export const TAXMAP = 'taxmap'

/**
 * SQL for the NCBI taxid in a Kraken-style taxon such as "Bacteroides fragilis (taxid 817)", or ''.
 * A taxonomy file keyed by taxid (e.g. from taxonkit) matches these taxa.
 */
export const TAXID_OF = (expr: string) => `regexp_extract(${expr}, '\\(taxid (\\d+)\\)\\s*$', 1)`

export interface TaxMapSummary {
  ids: number
  /** Where the lineage came from, for the panel, e.g. 'column "Taxon"' or 'rank columns'. */
  source: string
}

const PREFIXES = ['k__', 'p__', 'c__', 'o__', 'f__', 'g__', 's__']
/** Column names that hold one rank each (DADA2 style), with their prefix. */
const RANK_COLUMNS: [RegExp, string][] = [
  [/^(kingdom|domain)$/i, 'k__'],
  [/^phylum$/i, 'p__'],
  [/^class$/i, 'c__'],
  [/^order$/i, 'o__'],
  [/^family$/i, 'f__'],
  [/^genus$/i, 'g__'],
  [/^species$/i, 's__'],
]

const num = (v: unknown) => Number(v ?? 0)
const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`

/** SQL for the lineage of each row, and a description of where it comes from. */
function lineageExpr(columns: Column[]): { expr: string; source: string } | { error: string } {
  const names = columns.map((c) => c.name)
  if (names.length < 2) {
    return { error: `Expected an ID column and then a lineage (or one column per rank). Found only "${names[0]}".` }
  }
  const named = names.slice(1).find((n) => /^(taxon|taxonomy|lineage)$/i.test(n))
  const ranks = RANK_COLUMNS.map(([re, prefix]) => ({ prefix, col: names.slice(1).find((n) => re.test(n)) })).filter(
    (r) => r.col !== undefined,
  )
  if (!named && ranks.length >= 2) {
    const parts = ranks.map((r) => `${sqlString(r.prefix)} || nullif(trim(${id(r.col!)}), '')`)
    return { expr: `concat_ws('; ', ${parts.join(', ')})`, source: `rank columns (${ranks.map((r) => r.col).join(', ')})` }
  }
  const col = named ?? names[1]
  // A lineage without rank prefixes ("Bacteria; Firmicutes; ...") is read by position.
  const v = `trim(${id(col)})`
  const positional = `array_to_string(list_filter(list_transform(regexp_split_to_array(${v}, '\\s*[;|]\\s*'),
      (x, i) -> [${PREFIXES.map(sqlString).join(', ')}][i] || x), x -> x IS NOT NULL), '; ')`
  return {
    expr: `CASE WHEN regexp_matches(${v}, '(^|[;|.]\\s*)[a-zA-Z]__') THEN ${v} ELSE ${positional} END`,
    source: `column "${col}"`,
  }
}

/** Validate the taxonomy file in TAXMAP_RAW and, if it has no errors, build TAXMAP. */
export async function validateTaxonomyMap(sql: Sql, columns: Column[]): Promise<Result<TaxMapSummary>> {
  await dropTaxonomyMap(sql)
  const issues: Issue[] = []
  const lineage = lineageExpr(columns)
  if ('error' in lineage) return { issues: [{ severity: 'error', message: lineage.error }] }

  const key = id(columns[0].name)
  // QIIME 2 metadata-style files may have a "#q2:types" line; skip comment rows.
  const rows = `SELECT trim(${key}) AS id, ${lineage.expr} AS lineage FROM ${id(TAXMAP_RAW)}
                WHERE trim(coalesce(${key}, '')) <> '' AND NOT starts_with(trim(${key}), '#')`

  const dupes = await sql.query<{ id: string; n: bigint }>(
    `SELECT id, count(*) OVER () AS n FROM (${rows}) GROUP BY id HAVING count(*) > 1 LIMIT 3`,
  )
  if (dupes.length > 0) {
    issues.push({
      severity: 'warning',
      message: `${plural(num(dupes[0].n), 'ID appears', 'IDs appear')} more than once; the first lineage is used.`,
      examples: dupes.map((d) => d.id),
    })
  }
  await sql.query(`CREATE TABLE ${id(TAXMAP)} AS SELECT id, first(lineage) AS lineage FROM (${rows}) GROUP BY id`)

  const [c] = await sql.query(`SELECT count(*) AS n, count(*) FILTER (WHERE coalesce(lineage, '') = '') AS empty FROM ${id(TAXMAP)}`)
  if (num(c.n) === 0) {
    await dropTaxonomyMap(sql)
    return { issues: [{ severity: 'error', message: 'The taxonomy file has no IDs.' }] }
  }
  if (num(c.empty) > 0) {
    issues.push({ severity: 'warning', message: `${plural(num(c.empty), 'ID has', 'IDs have')} no lineage and will be Unclassified.` })
  }
  return { issues, summary: { ids: num(c.n), source: lineage.source } }
}

export async function dropTaxonomyMap(sql: Sql): Promise<void> {
  await sql.query(`DROP TABLE IF EXISTS ${id(TAXMAP)}`)
}

export async function hasTaxonomyMap(sql: Sql): Promise<boolean> {
  const [{ n }] = await sql.query(`SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = ${sqlString(TAXMAP)}`)
  return num(n) > 0
}

/** How many of the stratified table's taxa the taxonomy file covers. */
export async function taxonomyMatch(sql: Sql): Promise<Issue[]> {
  const taxa = `SELECT DISTINCT taxon FROM ${id(STRAT)}`
  const found = `(s.taxon IN (SELECT id FROM ${id(TAXMAP)}) OR ${TAXID_OF('s.taxon')} IN (SELECT id FROM ${id(TAXMAP)}))`
  const [c] = await sql.query(`SELECT count(*) AS total, count(*) FILTER (WHERE ${found}) AS matched FROM (${taxa}) s`)
  const [total, matched] = [num(c.total), num(c.matched)]
  if (matched === total) return []
  const missing = await sql.query<{ taxon: string }>(`SELECT s.taxon FROM (${taxa}) s WHERE NOT ${found} ORDER BY s.taxon LIMIT 5`)
  const examples = missing.map((m) => m.taxon)
  if (matched === 0) {
    return [
      {
        severity: 'warning',
        message: `None of the ${plural(total, 'taxon', 'taxa')} in the table are in the taxonomy file, so it has no effect. Its first column should hold the table's taxon IDs.`,
        examples,
      },
    ]
  }
  return [
    {
      severity: 'warning',
      message: `${plural(total - matched, 'taxon', 'taxa')} of ${total.toLocaleString()} in the table ${total - matched === 1 ? "isn't" : "aren't"} in the taxonomy file; ${total - matched === 1 ? 'it is' : 'they are'} kept as given.`,
      examples,
    },
  ]
}
