import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { createNodeSql } from '../test/nodeSql'
import { loadTable, previewRows } from './load'
import type { Sql } from './sql'
import {
  crossCheck,
  hasErrors,
  META,
  META_RAW,
  STRAT,
  STRAT_RAW,
  validateMetadata,
  validateStratified,
  type Issue,
} from './validate'

const bytes = (s: string) => new TextEncoder().encode(s)
const testFile = (p: string) => new Uint8Array(readFileSync(new URL(`../../test-data/${p}`, import.meta.url)))
const tsv = (...rows: string[][]) => bytes(rows.map((r) => r.join('\t')).join('\n'))

let sql: Sql
beforeAll(async () => {
  sql = await createNodeSql()
})

async function strat(name: string, data: Uint8Array) {
  const t = await loadTable(sql, name, data, { table: STRAT_RAW, allVarchar: true })
  return validateStratified(sql, t.columns)
}
async function meta(name: string, data: Uint8Array) {
  const t = await loadTable(sql, name, data, { table: META_RAW, allVarchar: true })
  return validateMetadata(sql, t.columns)
}
const errors = (issues: Issue[]) => issues.filter((i) => i.severity === 'error').map((i) => i.message)
const warnings = (issues: Issue[]) => issues.filter((i) => i.severity === 'warning').map((i) => i.message)

const HEADER = ['Sample', 'Genus', 'Gene', 'Contribution']

