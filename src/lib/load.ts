// Loading a user's delimited text file into DuckDB as the working table.
import { sqlIdent, sqlString, type Sql } from './sql'

/** Name of the table that holds the most recently loaded file. */
export const INPUT_TABLE = 'input_table'
const STAGING_TABLE = 'input_table_staging'

const SUPPORTED = /\.(tsv|tab|txt|csv)(\.gz)?$/i

export interface Column {
  name: string
  type: string
}

export interface LoadedTable {
  fileName: string
  rowCount: number
  columns: Column[]
}

/** A problem with the user's file, with a message fit to show them. */
export class LoadError extends Error {
  override name = 'LoadError'
}

let uploadCounter = 0
let queue: Promise<unknown> = Promise.resolve()

/**
 * Read a TSV, CSV or plain-text table (optionally gzipped) into INPUT_TABLE,
 * replacing whatever was loaded before. The first line must be a header.
 * Calls run one at a time, since they share the staging and input tables.
 */
export function loadTable(sql: Sql, fileName: string, data: Uint8Array | File): Promise<LoadedTable> {
  const run = queue.then(() => loadTableNow(sql, fileName, data))
  queue = run.catch(() => undefined)
  return run
}

async function loadTableNow(sql: Sql, fileName: string, data: Uint8Array | File): Promise<LoadedTable> {
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
  // .txt is usually tab-separated, and DuckDB's guess goes wrong when values contain ';' or ','
  // (e.g. taxonomy strings), so try tab first and only auto-detect if that finds a single column.
  const delims = ext === 'csv' ? [","] : ext === 'txt' ? ['\t', null] : ['\t']

  // Load into a staging table and only swap it in once it passes checks,
  // so a rejected file leaves the previous table untouched.
  const readWith = async (compression: string) => {
    for (const [i, delim] of delims.entries()) {
      const delimArg = delim === null ? '' : `, delim = ${sqlString(delim)}`
      await sql.query(
        `CREATE OR REPLACE TABLE ${sqlIdent(STAGING_TABLE)} AS
         SELECT * FROM read_csv(${sqlString(internalName)}, header = true, compression = '${compression}'${delimArg})`,
      )
      if (i === delims.length - 1) return
      const cols = await sql.query(`DESCRIBE ${sqlIdent(STAGING_TABLE)}`)
      if (cols.length > 1) return
    }
  }

  await sql.registerFile(internalName, data)
  try {
    try {
      await readWith(gz ? 'gzip' : 'none')
    } catch (err) {
      // Browsers sometimes decompress a download but keep the .gz name; read those as plain text.
      if (!(gz && /not a GZIP stream/i.test(firstLine(err)))) throw err
      await readWith('none')
    }
  } catch (err) {
    throw new LoadError(`Couldn't read "${fileName}": ${firstLine(err).replaceAll(internalName, fileName)}`)
  } finally {
    // The table now holds the data, so the file handle is no longer needed.
    await sql.dropFile(internalName)
  }

  const [{ n }] = await sql.query<{ n: bigint | number }>(`SELECT count(*) AS n FROM ${sqlIdent(STAGING_TABLE)}`)
  const rowCount = Number(n)
  if (rowCount === 0) {
    await sql.query(`DROP TABLE ${sqlIdent(STAGING_TABLE)}`)
    throw new LoadError(`"${fileName}" has a header but no data rows.`)
  }

  await sql.query(`DROP TABLE IF EXISTS ${sqlIdent(INPUT_TABLE)}`)
  await sql.query(`ALTER TABLE ${sqlIdent(STAGING_TABLE)} RENAME TO ${sqlIdent(INPUT_TABLE)}`)

  const described = await sql.query<{ column_name: string; column_type: string }>(
    `DESCRIBE ${sqlIdent(INPUT_TABLE)}`,
  )
  const columns = described.map((c) => ({ name: c.column_name, type: c.column_type }))
  return { fileName, rowCount, columns }
}

/** The first `limit` rows of the loaded table. */
export async function previewRows(sql: Sql, limit = 100): Promise<Record<string, unknown>[]> {
  return sql.query(`SELECT * FROM ${sqlIdent(INPUT_TABLE)} LIMIT ${Math.max(0, Math.floor(limit))}`)
}

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.split('\n')[0]
}
