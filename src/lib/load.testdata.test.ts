// Loads the committed files in test-data/ (see test-data/README.md).
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { createNodeSql } from '../test/nodeSql'
import type { Sql } from './sql'
import { loadTable } from './load'

const file = (p: string) => new Uint8Array(readFileSync(new URL(`../../test-data/${p}`, import.meta.url)))
const names = (t: { columns: { name: string }[] }) => t.columns.map((c) => c.name)

let sql: Sql
beforeAll(async () => {
  sql = await createNodeSql()
})

describe('test-data files', () => {
  it('TSD 4-column subset', async () => {
    const t = await loadTable(sql, 'TSD-EC-stratified-subset.tsv', file('jarrvis/TSD-EC-stratified-subset.tsv'))
    expect(t.rowCount).toBe(3580)
    expect(names(t)).toEqual(['Sample', 'Genus', 'Gene', 'Contribution'])
    expect(t.columns[3].type).toBe('DOUBLE')
  })

  it('TSD metadata', async () => {
    const t = await loadTable(sql, 'TSD-sample-metadata.txt', file('jarrvis/TSD-sample-metadata.txt'))
    expect(t.rowCount).toBe(10)
    expect(names(t)).toEqual(['sample_id', 'type'])
  })

  it.each([
    ['picrust2/metagenome_contrib.tsv.gz', 'sample'],
    ['picrust2/metagenome_contrib_legacy.tsv.gz', 'Gene'],
    ['picrust2/pred_metagenome_strat.tsv.gz', 'function'],
    ['picrust2/path_abun_strat.tsv.gz', 'pathway'],
    ['humann2/humann2_strat_example.tsv.gz', '# Gene Family'],
  ])('%s', async (path, firstColumn) => {
    const t = await loadTable(sql, path.split('/').pop()!, file(path))
    expect(t.rowCount).toBeGreaterThan(0)
    expect(names(t)[0]).toBe(firstColumn)
  })
})
