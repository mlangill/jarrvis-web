// Loading a user's delimited text file into DuckDB as the working table.
import { sqlIdent, sqlString, type Sql } from './sql'

/** Default table for a loaded file. */
export const INPUT_TABLE = 'input_table'

const SUPPORTED = /\.(tsv|tab|txt|csv)(\.gz)?$/i

export interface Column {
  name: string
  type: string
}

export interface LoadedTable {
  fileName: string
  /** Rows read, or null for a lazy table (counting would mean reading the whole file). */
  rowCount: number | null
  columns: Column[]
}

export interface LoadOptions {
  /** Table to load into, replacing it. Defaults to INPUT_TABLE. */
  table?: string
  /** Read every column as text, leaving type checks to the caller (keeps IDs like "007" intact). */
  allVarchar?: boolean
  /**
   * Make `table` a view over the file instead of copying it into memory. Each query then reads the
   * file again, so this suits big inputs that are converted once (the stratified table). The file
   * stays registered until the table is replaced or released with releaseTable.
   */
  lazy?: boolean
}

/** A problem with the user's file, with a message fit to show them. */
export class LoadError extends Error {
  override name = 'LoadError'
}

let uploadCounter = 0
let queue: Promise<unknown> = Promise.resolve()
/** The user's file name for each registered internal name, for error messages. */
const userNames = new Map<string, string>()
/** The registered file behind each lazy table. */
const lazyFiles = new Map<string, string>()

/**
 * Read a TSV, CSV or plain-text table (optionally gzipped) into a table, replacing whatever
 * was loaded there before. The first line must be a header. Calls run one at a time.
 */
export function loadTable(
  sql: Sql,
  fileName: string,
  data: Uint8Array | File,
  options: LoadOptions = {},
): Promise<LoadedTable> {
  const run = queue.then(() => loadTableNow(sql, fileName, data, options))
  queue = run.catch(() => undefined)
  return run
}

async function loadTableNow(
  sql: Sql,
  fileName: string,
  data: Uint8Array | File,
  { table = INPUT_TABLE, allVarchar = false, lazy = false }: LoadOptions,
): Promise<LoadedTable> {
  const STAGING_TABLE = `${table}__staging`
  const match = SUPPORTED.exec(fileName)
  if (!match) {
    throw new LoadError(
      `"${fileName}" isn't a supported file type. Use a .tsv, .csv or .txt file, optionally gzipped (.gz).`,
    )
  }
  const size = data instanceof Uint8Array ? data.byteLength : data.size
  if (size === 0) throw new LoadError(`"${fileName}" is empty.`)

  const ext = match[1].toLowerCase()
  const gz = match[2] ? '.gz' : ''
  // Register under a generated name so odd characters in the user's file name can't break the SQL,
  // keeping the extension so DuckDB detects gzip compression.
  const internalName = `upload_${++uploadCounter}.${ext}${gz}`
  userNames.set(internalName, fileName)
  const kind = lazy ? 'VIEW' : 'TABLE'
  // .txt is usually tab-separated, and DuckDB's guess goes wrong when values contain ';' or ','
  // (e.g. taxonomy strings), so try tab first and only auto-detect if that finds a single column.
  const delims = ext === 'csv' ? [","] : ext === 'txt' ? ['\t', null] : ['\t']

  // Load into a staging table and only swap it in once it passes checks,
  // so a rejected file leaves the previous table untouched.
  const readWith = async (compression: string) => {
    for (const [i, delim] of delims.entries()) {
      const delimArg = delim === null ? '' : `, delim = ${sqlString(delim)}`
      await sql.query(
        `CREATE OR REPLACE ${kind} ${sqlIdent(STAGING_TABLE)} AS
         SELECT * FROM read_csv(${sqlString(internalName)}, header = true, compression = '${compression}'${delimArg}${allVarchar ? ', all_varchar = true' : ''})`,
      )
      if (i === delims.length - 1) return
      const cols = await sql.query(`DESCRIBE ${sqlIdent(STAGING_TABLE)}`)
      if (cols.length > 1) return
    }
  }

  await sql.registerFile(internalName, data)
  let keepFile = false
  try {
    try {
      await readWith(gz ? 'gzip' : 'none')
    } catch (err) {
      // Browsers sometimes decompress a download but keep the .gz name; read those as plain text.
      if (!(gz && /not a GZIP stream/i.test(firstLine(err)))) throw err
      await readWith('none')
    }
    keepFile = lazy
  } catch (err) {
    throw new LoadError(`Couldn't read "${fileName}": ${userMessage(err)}`)
  } finally {
    // A copied table now holds the data, so the file handle is no longer needed; a view still reads it.
    if (!keepFile) await sql.dropFile(internalName)
  }

  const counted = lazy
    ? `SELECT count(*) AS n FROM (SELECT 1 FROM ${sqlIdent(STAGING_TABLE)} LIMIT 1)`
    : `SELECT count(*) AS n FROM ${sqlIdent(STAGING_TABLE)}`
  let n: bigint | number
  try {
    ;[{ n }] = await sql.query<{ n: bigint | number }>(counted)
  } catch (err) {
    await dropRelation(sql, STAGING_TABLE)
    if (lazy) await sql.dropFile(internalName)
    throw new LoadError(`Couldn't read "${fileName}": ${userMessage(err)}`)
  }
  if (Number(n) === 0) {
    await dropRelation(sql, STAGING_TABLE)
    if (lazy) await sql.dropFile(internalName)
    throw new LoadError(`"${fileName}" has a header but no data rows.`)
  }

  await releaseTable(sql, table)
  await sql.query(`ALTER ${kind} ${sqlIdent(STAGING_TABLE)} RENAME TO ${sqlIdent(table)}`)
  if (lazy) lazyFiles.set(table, internalName)

  return { fileName, rowCount: lazy ? null : Number(n), columns: await describeTable(sql, table) }
}

/** Drop a table or view by name, if it exists. */
async function dropRelation(sql: Sql, name: string): Promise<void> {
  const [found] = await sql.query<{ t: string }>(
    `SELECT table_type AS t FROM information_schema.tables WHERE table_name = ${sqlString(name)}`,
  )
  if (!found) return
  await sql.query(`DROP ${found.t === 'VIEW' ? 'VIEW' : 'TABLE'} ${sqlIdent(name)}`)
}

/** Drop a loaded table (or lazy view) and release the file behind it. */
export async function releaseTable(sql: Sql, table: string): Promise<void> {
  await dropRelation(sql, table)
  const file = lazyFiles.get(table)
  if (file) {
    lazyFiles.delete(table)
    await sql.dropFile(file)
  }
}

/** An error's first line, with internal file names replaced by the user's. */
export function userMessage(err: unknown): string {
  let msg = firstLine(err)
  for (const [internal, name] of userNames) msg = msg.replaceAll(internal, name)
  return msg
}

/** Column names and types of a table. */
export async function describeTable(sql: Sql, table: string): Promise<Column[]> {
  const described = await sql.query<{ column_name: string; column_type: string }>(`DESCRIBE ${sqlIdent(table)}`)
  return described.map((c) => ({ name: c.column_name, type: c.column_type }))
}

/** The first `limit` rows of a table. */
export async function previewRows(sql: Sql, limit = 100, table = INPUT_TABLE): Promise<Record<string, unknown>[]> {
  return sql.query(`SELECT * FROM ${sqlIdent(table)} LIMIT ${Math.max(0, Math.floor(limit))}`)
}

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0]
}