describe('validateStratified', () => {
  it('accepts the TSD test subset', async () => {
    const r = await strat('tsd.tsv', testFile('jarrvis/TSD-EC-stratified-subset.tsv'))
    expect(r.issues).toEqual([
      expect.objectContaining({ severity: 'info', message: expect.stringMatching(/^270 sample \/ taxon \/ function combinations appear more than once/) }),
    ])
    expect(r.summary).toEqual({ format: 'jarrvis', rows: 3580, samples: 10, taxa: expect.any(Number), functions: 5 })
  })

  it('builds the clean table with trimmed text and numeric contributions', async () => {
    const r = await strat('t.tsv', tsv(HEADER, [' S1 ', 'g__A', 'EC:1', ' 2.5 '], ['S2', '', 'EC:1', '1e-3']))
    expect(hasErrors(r.issues)).toBe(false)
    expect(await previewRows(sql, 10, STRAT)).toEqual([
      { sample: 'S1', taxon: 'g__A', function: 'EC:1', contribution: 2.5 },
      { sample: 'S2', taxon: 'unclassified', function: 'EC:1', contribution: 0.001 },
    ])
    expect(warnings(r.issues)).toEqual([expect.stringMatching(/1 row has no taxon/)])
  })

  it('keeps sample IDs with leading zeros as text', async () => {
    await strat('t.tsv', tsv(HEADER, ['007', 'g__A', 'EC:1', '1']))
    expect(await previewRows(sql, 1, STRAT)).toEqual([expect.objectContaining({ sample: '007' })])
  })

  it('rejects the wrong number of columns', async () => {
    const r = await strat('t.tsv', tsv(['a', 'b', 'c'], ['1', '2', '3']))
    expect(errors(r.issues)).toEqual([expect.stringMatching(/Expected 4 columns.*found 3 columns: a, b, c/)])
    expect(r.summary).toBeUndefined()
  })

  it.each([
    ['picrust2/metagenome_contrib.tsv.gz', 'picrust2-contrib', { rows: 9, samples: 2, taxa: 8, functions: 3 }],
    ['picrust2/metagenome_contrib_legacy.tsv.gz', 'picrust2-legacy', { rows: 9, samples: 2, taxa: 8, functions: 3 }],
    ['picrust2/pred_metagenome_strat.tsv.gz', 'picrust2-wide', { rows: 66, samples: 3, taxa: 10, functions: 3 }],
    ['picrust2/path_abun_strat.tsv.gz', 'picrust2-wide', { rows: 9, samples: 2, taxa: 3, functions: 2 }],
    ['humann2/humann2_strat_example.tsv.gz', 'humann', { rows: 18, samples: 4, taxa: 3, functions: 14 }],
    ['mh2/mh2-random-300-KOs.txt.gz', 'mh2', { rows: 303693, samples: 12, taxa: 23115, functions: 300 }],
  ])('detects and converts %s', async (path, format, counts) => {
    const r = await strat(path.split('/').pop()!, testFile(path))
    expect(errors(r.issues)).toEqual([])
    expect(r.issues[0]).toMatchObject({ severity: 'info', message: expect.stringMatching(/^Read as /) })
    expect(r.summary).toEqual({ format, ...counts })
  })

  it('reads PICRUSt2 contributions with taxon_function_abun as the contribution', async () => {
    await strat('c.tsv.gz', testFile('picrust2/metagenome_contrib.tsv.gz'))
    expect((await previewRows(sql, 1, STRAT))[0]).toEqual({
      sample: 'sample1',
      taxon: '20e568023c10eaac834f1c110aacea18',
      function: 'EC:1.1.1.1',
      contribution: 52,
    })
  })

  it('splits HUMAnN function|taxon rows, drops totals, specials and zeros, and trims sample suffixes', async () => {
    const r = await strat('h.tsv', tsv(
      ['# Pathway', 'S1_Abundance-RPKs', 'S2_Abundance'],
      ['PWY-1: thing', '5', '0'],
      ['PWY-1: thing|g__Bacteroides.s__Bacteroides_dorei', '3', '0'],
      ['PWY-1: thing|unclassified', '2', '1'],
      ['UNINTEGRATED|g__Bacteroides.s__Bacteroides_dorei', '9', '9'],
      ['UNMAPPED', '7', '7'],
    ))
    expect(errors(r.issues)).toEqual([])
    const rows = await sql.query(`SELECT * FROM ${STRAT} ORDER BY sample, taxon`)
    expect(rows).toEqual([
      { sample: 'S1', taxon: 'g__Bacteroides.s__Bacteroides_dorei', function: 'PWY-1: thing', contribution: 3 },
      { sample: 'S1', taxon: 'unclassified', function: 'PWY-1: thing', contribution: 2 },
      { sample: 'S2', taxon: 'unclassified', function: 'PWY-1: thing', contribution: 1 },
    ])
  })

  it('detects Microbiome Helper 2 output, splits function|taxon, and drops Unclassified functions and zeros', async () => {
    const r = await strat('mh2.txt', tsv(
      ['KO_Taxonomy', 'D1', 'D2'],
      ['Unclassified|Sphaerotilus montanus (taxid 522889)', '100', '200'],
      ['K00812|cellular organisms (taxid 131567)', '1.5', '0'],
      ['K00812|Bacteroides fragilis (taxid 817)', '2', '3'],
    ))
    expect(errors(r.issues)).toEqual([])
    expect(r.summary).toEqual({ format: 'mh2', rows: 3, samples: 2, taxa: 2, functions: 1 })
    expect(await sql.query(`SELECT * FROM ${STRAT} ORDER BY sample, taxon`)).toEqual([
      { sample: 'D1', taxon: 'Bacteroides fragilis (taxid 817)', function: 'K00812', contribution: 2 },
      { sample: 'D1', taxon: 'cellular organisms (taxid 131567)', function: 'K00812', contribution: 1.5 },
      { sample: 'D2', taxon: 'Bacteroides fragilis (taxid 817)', function: 'K00812', contribution: 3 },
    ])
  })

  it('rejects a HUMAnN table with no per-taxon rows', async () => {
    const r = await strat('h.tsv', tsv(['# Gene Family', 'S1'], ['UniRef90_X', '5']))
    expect(errors(r.issues)).toEqual([expect.stringMatching(/no per-taxon rows/)])
  })

  it('uses a chosen format instead of detecting one, and explains a mismatch', async () => {
    const t = await loadTable(sql, 't.tsv', tsv(HEADER, ['S1', 'g__A', 'EC:1', '1']), { table: STRAT_RAW, allVarchar: true })
    const r = await validateStratified(sql, t.columns, 'picrust2-contrib')
    expect(errors(r.issues)).toEqual([expect.stringMatching(/doesn't look like PICRUSt2 contributions output.*Found: Sample, Genus, Gene, Contribution/)])
    expect((await validateStratified(sql, t.columns, 'jarrvis')).summary?.format).toBe('jarrvis')
  })

  it('reports non-numeric contributions with examples', async () => {
    const r = await strat('t.tsv', tsv(HEADER, ['S1', 'g__A', 'EC:1', '1.5'], ['S1', 'g__B', 'EC:1', 'abc'], ['S2', 'g__A', 'EC:1', '2,5']))
    expect(errors(r.issues)).toEqual([expect.stringMatching(/^2 rows have a contribution.*isn't a number\.$/)])
    expect(r.issues[0].examples).toEqual(expect.arrayContaining(['abc', '2,5']))
  })

  it('hints at column order when no contribution is numeric', async () => {
    const r = await strat('t.tsv', tsv(['Sample', 'Gene', 'Contribution', 'Genus'], ['S1', 'EC:1', '1.5', 'g__A']))
    expect(errors(r.issues)[0]).toMatch(/Check the column order/)
  })

  it('treats empty and NA contributions as missing, not malformed', async () => {
    const r = await strat('t.tsv', tsv(HEADER, ['S1', 'g__A', 'EC:1', '1'], ['S1', 'g__B', 'EC:1', 'NA'], ['S1', 'g__C', 'EC:1', '']))
    expect(errors(r.issues)).toEqual([])
    expect(warnings(r.issues)).toEqual([expect.stringMatching(/2 rows have no contribution value/)])
    expect(r.summary?.rows).toBe(1)
  })

  it('rejects rows without a sample or function', async () => {
    const r = await strat('t.tsv', tsv(HEADER, ['', 'g__A', 'EC:1', '1'], ['S1', 'g__A', ' ', '1']))
    expect(errors(r.issues)).toEqual([
      expect.stringMatching(/1 row has no sample ID \(column 1, "Sample"\)/),
      expect.stringMatching(/1 row has no function \(column 3, "Gene"\)/),
    ])
  })

  it('warns about negative contributions and notes duplicate rows', async () => {
    const r = await strat('t.tsv', tsv(HEADER, ['S1', 'g__A', 'EC:1', '-1'], ['S1', 'g__A', 'EC:1', '2']))
    expect(warnings(r.issues)).toEqual([expect.stringMatching(/1 row has a negative contribution/)])
    expect(r.issues[1]).toMatchObject({ severity: 'info', examples: ['S1 / g__A / EC:1'] })
    expect(r.issues[1].message).toMatch(/1 sample \/ taxon \/ function combination appears more than once/)
  })

  it('rejects a file without a header line', async () => {
    const r = await strat('t.tsv', tsv(['S1', 'g__A', 'EC:1', '0.5'], ['S2', 'g__A', 'EC:1', '1']))
    expect(errors(r.issues)).toEqual([expect.stringMatching(/looks like data rather than a header/)])
  })

  it('rejects a table where every contribution is missing', async () => {
    const r = await strat('t.tsv', tsv(HEADER, ['S1', 'g__A', 'EC:1', 'NA']))
    expect(errors(r.issues)).toEqual(['No rows have a contribution value.'])
  })

  it('removes a previous clean table when the new file has errors', async () => {
    await strat('good.tsv', tsv(HEADER, ['S1', 'g__A', 'EC:1', '1']))
    await strat('bad.tsv', tsv(['a', 'b'], ['1', '2']))
    await expect(sql.query(`SELECT * FROM ${STRAT}`)).rejects.toThrow()
  })
})

describe('validateMetadata', () => {
  it('accepts the TSD metadata', async () => {
    const r = await meta('m.txt', testFile('jarrvis/TSD-sample-metadata.txt'))
    expect(r.issues).toEqual([])
    expect(r.summary).toEqual({ samples: 10, idColumn: 'sample_id', groupColumns: [{ name: 'type', levels: 2 }] })
  })

  it('uses the first column as sample_id whatever it is called', async () => {
    const r = await meta('m.tsv', tsv(['SampleID', 'month', 'depth'], ['A1', 'Jan', '5'], ['A2', 'Feb', '']))
    expect(r.summary?.idColumn).toBe('SampleID')
    expect(await previewRows(sql, 10, META)).toEqual([
      { sample_id: 'A1', month: 'Jan', depth: '5' },
      { sample_id: 'A2', month: 'Feb', depth: null },
    ])
  })

  it('rejects a single column', async () => {
    const r = await meta('m.tsv', tsv(['sample_id'], ['A1']))
    expect(errors(r.issues)).toEqual([expect.stringMatching(/at least one column to group samples by/)])
  })

  it('rejects duplicate and blank sample IDs', async () => {
    const r = await meta('m.tsv', tsv(['sample_id', 'type'], ['A1', 'x'], ['A1', 'y'], ['', 'z']))
    expect(errors(r.issues)).toEqual([
      expect.stringMatching(/1 row has no sample ID/),
      expect.stringMatching(/1 sample ID appears more than once/),
    ])
    expect(r.issues[1].examples).toEqual(['A1'])
  })

  it('warns about empty grouping columns and leaves them out', async () => {
    const r = await meta('m.tsv', tsv(['sample_id', 'type', 'notes'], ['A1', 'x', ''], ['A2', 'y', '']))
    expect(warnings(r.issues)).toEqual([expect.stringMatching(/Column "notes" is empty/)])
    expect(r.summary?.groupColumns).toEqual([{ name: 'type', levels: 2 }])
  })
})

describe('crossCheck', () => {
  it('matches the TSD table and metadata completely', async () => {
    await strat('tsd.tsv', testFile('jarrvis/TSD-EC-stratified-subset.tsv'))
    await meta('m.txt', testFile('jarrvis/TSD-sample-metadata.txt'))
    expect(await crossCheck(sql)).toEqual({ issues: [], summary: { matched: 10 } })
  })

  it('warns about samples missing on either side', async () => {
    await strat('t.tsv', tsv(HEADER, ['S1', 'g__A', 'EC:1', '1'], ['S2', 'g__A', 'EC:1', '1']))
    await meta('m.tsv', tsv(['sample_id', 'type'], ['S1', 'a'], ['S3', 'b']))
    const r = await crossCheck(sql)
    expect(r.summary).toEqual({ matched: 1 })
    expect(warnings(r.issues)).toEqual([
      "1 sample in the table isn't in the metadata and will be left out.",
      '1 sample in the metadata has no rows in the table.',
    ])
    expect(r.issues.map((i) => i.examples)).toEqual([['S2'], ['S3']])
  })

  it('fails when nothing matches, and points out case differences', async () => {
    await strat('t.tsv', tsv(HEADER, ['s1', 'g__A', 'EC:1', '1']))
    await meta('m.tsv', tsv(['sample_id', 'type'], ['S1', 'a']))
    const r = await crossCheck(sql)
    expect(errors(r.issues)).toEqual([expect.stringMatching(/None of the 1 sample.*check the capitalization/)])
    expect(r.issues[0].examples).toEqual(['table: s1', 'metadata: S1'])
  })
})
