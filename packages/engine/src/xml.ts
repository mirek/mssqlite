import { Buffer } from 'node:buffer'
import { MssqlError } from './error.ts'

type Value =
  null | number | bigint | string | Uint8Array

type Descriptor = {
  readonly alias: string | null,
  readonly xml: boolean,
  readonly binary: boolean
}

type Spec = {
  readonly mode: 'path' | 'raw',
  readonly rowName: string,
  readonly root?: string,
  readonly elements: 'absent' | 'elements' | 'xsinil',
  readonly binaryBase64: boolean,
  readonly descriptors: readonly Descriptor[]
  readonly namespaces: readonly { readonly uri: string, readonly prefix?: string }[]
}

type Node = {
  readonly name: string,
  readonly attributes: { readonly name: string, readonly value: string }[],
  readonly children: (Node | string)[]
}

const escapeText =
  (value: string): string =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('\r', '&#xD;')

const escapeAttribute =
  (value: string): string =>
    escapeText(value).replaceAll('"', '&quot;')
      .replaceAll('\t', '&#x9;').replaceAll('\n', '&#xA;')

const encodedName =
  (value: string): string => {
    let result = ''
    for (const [ index, character ] of [ ...value ].entries()) {
      const valid = index === 0 ? /[A-Za-z_]/u.test(character) : /[\w.:-]/u.test(character)
      result += valid ? character : `_x${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}_`
    }
    return result
  }

const node =
  (name: string): Node =>
    ({ name: encodedName(name), attributes: [], children: [] })

const namespaceAttributes =
  (namespaces: Spec['namespaces'], xsinil: boolean): readonly {
    readonly name: string,
    readonly value: string
  }[] => [
    ...[ ...namespaces ].sort((left, right) =>
      left.prefix === undefined ? -1 : right.prefix === undefined ? 1 : 0).map(namespace => ({
      name: namespace.prefix === undefined ? 'xmlns' : `xmlns:${encodedName(namespace.prefix)}`,
      value: escapeAttribute(namespace.uri)
    })),
    ...xsinil ? [ {
      name: 'xmlns:xsi', value: 'http://www.w3.org/2001/XMLSchema-instance'
    } ] : []
  ]

const childNode =
  (parent: Node, name: string): Node => {
    const encoded = encodedName(name)
    const existing = parent.children.find((child): child is Node =>
      typeof child !== 'string' && child.name === encoded)
    if (existing !== undefined) {
      return existing
    }
    const created = node(name)
    parent.children.push(created)
    return created
  }

const textOf =
  (value: Exclude<Value, null>, descriptor: Descriptor, spec: Spec): string => {
    if (value instanceof Uint8Array) {
      if (spec.mode === 'raw' && !spec.binaryBase64) {
        throw new MssqlError(
          `FOR XML RAW mode cannot serialize binary column '${descriptor.alias ?? ''}' without BINARY BASE64.`,
          6829, 16)
      }
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
    }
    const text = String(value)
    return descriptor.xml ? text : escapeText(text)
  }

const addElement =
  (parent: Node, name: string, value: Value, descriptor: Descriptor, spec: Spec): void => {
    if (value === null) {
      if (spec.elements === 'xsinil') {
        const child = node(name)
        child.attributes.push({ name: 'xsi:nil', value: 'true' })
        parent.children.push(child)
      }
      return
    }
    const child = node(name)
    const content = textOf(value, descriptor, spec)
    if (content !== '' || !descriptor.xml) {
      child.children.push(content)
    }
    parent.children.push(child)
  }

