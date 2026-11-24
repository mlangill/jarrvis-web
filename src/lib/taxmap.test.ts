import { beforeAll, describe, expect, it } from 'vitest'
import { createNodeSql } from '../test/nodeSql'
import { buildTaxonomy, groupTable, TAXONOMY } from './aggregate'
import { loadTable } from './load'
import type { Sql } from './sql'
import { dropTaxonomyMap, TAXMAP_RAW, taxonomyMatch, validateTaxonomyMap } from './taxmap'
import { META_RAW, STRAT_RAW, validateMetadata, validateStratified } from './validate'

const bytes = (s: string) => new TextEncoder().encode(s)
const tsv = (...rows: string[][]) => bytes(rows.map((r) => r.join('\t')).join('\n'))

let sql: Sql
beforeAll(async () => {
  sql = await createNodeSql()
})

/** A PICRUSt2-style table whose taxa are sequence IDs, plus metadata. */
async function setupTable(ids: string[]) {
  const t = await loadTable(
    sql,
    's.tsv',
    tsv(['sample', 'taxon', 'function', 'contribution'], ...ids.map((x, i) => ['S1', x, 'EC:1', String(i + 1)])),
    { table: STRAT_RAW, allVarchar: true },
  )
  if (!(await validateStratified(sql, t.columns)).summary) throw new Error('table')
  const m = await loadTable(sql, 'm.tsv', tsv(['sample_id', 'type'], ['S1', 'A']), { table: META_RAW, allVarchar: true })
  if (!(await validateMetadata(sql, m.columns)).summary) throw new Error('metadata')
}

async function taxmap(data: Uint8Array) {
  const t = await loadTable(sql, 'tax.tsv', data, { table: TAXMAP_RAW, allVarchar: true })
  return validateTaxonomyMap(sql, t.columns)
}

const ranksOf = (taxon: string) => sql.query(`SELECT phylum, genus, species FROM ${TAXONOMY} WHERE taxon = '${taxon}'`)

describe('taxonomy file', () => {
  it('reads a QIIME 2 taxonomy.tsv and uses it to collapse sequence IDs', async () => {
    await setupTable(['seq1', 'seq2', 'seq3'])
    const r = await taxmap(tsv(
      ['Feature ID', 'Taxon', 'Confidence'],
      ['#q2:types', 'categorical', 'numeric'],
      ['seq1', 'd__Bacteria; p__Firmicutes; c__Bacilli; o__Lactobacillales; f__Streptococcaceae; g__Streptococcus; s__mitis', '0.9'],
      ['seq2', 'd__Bacteria; p__Firmicutes; c__Bacilli; o__Lactobacillales; f__Streptococcaceae; g__Streptococcus', '0.8'],
      ['seq3', 'd__Bacteria; p__Proteobacteria', '0.7'],
    ))
    expect(r).toEqual({ issues: [], summary: { ids: 3, source: 'column "Taxon"' } })
    expect(await buildTaxonomy(sql)).toEqual(['kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species'])
    expect(await ranksOf('seq1')).toEqual([{ phylum: 'Firmicutes', genus: 'Streptococcus', species: 'mitis' }])
    const g = await groupTable(sql, { groupBy: 'type', level: 'genus', stat: 'sum' })
    expect(g.rows.map((x) => [x.taxon, x.value])).toEqual([
      ['Streptococcus', 3],
      ['Unclassified Proteobacteria', 3],
    ])
    expect(await taxonomyMatch(sql)).toEqual([])
  })

  it('builds lineages from DADA2-style rank columns', async () => {
    await setupTable(['ASV1'])
    const r = await taxmap(tsv(['', 'Kingdom', 'Phylum', 'Class', 'Order', 'Family', 'Genus', 'Species'], ['ASV1', 'Bacteria', 'Bacteroidota', 'Bacteroidia', 'Bacteroidales', 'Bacteroidaceae', 'Bacteroides', 'NA']))
    expect(r.summary?.source).toMatch(/^rank columns \(Kingdom, Phylum/)
    await buildTaxonomy(sql)
    expect(await ranksOf('ASV1')).toEqual([{ phylum: 'Bacteroidota', genus: 'Bacteroides', species: null }])
  })

  it('reads a lineage without rank prefixes by position', async () => {
    await setupTable(['OTU_1'])
    await taxmap(tsv(['otu', 'lineage'], ['OTU_1', 'Bacteria;Firmicutes;Clostridia;Eubacteriales;Lachnospiraceae;Blautia']))
    await buildTaxonomy(sql)
    expect(await ranksOf('OTU_1')).toEqual([{ phylum: 'Firmicutes', genus: 'Blautia', species: null }])
  })

  it('reports taxa missing from the file, and a file that matches nothing', async () => {
    await setupTable(['seq1', 'seq2'])
    await taxmap(tsv(['id', 'taxon'], ['seq1', 'p__Firmicutes; g__Streptococcus']))
    expect(await taxonomyMatch(sql)).toEqual([
      expect.objectContaining({ severity: 'warning', message: expect.stringMatching(/^1 taxon of 2 in the table isn't in the taxonomy file/), examples: ['seq2'] }),
    ])
    await taxmap(tsv(['id', 'taxon'], ['other', 'p__Firmicutes']))
    expect((await taxonomyMatch(sql))[0].message).toMatch(/^None of the 2 taxa/)
  })

  it('warns about duplicate IDs and rejects a single column', async () => {
    const r = await taxmap(tsv(['id', 'taxon'], ['a', 'p__X'], ['a', 'p__Y']))
    expect(r.issues).toEqual([expect.objectContaining({ severity: 'warning', examples: ['a'] })])
    expect((await taxmap(tsv(['id'], ['a']))).issues[0]).toMatchObject({ severity: 'error' })
  })

  it('stops affecting taxa once removed', async () => {
    await setupTable(['seq1'])
    await taxmap(tsv(['id', 'taxon'], ['seq1', 'p__Firmicutes; g__Streptococcus']))
    await dropTaxonomyMap(sql)
    expect(await buildTaxonomy(sql)).toEqual([])
  })
})
