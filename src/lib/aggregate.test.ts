import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { createNodeSql } from '../test/nodeSql'
import { buildTaxonomy, functionHeatmap, groupTable, TAXONOMY } from './aggregate'
import { loadTable } from './load'
import type { Sql } from './sql'
import { META_RAW, STRAT_RAW, validateMetadata, validateStratified } from './validate'

const bytes = (s: string) => new TextEncoder().encode(s)
const testFile = (p: string) => new Uint8Array(readFileSync(new URL(`../../test-data/${p}`, import.meta.url)))
const tsv = (...rows: string[][]) => bytes(rows.map((r) => r.join('\t')).join('\n'))

let sql: Sql
beforeAll(async () => {
  sql = await createNodeSql()
})

async function setup(strat: Uint8Array, meta: Uint8Array) {
  const s = await loadTable(sql, 's.tsv', strat, { table: STRAT_RAW, allVarchar: true })
  const sv = await validateStratified(sql, s.columns)
  if (!sv.summary) throw new Error(JSON.stringify(sv.issues))
  const m = await loadTable(sql, 'm.tsv', meta, { table: META_RAW, allVarchar: true })
  const mv = await validateMetadata(sql, m.columns)
  if (!mv.summary) throw new Error(JSON.stringify(mv.issues))
  return buildTaxonomy(sql)
}

const HEADER = ['sample', 'taxon', 'function', 'contribution']
const STREP = 'p__Firmicutes;c__Bacilli;o__Lactobacillales;f__Streptococcaceae;g__Streptococcus'

describe('buildTaxonomy', () => {
  it('parses Kraken-style ranks and treats NA as unassigned', async () => {
    const levels = await setup(
      tsv(HEADER, ['S1', `${STREP};s__Streptococcus mitis`, 'EC:1', '1'], ['S1', 'p__NA;c__NA;o__NA;f__NA;g__NA;s__NA', 'EC:1', '1']),
      tsv(['sample_id', 'type'], ['S1', 'A']),
    )
    expect(levels).toEqual(['phylum', 'class', 'order', 'family', 'genus', 'species'])
    const rows = await sql.query(`SELECT * FROM ${TAXONOMY} ORDER BY taxon`)
    expect(rows[0]).toMatchObject({ phylum: 'Firmicutes', genus: 'Streptococcus', species: 'Streptococcus mitis', kingdom: null })
    expect(rows[1]).toMatchObject({ phylum: null, species: null })
  })

  it('parses HUMAnN-style g__X.s__Y and pipe separators', async () => {
    await setup(
      tsv(HEADER, ['S1', 'g__Escherichia.s__Escherichia_coli', 'K1', '1'], ['S1', 'd__Bacteria|p__Proteobacteria', 'K1', '1']),
      tsv(['sample_id', 'type'], ['S1', 'A']),
    )
    const rows = await sql.query(`SELECT taxon, kingdom, phylum, genus, species FROM ${TAXONOMY} ORDER BY taxon`)
    expect(rows).toEqual([
      { taxon: 'd__Bacteria|p__Proteobacteria', kingdom: 'Bacteria', phylum: 'Proteobacteria', genus: null, species: null },
      { taxon: 'g__Escherichia.s__Escherichia_coli', kingdom: null, phylum: null, genus: 'Escherichia', species: 'Escherichia_coli' },
    ])
  })

  it('does not split species names on dots', async () => {
    await setup(tsv(HEADER, ['S1', 'g__Streptococcus;s__Streptococcus sp. 2_1_36FAA', 'K1', '1']), tsv(['sample_id', 'type'], ['S1', 'A']))
    const [row] = await sql.query(`SELECT species FROM ${TAXONOMY}`)
    expect(row.species).toBe('Streptococcus sp. 2_1_36FAA')
  })

  it('finds no ranks in plain taxon names', async () => {
    const levels = await setup(tsv(HEADER, ['S1', 'Bacteroides', 'K1', '1'], ['S1', 'ASV_7', 'K1', '1']), tsv(['sample_id', 'type'], ['S1', 'A']))
    expect(levels).toEqual([])
  })
})

