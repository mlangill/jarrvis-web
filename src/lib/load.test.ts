import { gzipSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'
import { createNodeSql } from '../test/nodeSql'
import type { Sql } from './sql'
import { LoadError, loadTable, previewRows } from './load'

const bytes = (s: string) => new TextEncoder().encode(s)

const STRATIFIED_TSV = [
  'sample\tfunction\ttaxon\trelative_abundance',
  'S1\tK00001\tBacteroides\t0.25',
  'S1\tK00002\tPrevotella\t0.10',
  'S2\tK00001\tBacteroides\t0.30',
].join('\n')

let sql: Sql
beforeAll(async () => {
  sql = await createNodeSql()
})

describe('loadTable', () => {
  it('loads a TSV and reports rows and columns', async () => {
    const t = await loadTable(sql, 'strat.tsv', bytes(STRATIFIED_TSV))
    expect(t.rowCount).toBe(3)
    expect(t.columns.map((c) => c.name)).toEqual(['sample', 'function', 'taxon', 'relative_abundance'])
    expect(t.columns[3].type).toBe('DOUBLE')
  })

  it('loads a CSV', async () => {
    const t = await loadTable(sql, 'strat.csv', bytes('a,b\n1,x\n2,y\n'))
    expect(t.rowCount).toBe(2)
    expect(t.columns.map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('loads a gzipped TSV', async () => {
    const t = await loadTable(sql, 'strat.tsv.gz', gzipSync(bytes(STRATIFIED_TSV)))
    expect(t.rowCount).toBe(3)
  })

  it('reads a .txt file as tab-separated', async () => {
    const t = await loadTable(sql, 'strat.txt', bytes(STRATIFIED_TSV))
    expect(t.columns).toHaveLength(4)
  })

  it('splits a .txt file on tabs even when values contain semicolons', async () => {
    const tsd = [
      'Sample\tGenus\tGene\tContribution',
      ...Array.from({ length: 50 }, (_, i) =>
        `S${i % 5}\tp__Firmicutes;c__Bacilli;o__Lactobacillales;f__Streptococcaceae;g__Streptococcus;s__NA\tEC:4.1.1.${i}\t${i * 0.5}`),
    ].join('\n')
    const t = await loadTable(sql, 'tsd.txt', bytes(tsd))
    expect(t.columns.map((c) => c.name)).toEqual(['Sample', 'Genus', 'Gene', 'Contribution'])
    expect(t.rowCount).toBe(50)
  })

  it('auto-detects a comma-separated .txt file', async () => {
    const t = await loadTable(sql, 'commas.txt', bytes('a,b,c\n1,2,3\n4,5,6\n'))
    expect(t.columns.map((c) => c.name)).toEqual(['a', 'b', 'c'])
  })

  it('copes with quotes and spaces in the file name', async () => {
    const t = await loadTable(sql, `Morgan's "IBD" data.tsv`, bytes(STRATIFIED_TSV))
    expect(t.rowCount).toBe(3)
  })

  it('replaces the previously loaded table', async () => {
    await loadTable(sql, 'big.tsv', bytes(STRATIFIED_TSV))
    const t = await loadTable(sql, 'small.csv', bytes('a\n1\n'))
    expect(t.rowCount).toBe(1)
    expect(await previewRows(sql)).toEqual([{ a: 1n }])
  })

  it('rejects unsupported extensions', async () => {
    await expect(loadTable(sql, 'data.xlsx', bytes('x'))).rejects.toThrow(/isn't a supported file type/)
  })

  it('rejects empty files', async () => {
    await expect(loadTable(sql, 'empty.tsv', bytes(''))).rejects.toThrow(/is empty/)
  })

  it('rejects a header with no data rows', async () => {
    await expect(loadTable(sql, 'header.tsv', bytes('a\tb\n'))).rejects.toThrow(/no data rows/)
  })

  it('reads a .gz file that is actually uncompressed', async () => {
    const t = await loadTable(sql, 'already-unzipped.tsv.gz', bytes(STRATIFIED_TSV))
    expect(t.rowCount).toBe(3)
  })

  it('wraps unreadable files as a LoadError without internal names', async () => {
    const corrupt = gzipSync(bytes(STRATIFIED_TSV)).subarray(0, 30)
    const err = await loadTable(sql, 'broken.tsv.gz', corrupt).catch((e) => e)
    expect(err).toBeInstanceOf(LoadError)
    expect(err.message).toMatch(/"broken.tsv.gz"/)
    expect(err.message).not.toMatch(/upload_/)
  })

  it('runs overlapping loads one after another', async () => {
    const [a, b] = await Promise.all([
      loadTable(sql, 'first.tsv', bytes(STRATIFIED_TSV)),
      loadTable(sql, 'second.csv', bytes('x\n7\n')),
    ])
    expect(a.rowCount).toBe(3)
    expect(b.rowCount).toBe(1)
    expect(await previewRows(sql)).toEqual([{ x: 7n }])
  })

  it('keeps the previous table when a file is rejected', async () => {
    await loadTable(sql, 'good.csv', bytes('a\n1\n2\n'))
    await expect(loadTable(sql, 'header.tsv', bytes('a\tb\n'))).rejects.toThrow(LoadError)
    await expect(loadTable(sql, 'data.xlsx', bytes('nope'))).rejects.toThrow(LoadError)
    expect(await previewRows(sql)).toEqual([{ a: 1n }, { a: 2n }])
  })
})

describe('previewRows', () => {
  it('returns at most the requested number of rows', async () => {
    const lines = ['n', ...Array.from({ length: 250 }, (_, i) => String(i))].join('\n')
    await loadTable(sql, 'many.tsv', bytes(lines))
    expect(await previewRows(sql)).toHaveLength(100)
    expect(await previewRows(sql, 5)).toHaveLength(5)
  })
})