const addPathValue =
  (root: Node, descriptor: Descriptor, value: Value, spec: Spec): void => {
    const alias = descriptor.alias
    if (alias === null || [ 'text()', 'data()', '*' ].includes(alias.toLowerCase())) {
      addInline(root, value, descriptor, spec)
      return
    }
    const parts = alias.split('/')
    if (parts.some(part => part === '')) {
      throw new MssqlError(`Invalid FOR XML PATH alias '${alias}'.`, 6850, 16)
    }
    let parent = root
    for (const part of parts.slice(0, -1)) {
      parent = childNode(parent, part)
    }
    const leaf = parts[parts.length - 1] ?? ''
    if (leaf.startsWith('@')) {
      if (value !== null) {
        parent.attributes.push({
          name: encodedName(leaf.slice(1)),
          value: escapeAttribute(value instanceof Uint8Array ?
            textOf(value, descriptor, spec) : String(value))
        })
      }
    } else if ([ 'text()', 'data()', '*' ].includes(leaf.toLowerCase())) {
      addInline(parent, value, descriptor, spec)
    } else {
      addElement(parent, leaf, value, descriptor, spec)
    }
  }

const addInline =
  (parent: Node, value: Value, descriptor: Descriptor, spec: Spec): void => {
    if (value !== null) {
      parent.children.push(textOf(value, descriptor, spec))
    }
  }

const renderNode =
  (value: Node): string => {
    const attributes = value.attributes.map(attribute =>
      ` ${attribute.name}="${attribute.value}"`).join('')
    return value.children.length === 0 ? `<${value.name}${attributes}/>` :
      `<${value.name}${attributes}>${value.children.map(child =>
        typeof child === 'string' ? child : renderNode(child)).join('')}</${value.name}>`
  }

const rawRow =
  (spec: Spec, values: readonly Value[]): string => {
    const row = node(spec.rowName)
    spec.descriptors.forEach((descriptor, index) => {
      const value = values[index] ?? null
      const alias = descriptor.alias
      if (alias === null) {
        throw new MssqlError('FOR XML RAW requires a name for every selected expression.', 6819, 16)
      }
      if (spec.elements === 'absent') {
        if (value !== null) {
          row.attributes.push({
            name: encodedName(alias),
            value: escapeAttribute(value instanceof Uint8Array ?
              textOf(value, descriptor, spec) : String(value))
          })
        }
      } else {
        addElement(row, alias, value, descriptor, spec)
      }
    })
    if (spec.root === undefined) {
      row.attributes.unshift(...namespaceAttributes(spec.namespaces, spec.elements === 'xsinil'))
    }
    return renderNode(row)
  }

const pathRow =
  (spec: Spec, values: readonly Value[]): string => {
    const row = node(spec.rowName)
    spec.descriptors.forEach((descriptor, index) =>
      addPathValue(row, descriptor, values[index] ?? null, spec))
    if (spec.root === undefined && spec.rowName !== '') {
      row.attributes.unshift(...namespaceAttributes(spec.namespaces, spec.elements === 'xsinil'))
    }
    return spec.rowName === '' ? row.children.map(child =>
      typeof child === 'string' ? child : renderNode(child)).join('') : renderNode(row)
  }

/** Serializes one SELECT row according to a static FOR XML descriptor. */
export const row =
  (specification: Value, ...values: Value[]): string => {
    const spec = JSON.parse(String(specification)) as Spec
    return spec.mode === 'raw' ? rawRow(spec, values) : pathRow(spec, values)
  }

/** Adds the optional document root and XSINIL namespace to aggregated rows. */
export const document =
  (content: Value, root: Value, xsinil: Value, namespaces: Value): string | null => {
    if (content === null) {
      return null
    }
    const body = String(content)
    if (root === null || String(root) === '') {
      return body
    }
    const name = encodedName(String(root))
    const declared = JSON.parse(String(namespaces ?? '[]')) as Spec['namespaces']
    const attributes = namespaceAttributes(declared, Number(xsinil) !== 0)
      .map(attribute => ` ${attribute.name}="${attribute.value}"`).join('')
    return body === '' ? `<${name}${attributes}/>` :
      `<${name}${attributes}>${body}</${name}>`
  }
