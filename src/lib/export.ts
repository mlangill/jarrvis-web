// Turning charts and tables into files the user can download: SVG, PNG and TSV.

export interface LegendItem {
  name: string
  color: string
}

/** Width of a string in pixels at the legend font. */
export type Measure = (text: string) => number

const FONT = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const LEGEND = { pad: 8, swatch: 12, gap: 6, spacing: 18, row: 20 }

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
}

/** Measure text with a canvas; only available in a browser. */
export function canvasMeasure(): Measure {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.font = FONT
  return (text) => ctx.measureText(text).width
}

/** Lay legend items out in rows that fit `width`. Returns item positions and the total height. */
export function layoutLegend(items: LegendItem[], width: number, measure: Measure) {
  const { pad, swatch, gap, spacing, row } = LEGEND
  const placed: { item: LegendItem; x: number; y: number }[] = []
  let x = pad
  let y = 0
  for (const item of items) {
    const w = swatch + gap + measure(item.name)
    if (x > pad && x + w > width - pad) {
      x = pad
      y += row
    }
    placed.push({ item, x, y })
    x += w + spacing
  }
  return { placed, height: items.length ? y + row + pad : 0 }
}

export interface ComposeOptions {
  width: number
  height: number
  background: string
  text: string
  legend?: LegendItem[]
  measure?: Measure
}

/**
 * Wrap a chart's SVG in a standalone document with a solid background and, optionally,
 * a legend drawn underneath, so the file stands on its own in a paper or slide.
 */
export function composeSvg(chartSvg: string, opts: ComposeOptions): { svg: string; width: number; height: number } {
  const { width, height, background, text } = opts
  const legend = opts.legend?.length ? layoutLegend(opts.legend, width, opts.measure ?? canvasMeasure()) : null
  const total = height + (legend?.height ?? 0)
  const { swatch, gap } = LEGEND
  const legendSvg = legend
    ? `<g transform="translate(0 ${height})" font-family="${escapeXml(FONT.split(' ').slice(1).join(' '))}" font-size="12" fill="${text}">` +
      legend.placed
        .map(
          ({ item, x, y }) =>
            `<rect x="${x}" y="${y + 4}" width="${swatch}" height="${swatch}" rx="3" fill="${item.color}"/>` +
            `<text x="${x + swatch + gap}" y="${y + 14}">${escapeXml(item.name)}</text>`,
        )
        .join('') +
      '</g>'
    : ''
  // The chart's own <svg> nests as-is; strip any XML prolog first.
  const inner = chartSvg.replace(/^<\?xml[^>]*>\s*/, '')
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}">` +
    `<rect width="100%" height="100%" fill="${background}"/>${inner}${legendSvg}</svg>`
  return { svg, width, height: total }
}

/** Rasterize an SVG document to PNG at `scale` times its size (3 ≈ 300 dpi at print size). */
export async function svgToPng(svg: string, width: number, height: number, scale = 3): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Could not render the chart image'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create the PNG'))), 'image/png'),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Tab-separated text with a header row. Tabs and line breaks inside values become spaces. */
export function toTsv(header: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v)).replace(/[\t\r\n]+/g, ' ')
  return [header, ...rows].map((r) => r.map(cell).join('\t')).join('\n') + '\n'
}

/** A file-name-safe version of `s`. */
export function safeFileName(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'export'
  )
}

/** Save a blob or text as a file in the user's downloads. */
export function download(data: Blob | string, fileName: string, type = 'text/plain') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
