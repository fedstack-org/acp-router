import MarkdownIt, { type Options } from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function createTelegramRenderer(): MarkdownIt {
  const md = new MarkdownIt({ linkify: true })

  const { rules } = md.renderer

  let listStack: Array<{ ordered: boolean; index: number }> = []
  let blockquoteDepth = 0

  rules.text = (tokens, idx) => escapeHtml(tokens[idx].content)

  rules.strong_open = () => '<b>'
  rules.strong_close = () => '</b>'

  rules.em_open = () => '<i>'
  rules.em_close = () => '</i>'

  rules.s_open = () => '<s>'
  rules.s_close = () => '</s>'

  rules.code_inline = (tokens, idx) => `<code>${escapeHtml(tokens[idx].content)}</code>`

  rules.fence = (tokens, idx) => {
    const token = tokens[idx]
    const lang = token.info.trim()
    const code = escapeHtml(token.content)
    if (lang) {
      return `<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>\n`
    }
    return `<pre><code>${code}</code></pre>\n`
  }

  rules.code_block = (tokens, idx) => {
    return `<pre><code>${escapeHtml(tokens[idx].content)}</code></pre>\n`
  }

  rules.heading_open = (tokens, idx) => {
    const level = Number(tokens[idx].tag.slice(1))
    if (level <= 2) return '<b>'
    return '<b>'
  }
  rules.heading_close = () => '</b>\n'

  rules.paragraph_open = () => ''
  rules.paragraph_close = (_tokens, _idx, _options, env) => {
    if (env._inListItem) return ''
    if (blockquoteDepth > 0) return '\n'
    return '\n\n'
  }

  rules.blockquote_open = () => {
    blockquoteDepth++
    return '<blockquote>'
  }
  rules.blockquote_close = () => {
    blockquoteDepth--
    return '</blockquote>\n'
  }

  rules.bullet_list_open = () => {
    const nested = listStack.length > 0
    listStack.push({ ordered: false, index: 0 })
    return nested ? '\n' : ''
  }
  rules.bullet_list_close = () => {
    listStack.pop()
    return listStack.length > 0 ? '' : '\n'
  }

  rules.ordered_list_open = (tokens, idx) => {
    const nested = listStack.length > 0
    const start = Number(tokens[idx].attrGet('start') ?? 1)
    listStack.push({ ordered: true, index: start })
    return nested ? '\n' : ''
  }
  rules.ordered_list_close = () => {
    listStack.pop()
    return listStack.length > 0 ? '' : '\n'
  }

  rules.list_item_open = (_tokens, _idx, _options, env) => {
    env._inListItem = (env._inListItem ?? 0) + 1
    const ctx = listStack[listStack.length - 1]
    if (!ctx) return '• '
    const indent = '  '.repeat(listStack.length - 1)
    if (ctx.ordered) {
      const num = ctx.index
      ctx.index++
      return `${indent}${num}. `
    }
    return `${indent}• `
  }
  rules.list_item_close = (_tokens, _idx, _options, env) => {
    env._inListItem = Math.max(0, (env._inListItem ?? 1) - 1)
    return '\n'
  }

  rules.link_open = (tokens, idx) => {
    const href = tokens[idx].attrGet('href') ?? ''
    return `<a href="${escapeHtml(href)}">`
  }
  rules.link_close = () => '</a>'

  rules.image = (tokens, idx) => {
    const token = tokens[idx]
    const src = token.attrGet('src') ?? ''
    const alt = token.content || token.attrGet('alt') || 'image'
    return `<a href="${escapeHtml(src)}">${escapeHtml(alt)}</a>`
  }

  rules.table_open = () => '<pre>'
  rules.table_close = () => '</pre>\n'
  rules.thead_open = () => ''
  rules.thead_close = () => ''
  rules.tbody_open = () => ''
  rules.tbody_close = () => ''
  rules.tr_open = () => ''
  rules.tr_close = () => '\n'
  rules.th_open = () => ''
  rules.th_close = () => ' | '
  rules.td_open = () => ''
  rules.td_close = () => ' | '

  rules.hr = () => '———\n'

  rules.softbreak = () => '\n'
  rules.hardbreak = () => '\n'

  rules.html_block = (tokens, idx) => escapeHtml(tokens[idx].content)
  rules.html_inline = (tokens, idx) => escapeHtml(tokens[idx].content)

  // Store original renderToken for fallback on unknown open/close tokens
  const originalRenderToken = md.renderer.renderToken.bind(md.renderer)

  md.renderer.renderToken = function (tokens: Token[], idx: number, options: Options) {
    const token = tokens[idx]
    // Suppress tags we don't explicitly handle (e.g. <p>, <ul>, <ol>, <li>, <table>)
    // Open/close tokens for known container types are handled by rules above
    const suppressed = new Set([
      'p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr',
      'dl', 'dt', 'dd'
    ])
    if (suppressed.has(token.tag)) return ''
    return originalRenderToken(tokens, idx, options)
  }

  // Reset state before each render
  const originalRender = md.render.bind(md)
  md.render = (src: string, env?: object) => {
    listStack = []
    blockquoteDepth = 0
    const result = originalRender(src, env ?? {})
    // Clean up excessive blank lines
    return result.replace(/\n{3,}/g, '\n\n').trim()
  }

  return md
}

const renderer = createTelegramRenderer()

export function markdownToTelegramHtml(markdown: string): string {
  return renderer.render(markdown)
}
