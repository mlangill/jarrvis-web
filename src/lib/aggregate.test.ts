import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { createNodeSql } from '../test/nodeSql'
import { buildTaxonomy, functionHeatmap, groupDifference, groupTable, higherRanks, sankeyData, taxaForFunction, TAXONOMY } from './aggregate'
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
      { group: 'B', taxon: 'X', path: 'Firmicutes > Bacilli > Lactobacillales > Streptococcaceae > Streptococcus > X', ranks: '|Firmicutes|Bacilli|Lactobacillales|Streptococcaceae|Streptococcus|X', function: 'EC:1', value: 3 },
      { group: 'A', taxon: 'X', path: expect.any(String), ranks: expect.any(String), function: 'EC:1', value: 2 },
      { group: 'A', taxon: 'Y', path: expect.any(String), ranks: expect.any(String), function: 'EC:2', value: 0.5 },
    ])
  })

  it('collapses species into their genus and sums them', async () => {
    await setup(tsv(HEADER, ['S1', `${STREP};s__X`, 'EC:1', '4'], ['S1', `${STREP};s__Y`, 'EC:1', '2']), META)
    const r = await groupTable(sql, { groupBy: 'type', level: 'genus', stat: 'sum' })
    expect(r.rows).toEqual([{ group: 'A', taxon: 'Streptococcus', path: expect.any(String), ranks: expect.any(String), function: 'EC:1', value: 6 }])
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

  it('ranks by the largest difference between groups, counting a missing group as zero', async () => {
    await setup(
      tsv(HEADER,
        // EC:big is the most abundant but nearly equal: A = 10, B = 9 → difference 1.
        ['S1', 'g__X', 'EC:big', '10'], ['S2', 'g__X', 'EC:big', '10'], ['S3', 'g__X', 'EC:big', '9'],
        // EC:diff: A = 1, B = 6 → difference 5.
        ['S1', 'g__X', 'EC:diff', '2'], ['S3', 'g__X', 'EC:diff', '6'],
        // EC:onlyA: A = 3, B absent → difference 3.
        ['S1', 'g__X', 'EC:onlyA', '6'],
      ),
      META,
    )
    const total = await functionHeatmap(sql, { groupBy: 'type', stat: 'mean', top: 10 })
    expect(total.functions).toEqual(['EC:big', 'EC:diff', 'EC:onlyA'])
    expect(total.scores).toEqual([19, 7, 3])
    const diff = await functionHeatmap(sql, { groupBy: 'type', stat: 'mean', top: 2, rank: 'difference' })
    expect(diff.functions).toEqual(['EC:diff', 'EC:onlyA'])
    expect(diff.scores).toEqual([5, 3])
    expect(diff.matchingFunctions).toBe(3)
  })

  it('returns no functions when nothing matches', async () => {
    await setup(tsv(HEADER, ['S1', 'g__X', 'EC:1', '1']), META)
    const r = await functionHeatmap(sql, { groupBy: 'type', stat: 'mean', search: 'zzz', top: 10 })
    expect(r).toMatchObject({ functions: [], scores: [], values: [], matchingFunctions: 0 })
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

describe('higherRanks', () => {
  it('keeps rank positions when middle ranks are unassigned', async () => {
    await setup(
      tsv(HEADER, ['S1', 'p__Firmicutes;c__NA;o__Lactobacillales;f__Streptococcaceae;g__Streptococcus', 'EC:1', '1']),
      tsv(['sample_id', 'type'], ['S1', 'A']),
    )
    const r = await groupTable(sql, { groupBy: 'type', level: 'genus', stat: 'sum' })
    expect(higherRanks('genus', r.rows[0].ranks)).toEqual([
      { rank: 'kingdom', value: null },
      { rank: 'phylum', value: 'Firmicutes' },
      { rank: 'class', value: null },
      { rank: 'order', value: 'Lactobacillales' },
      { rank: 'family', value: 'Streptococcaceae' },
    ])
    expect(higherRanks('taxon', 'anything')).toEqual([])
  })
})

describe('groupDifference', () => {
  const g = (...names: string[]) => names.map((name) => ({ name, samples: 1 }))

  it('is signed, second minus first, with two groups', () => {
    expect(groupDifference(g('A', 'B'), [[5, 0], [1, 3]])).toEqual({
      label: 'B − A',
      signed: true,
      values: [-5, 2],
      extremes: [{ high: 0, low: 1 }, { high: 1, low: 0 }],
    })
  })

  it('is highest minus lowest with more groups, and null with one', () => {
    const d = groupDifference(g('A', 'B', 'C'), [[2, 7, 1]])
    expect(d).toMatchObject({ label: 'Highest − lowest', signed: false, values: [6], extremes: [{ high: 1, low: 2 }] })
    expect(groupDifference(g('A'), [[1]])).toBeNull()
  })
})

describe('taxaForFunction', () => {
  const META = tsv(['sample_id', 'type'], ['S1', 'A'], ['S2', 'A'], ['S3', 'B'])
  const HEADER = ['sample', 'taxon', 'function', 'contribution']
  const rows = tsv(HEADER,
    ['S1', 'g__X;s__x1', 'EC:1', '4'], ['S1', 'g__X;s__x2', 'EC:1', '2'], ['S2', 'g__Y;s__y1', 'EC:1', '1'],
    ['S3', 'g__Z;s__z1', 'EC:1', '1'], ['S3', 'g__X;s__x1', 'EC:1', '0.5'],
    ['S1', 'g__Z;s__z1', 'EC:2', '100'],
  )

  it('gives mean per group for each collapsed taxon, largest first', async () => {
    await setup(rows, META)
    const r = await taxaForFunction(sql, { groupBy: 'type', level: 'genus', stat: 'mean', fn: 'EC:1', by: 'group' })
    expect(r.bars).toEqual([{ label: 'A', group: 'A', samples: 2 }, { label: 'B', group: 'B', samples: 1 }])
    // X: A = 6/2 = 3, B = 0.5. Z: B = 1. Y: A = 0.5.
    expect(r.taxa.map((t) => t.label)).toEqual(['X', 'Z', 'Y'])
    expect(r.values).toEqual([[3, 0.5], [0, 1], [0.5, 0]])
    expect(r.other).toEqual([0, 0])
    expect(r.otherTaxa).toBe(0)
  })

  it('folds taxa beyond the top N into Other', async () => {
    await setup(rows, META)
    const r = await taxaForFunction(sql, { groupBy: 'type', level: 'genus', stat: 'sum', fn: 'EC:1', by: 'group', topTaxa: 1 })
    expect(r.taxa.map((t) => t.label)).toEqual(['X'])
    expect(r.values).toEqual([[6, 0.5]])
    expect(r.other).toEqual([1, 1])
    expect(r.otherTaxa).toBe(2)
  })

  it('gives one bar per sample, including samples without the function, in group order', async () => {
    await setup(rows, META)
    const r = await taxaForFunction(sql, { groupBy: 'type', level: 'species', stat: 'mean', fn: 'EC:2', by: 'sample' })
    expect(r.bars.map((b) => [b.label, b.group])).toEqual([['S1', 'A'], ['S2', 'A'], ['S3', 'B']])
    expect(r.values).toEqual([[100, 0, 0]])
  })

  it('keeps the same taxa in group and sample mode', async () => {
    await setup(rows, META)
    const opts = { groupBy: 'type', level: 'species', stat: 'mean', fn: 'EC:1', topTaxa: 2 } as const
    const g = await taxaForFunction(sql, { ...opts, by: 'group' })
    const s = await taxaForFunction(sql, { ...opts, by: 'sample' })
    expect(s.taxa).toEqual(g.taxa)
    expect(s.values[0]).toEqual([4, 0, 0.5])
  })

  it('matches the heatmap value for each group on the TSD subset', async () => {
    await setup(testFile('jarrvis/TSD-EC-stratified-subset.tsv'), testFile('jarrvis/TSD-sample-metadata.txt'))
    const h = await functionHeatmap(sql, { groupBy: 'type', stat: 'mean', top: 5 })
    const r = await taxaForFunction(sql, { groupBy: 'type', level: 'genus', stat: 'mean', fn: h.functions[0], by: 'group' })
    r.bars.forEach((_, b) => {
      const total = r.values.reduce((a, row) => a + row[b], 0) + r.other[b]
      expect(total).toBeCloseTo(h.values[0][b], 6)
    })
  })
})

describe('sankeyData', () => {
  const META = tsv(['sample_id', 'type'], ['S1', 'A'], ['S2', 'A'], ['S3', 'B'])
  const HEADER = ['sample', 'taxon', 'function', 'contribution']
  const rows = tsv(HEADER,
    ['S1', 'g__X', 'EC:1', '4'], ['S2', 'g__X', 'EC:2', '2'], ['S1', 'g__Y', 'EC:1', '1'],
    ['S3', 'g__Z', 'EC:1', '3'], ['S3', 'g__X', 'EC:2', '1'], ['S3', 'g__W', 'EC:3', '9'],
  )
  const sum = (ls: { value: number }[]) => ls.reduce((a, l) => a + l.value, 0)

  it('builds group → taxon → function flows that balance at each taxon', async () => {
    await setup(rows, META)
    const r = await sankeyData(sql, { groupBy: 'type', level: 'genus', stat: 'mean', functions: ['EC:1', 'EC:2'] })
    expect(r.nodes.map((n) => n.id)).toEqual(['g:A', 'g:B', 't:|||||X', 't:|||||Z', 't:|||||Y', 'f:EC:1', 'f:EC:2'])
    // A has 2 samples: X = (4 + 2) / 2 = 3, Y = 0.5. B has 1: Z = 3, X = 1.
    const link = (s: string, t: string) => r.links.find((l) => l.source === s && l.target === t)?.value
    expect(link('g:A', 't:|||||X')).toBe(3)
    expect(link('g:B', 't:|||||X')).toBe(1)
    expect(link('t:|||||X', 'f:EC:1')).toBe(2)
    expect(link('t:|||||X', 'f:EC:2')).toBe(2)
    for (const n of r.nodes.filter((x) => x.column === 'taxon')) {
      expect(sum(r.links.filter((l) => l.target === n.id))).toBeCloseTo(sum(r.links.filter((l) => l.source === n.id)))
    }
    expect(r.links.some((l) => l.target === 'f:EC:3' || l.source === 't:|||||W')).toBe(false)
  })

  it('keeps flows that add up to every link', async () => {
    await setup(rows, META)
    const r = await sankeyData(sql, { groupBy: 'type', level: 'genus', stat: 'mean', functions: ['EC:1', 'EC:2'], topTaxa: 1 })
    for (const l of r.links) {
      const parts = r.flows.filter((f) =>
        l.source.startsWith('g:') ? f.group === l.source && f.taxon === l.target : f.taxon === l.source && f.fn === l.target,
      )
      expect(sum(parts)).toBeCloseTo(l.value)
    }
    expect(r.flows).toContainEqual({ group: 'g:B', taxon: 't:\u0000other', fn: 'f:EC:1', value: 3 })
  })

  it('folds taxa past the top N into one Other node', async () => {
    await setup(rows, META)
    const r = await sankeyData(sql, { groupBy: 'type', level: 'genus', stat: 'sum', functions: ['EC:1', 'EC:2'], topTaxa: 1 })
    expect(r.nodes.filter((n) => n.column === 'taxon').map((n) => n.label)).toEqual(['X', 'Other (2 taxa)'])
    expect(r.otherTaxa).toBe(2)
    expect(sum(r.links.filter((l) => l.source.startsWith('g:')))).toBe(11)
    expect(sum(r.links.filter((l) => l.target.startsWith('f:')))).toBe(11)
  })

  it('keeps node ids distinct when names repeat across columns', async () => {
    await setup(tsv(HEADER, ['S1', 'A', 'A', '1']), META)
    const r = await sankeyData(sql, { groupBy: 'type', level: 'taxon', stat: 'sum', functions: ['A'] })
    expect(r.nodes.map((n) => n.id)).toEqual(['g:A', 't:A', 'f:A'])
  })

  it('returns nothing for no functions', async () => {
    expect(await sankeyData(sql, { groupBy: 'type', level: 'genus', stat: 'sum', functions: [] })).toEqual({ nodes: [], links: [], flows: [], otherTaxa: 0 })
  })

  it('carries the heatmap totals through on the TSD subset', async () => {
    await setup(testFile('jarrvis/TSD-EC-stratified-subset.tsv'), testFile('jarrvis/TSD-sample-metadata.txt'))
    const h = await functionHeatmap(sql, { groupBy: 'type', stat: 'mean', top: 3 })
    const r = await sankeyData(sql, { groupBy: 'type', level: 'genus', stat: 'mean', functions: h.functions })
    h.functions.forEach((f, i) => {
      const into = sum(r.links.filter((l) => l.target === `f:${f}`))
      expect(into).toBeCloseTo(h.values[i].reduce((a, v) => a + v, 0), 6)
    })
  })
})
