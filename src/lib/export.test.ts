import { describe, expect, it } from 'vitest'
import { composeSvg, layoutLegend, safeFileName, toTsv } from './export'

const measure = (s: string) => s.length * 7

describe('toTsv', () => {
  it('writes a header and rows, flattening tabs and newlines in values', () => {
    expect(toTsv(['a', 'b'], [['x\ty', 1.5], [null, 'line1\nline2']])).toBe('a\tb\nx y\t1.5\n\tline1 line2\n')
  })

  it('keeps full numeric precision', () => {
    expect(toTsv(['v'], [[0.1234567891234]])).toBe('v\n0.1234567891234\n')
  })
})

describe('safeFileName', () => {
  it('replaces unsafe characters', () => {
    expect(safeFileName('jarrvis taxa EC:2.1.1.45/"x"')).toBe('jarrvis_taxa_EC_2.1.1.45_x')
    expect(safeFileName('///')).toBe('export')
  })
})

describe('layoutLegend', () => {
  it('wraps items into rows that fit the width', () => {
    const items = ['Streptococcus', 'Neisseria', 'Haemophilus', 'Other (38 taxa)'].map((name) => ({ name, color: '#000' }))
    const wide = layoutLegend(items, 1000, measure)
    expect(new Set(wide.placed.map((p) => p.y))).toEqual(new Set([0]))
    const narrow = layoutLegend(items, 200, measure)
    expect(narrow.placed.map((p) => p.y)).toEqual([0, 20, 40, 60])
    expect(narrow.height).toBe(88)
  })

  it('takes no space without items', () => {
    expect(layoutLegend([], 500, measure).height).toBe(0)
  })
})

describe('composeSvg', () => {
  const chart = '<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg"><rect/></svg>'

  it('adds a background and nests the chart', () => {
    const r = composeSvg(chart, { width: 300, height: 200, background: '#ffffff', text: '#000' })
    expect(r.height).toBe(200)
    expect(r.svg).toMatch(/^<\?xml/)
    expect(r.svg).toContain('<rect width="100%" height="100%" fill="#ffffff"/>')
    expect(r.svg).toContain(chart)
  })

  it('adds an escaped legend below the chart and grows the height', () => {
    const r = composeSvg(chart, {
      width: 300,
      height: 200,
      background: '#fff',
      text: '#111',
      legend: [{ name: 'A & <B>', color: '#2a78d6' }],
      measure,
    })
    expect(r.height).toBe(228)
    expect(r.svg).toContain('viewBox="0 0 300 228"')
    expect(r.svg).toContain('<text x="26" y="14">A &amp; &lt;B&gt;</text>')
    expect(r.svg).toContain('fill="#2a78d6"')
  })
})
