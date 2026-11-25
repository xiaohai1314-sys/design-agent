export interface XmlNode {
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
}

/** 轻量级零依赖 XML 树解析器，同时兼容 Node 与浏览器渲染进程 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '__root__', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const tokenRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z0-9_:-]+)([^>]*)>|([^<]+)/g

  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(xml)) !== null) {
    if (match[1] !== undefined) {
      stack[stack.length - 1].text += match[1]
      continue
    }
    if (match[5] !== undefined) {
      stack[stack.length - 1].text += decodeXmlEntities(match[5])
      continue
    }
    if (!match[3]) continue
    const isClose = match[2] === '/'
    const tag = match[3]
    const attrStr = match[4] ?? ''
    const selfClosing = /\/\s*$/.test(attrStr)

    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }

    const attrs: Record<string, string> = {}
    const attrRe = /([A-Za-z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(attrStr)) !== null) {
      attrs[am[1]] = decodeXmlEntities(am[2] ?? am[3] ?? '')
    }

    const node: XmlNode = { tag, attrs, children: [], text: '' }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) {
      stack.push(node)
    }
  }

  return root
}

export function localTag(tag: string): string {
  const idx = tag.indexOf(':')
  return idx >= 0 ? tag.slice(idx + 1) : tag
}

export function findChildren(node: XmlNode | undefined, localName: string): XmlNode[] {
  if (!node) return []
  return node.children.filter((c) => localTag(c.tag) === localName)
}

export function findFirst(node: XmlNode | undefined, localName: string): XmlNode | undefined {
  if (!node) return undefined
  for (const c of node.children) {
    if (localTag(c.tag) === localName) return c
  }
  return undefined
}

export function findAllDesc(node: XmlNode | undefined, localName: string, acc: XmlNode[] = []): XmlNode[] {
  if (!node) return acc
  for (const c of node.children) {
    if (localTag(c.tag) === localName) acc.push(c)
    findAllDesc(c, localName, acc)
  }
  return acc
}

export function collectText(node: XmlNode | undefined): string {
  if (!node) return ''
  let out = node.text
  for (const c of node.children) out += collectText(c)
  return out
}