describe('groupTable', () => {
  const META = tsv(['sample_id', 'type'], ['S1', 'A'], ['S2', 'A'], ['S3', 'B'], ['S4', ''], ['S9', 'B'])

  it('averages over all samples in the group, counting absent rows as zero', async () => {
    await setup(
      tsv(HEADER, ['S1', `${STREP};s__X`, 'EC:1', '4'], ['S3', `${STREP};s__X`, 'EC:1', '3'], ['S2', `${STREP};s__Y`, 'EC:2', '1'], ['S4', `${STREP};s__X`, 'EC:1', '100']),
      META,
    )
    const r = await groupTable(sql, { groupBy: 'type', level: 'species', stat: 'mean' })
    // S9 has no data and S4 has no group, so A = {S1, S2} and B = {S3}.
    expect(r.groups).toEqual([{ name: 'A', samples: 2 }, { name: 'B', samples: 1 }])
    expect(r.ungroupedSamples).toBe(1)
    expect(r.rows).toEqual([
      { group: 'B', taxon: 'X', path: 'Firmicutes > Bacilli > Lactobacillales > Streptococcaceae > Streptococcus > X', function: 'EC:1', value: 3 },
      { group: 'A', taxon: 'X', path: expect.any(String), function: 'EC:1', value: 2 },
      { group: 'A', taxon: 'Y', path: expect.any(String), function: 'EC:2', value: 0.5 },
    ])
  })

  it('collapses species into their genus and sums them', async () => {
    await setup(tsv(HEADER, ['S1', `${STREP};s__X`, 'EC:1', '4'], ['S1', `${STREP};s__Y`, 'EC:1', '2']), META)
    const r = await groupTable(sql, { groupBy: 'type', level: 'genus', stat: 'sum' })
    expect(r.rows).toEqual([{ group: 'A', taxon: 'Streptococcus', path: expect.any(String), function: 'EC:1', value: 6 }])
  })

  it('labels unassigned ranks after the nearest known parent', async () => {
    await setup(
      tsv(HEADER, ['S1', 'p__Firmicutes;c__Bacilli;o__NA;f__NA;g__NA;s__NA', 'EC:1', '2'], ['S1', 'p__NA;c__NA;o__NA;f__NA;g__NA;s__NA', 'EC:1', '1'], ['S1', 'unclassified', 'EC:1', '1']),
      META,
    )
    const r = await groupTable(sql, { groupBy: 'type', level: 'genus', stat: 'sum' })
    expect(r.rows.map((x) => [x.taxon, x.value])).toEqual([
      ['Unclassified', 2],
      ['Unclassified Bacilli', 2],
    ])
  })

  it('keeps taxa as given when level is taxon', async () => {
    await setup(tsv(HEADER, ['S1', 'ASV_1', 'K1', '1'], ['S2', 'ASV_2', 'K1', '3']), META)
    const r = await groupTable(sql, { groupBy: 'type', level: 'taxon', stat: 'mean' })
    expect(r.rows.map((x) => [x.taxon, x.value])).toEqual([
      ['ASV_2', 1.5],
      ['ASV_1', 0.5],
    ])
  })

  it('respects the row limit but reports the total', async () => {
    await setup(tsv(HEADER, ...Array.from({ length: 30 }, (_, i) => ['S1', 'ASV', `K${i}`, String(i + 1)])), META)
    const r = await groupTable(sql, { groupBy: 'type', level: 'taxon', stat: 'sum', limit: 5 })
    expect(r.totalRows).toBe(30)
    expect(r.rows.map((x) => x.value)).toEqual([30, 29, 28, 27, 26])
  })

  it('conserves the total contribution on the TSD subset at every level', async () => {
    const levels = await setup(testFile('jarrvis/TSD-EC-stratified-subset.tsv'), testFile('jarrvis/TSD-sample-metadata.txt'))
    const [{ total }] = await sql.query<{ total: number }>('SELECT sum(contribution) AS total FROM strat')
    for (const level of [...levels, 'taxon'] as const) {
      await groupTable(sql, { groupBy: 'type', level, stat: 'sum' })
      const [{ grouped }] = await sql.query<{ grouped: number }>('SELECT sum(value) AS grouped FROM grouped')
      expect(grouped).toBeCloseTo(total, 6)
    }
    const r = await groupTable(sql, { groupBy: 'type', level: 'phylum', stat: 'mean' })
    expect(r.groups).toEqual([{ name: 'A', samples: 5 }, { name: 'B', samples: 5 }])
  })
})

