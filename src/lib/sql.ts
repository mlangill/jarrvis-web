// Minimal SQL interface the data layer is written against. The browser implementation wraps
// DuckDB-WASM (db.ts); tests use DuckDB's Node build (src/test/nodeSql.ts). Keeping data
// logic behind this lets it be tested in Node without a browser.

export type Row = Record<string, unknown>

export interface Sql {
  /** Run a statement and return its rows as plain objects. Integers may come back as bigint. */
  query<T extends Row = Row>(sql: string): Promise<T[]>
  /** Make bytes or a browser File readable by DuckDB under `name`. */
  registerFile(name: string, data: Uint8Array | File): Promise<void>
  /** Forget a file registered with registerFile. */
  dropFile(name: string): Promise<void>
}

/**
 * Statements run once on a new connection. Tables go in an in-memory database with compression,
 * which DuckDB applies at CHECKPOINT: the stratified table shrinks about 2.5× (ENUM keys
 * bit-packed, values ALP-encoded), with no change in query speed.
 */
export const SETUP_SQL = [`ATTACH ':memory:' AS jarrvis (COMPRESS)`, 'USE jarrvis']

/** Quote a string as a SQL literal. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Quote a name as a SQL identifier. */
export function sqlIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}
