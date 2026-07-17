import { expect, test } from 'vitest'
import * as Cp1252 from './cp1252.ts'

test('Windows-1252 extension bytes encode and decode', () => {
  const bytes = Uint8Array.from([ 0x41, 0x80, 0x82, 0x9f, 0xff ])
  expect(Cp1252.decode(bytes)).toBe('A€‚Ÿÿ')
  expect(Cp1252.encode('A€‚Ÿÿ')).toEqual(bytes)
})

test('undefined extension positions round trip as C1 controls', () => {
  const bytes = Uint8Array.from([ 0x81, 0x8d, 0x8f, 0x90, 0x9d ])
  expect(Cp1252.encode(Cp1252.decode(bytes))).toEqual(bytes)
})

test('unrepresentable Unicode becomes a question mark', () => {
  expect(Cp1252.encode('Ж')).toEqual(Uint8Array.of(0x3f))
})
