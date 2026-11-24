// Single shared DuckDB-WASM instance. All data loading and slicing goes through here.
// Bundles are served from this site (no CDN), so user data and the engine both stay local.
import * as duckdb from '@duckdb/duckdb-wasm'
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import type { Row, Sql } from './sql'

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
}

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null
let sqlPromise: Promise<Sql> | null = null

/** Returns the shared database, starting it on first call. */
export function getDb(): Promise<duckdb.AsyncDuckDB> {
  dbPromise ??= (async () => {
    const bundle = await duckdb.selectBundle(BUNDLES)
    const worker = new Worker(bundle.mainWorker!)
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker)
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
    return db
  })()
  return dbPromise
}

/** Returns the shared Sql interface over the browser database. */
export function getSql(): Promise<Sql> {
  sqlPromise ??= (async () => {
    const db = await getDb()
    const conn = await db.connect()
    return {
      async query<T extends Row = Row>(sql: string) {
        const table = await conn.query(sql)
        return table.toArray().map((r) => r.toJSON() as T)
      },
      async registerFile(name, data) {
        if (data instanceof Uint8Array) {
          await db.registerFileBuffer(name, data)
        } else {
          // Reads the file lazily from disk instead of copying it all into memory.
          await db.registerFileHandle(name, data, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true)
        }
      },
      async dropFile(name) {
        await db.dropFile(name)
      },
    }
  })()
  return sqlPromise
}

/** DuckDB engine version, used as a startup check. */
export async function duckdbVersion(): Promise<string> {
  const db = await getDb()
  return db.getVersion()
}
