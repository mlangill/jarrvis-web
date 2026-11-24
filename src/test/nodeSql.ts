// Sql implementation over DuckDB-WASM's synchronous Node build, for tests.
// Same engine and SQL dialect as the browser, without needing a worker.
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Row, Sql } from '../lib/sql'

const require = createRequire(import.meta.url)
const entry = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs')
const duckdb = require(entry) as typeof import('@duckdb/duckdb-wasm/blocking')
const dist = path.dirname(entry)

export async function createNodeSql(): Promise<Sql> {
  const db = await duckdb.createDuckDB(
    {
      mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
      eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  )
  await db.instantiate()
  const conn = db.connect()
  return {
    async query<T extends Row = Row>(sql: string) {
      return conn.query(sql).toArray().map((r) => r.toJSON() as T)
    },
    async registerFile(name, data) {
      if (!(data instanceof Uint8Array)) throw new Error('Node tests register byte buffers only')
      db.registerFileBuffer(name, data)
    },
    async dropFile(name) {
      db.dropFile(name)
    },
  }
}
