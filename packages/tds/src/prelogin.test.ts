import { expect, test } from 'vitest'
import { Hex } from '@mssqlite/bytes'
import * as Prelogin from './prelogin.ts'

/** MS-TDS example 4.1 prelogin request payload (without the 8-byte packet header). */
const example = Hex.of(`
  00 00 1A 00 06
  01 00 20 00 01
  02 00 21 00 01
  03 00 22 00 04
  04 00 26 00 01
  FF
  09 00 00 00 00 00
  01
  00
  B8 0D 00 00
  01
`)

test('decodes MS-TDS example request', () => {
  const prelogin = Prelogin.decode(example)
  expect(prelogin).toBeDefined()
  expect(prelogin?.version).toEqual({ major: 9, minor: 0, build: 0, subBuild: 0 })
  expect(prelogin?.encryption).toBe(Prelogin.Encryption.on)
  expect(prelogin?.instance).toBe('')
  expect(prelogin?.threadId).toBe(0x0db8)
  expect(prelogin?.mars).toBe(true)
  expect(prelogin?.options).toHaveLength(5)
})

test('response encode decodes back', () => {
  const bytes = Prelogin.encode({
    version: { major: 16, minor: 0, build: 4135 },
    encryption: Prelogin.Encryption.notSupported,
    mars: false
  })
  const decoded = Prelogin.decode(bytes)
  expect(decoded?.version).toEqual({ major: 16, minor: 0, build: 4135, subBuild: 0 })
  expect(decoded?.encryption).toBe(Prelogin.Encryption.notSupported)
  expect(decoded?.mars).toBe(false)
})

test('rejects malformed input', () => {
  expect(Prelogin.decode(new Uint8Array(0))).toBeUndefined()
  expect(Prelogin.decode(Hex.of('00 00'))).toBeUndefined()
})