describe('functionHeatmap', () => {
  const META = tsv(['sample_id', 'type'], ['S1', 'A'], ['S2', 'A'], ['S3', 'B'])
  const HEADER = ['sample', 'taxon', 'function', 'contribution']

  it('sums over taxa, averages per group and ranks functions', async () => {
    await setup(
      tsv(HEADER,
        ['S1', 'g__X', 'EC:1', '4'], ['S1', 'g__Y', 'EC:1', '2'], ['S3', 'g__X', 'EC:1', '1'],
        ['S2', 'g__X', 'EC:2', '10'],
        ['S3', 'g__X', 'K:9', '0.5'],
      ),
      META,
    )
    const r = await functionHeatmap(sql, { groupBy: 'type', stat: 'mean', top: 10 })
    expect(r.groups.map((g) => g.name)).toEqual(['A', 'B'])
    // EC:1: A = (4+2)/2 = 3, B = 1 → score 4. EC:2: A = 10/2 = 5 → score 5. K:9: B = 0.5.
    expect(r.functions).toEqual(['EC:2', 'EC:1', 'K:9'])
    expect(r.values).toEqual([[5, 0], [3, 1], [0, 0.5]])
    expect(r.matchingFunctions).toBe(3)
  })

  it('filters by a case-insensitive search and cuts to the top N', async () => {
    await setup(tsv(HEADER, ['S1', 'g__X', 'EC:1.1', '1'], ['S1', 'g__X', 'EC:1.2', '2'], ['S1', 'g__X', 'K00001', '9']), META)
    const r = await functionHeatmap(sql, { groupBy: 'type', stat: 'sum', search: ' ec:1 ', top: 1 })
    expect(r.functions).toEqual(['EC:1.2'])
    expect(r.matchingFunctions).toBe(2)
  })

  it('returns no functions when nothing matches', async () => {
    await setup(tsv(HEADER, ['S1', 'g__X', 'EC:1', '1']), META)
    const r = await functionHeatmap(sql, { groupBy: 'type', stat: 'mean', search: 'zzz', top: 10 })
    expect(r).toMatchObject({ functions: [], values: [], matchingFunctions: 0 })
  })

  it('agrees with groupTable totals on the TSD subset', async () => {
    await setup(testFile('jarrvis/TSD-EC-stratified-subset.tsv'), testFile('jarrvis/TSD-sample-metadata.txt'))
    const h = await functionHeatmap(sql, { groupBy: 'type', stat: 'mean', top: 50 })
    expect(h.functions).toHaveLength(5)
    const g = await groupTable(sql, { groupBy: 'type', level: 'genus', stat: 'mean', fn: h.functions[0], limit: 100000 })
    expect(new Set(g.rows.map((r) => r.function))).toEqual(new Set([h.functions[0]]))
    const byGroup = (name: string) => g.rows.filter((r) => r.group === name).reduce((a, r) => a + r.value, 0)
    expect(byGroup('A')).toBeCloseTo(h.values[0][0], 6)
    expect(byGroup('B')).toBeCloseTo(h.values[0][1], 6)
  })
})
