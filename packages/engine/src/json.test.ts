import { expect, test } from 'vitest'
import { isJson, jsonQuery, jsonValue } from './json.ts'

test('ISJSON defaults to object or array roots', () => {
  expect(isJson(null)).toBeNull()
  expect(isJson('{}')).toBe(1)
  expect(isJson(' [1, true, null] ')).toBe(1)
  expect(isJson('42')).toBe(0)
  expect(isJson('true')).toBe(0)
  expect(isJson('null')).toBe(0)
  expect(isJson('{bad}')).toBe(0)
  expect(isJson('{"a":1,}')).toBe(0)
  expect(isJson('[1,]')).toBe(0)
})

test('JSON_VALUE returns lexical scalar text and decodes strings', () => {
  const source = '{"number":1.20e+2,"boolean":true,"string":"a\\u0062","null":null,' +
    '"object":{"x":1},"array":[10,20],"first name":"Ada"}'
  expect(jsonValue(source, '$.number')).toBe('1.20e+2')
  expect(jsonValue(source, '$.boolean')).toBe('true')
  expect(jsonValue(source, '$.string')).toBe('ab')
  expect(jsonValue(source, '$.null')).toBeNull()
  expect(jsonValue(source, '$.object')).toBeNull()
  expect(jsonValue(source, '$.array')).toBeNull()
  expect(jsonValue(source, '$.array[1]')).toBe('20')
  expect(jsonValue(source, '$."first name"')).toBe('Ada')
  expect(jsonValue(source, '$.missing')).toBeNull()
  expect(jsonValue(null, '$.number')).toBeNull()
})

test('JSON_QUERY retains the selected object or array source slice', () => {
  const source = '{"a": { "b": 1 }, "items": [ 1, 2 ], "scalar": 1}'
  expect(jsonQuery(source, '$.a')).toBe('{ "b": 1 }')
  expect(jsonQuery(source, '$.items')).toBe('[ 1, 2 ]')
  expect(jsonQuery(source, '$.scalar')).toBeNull()
  expect(jsonQuery(source, '$.missing')).toBeNull()
  expect(jsonQuery(source, '$')).toBe(source)
})

test('strict paths and malformed inputs retain SQL Server error identities', () => {
  expect(() => jsonValue('{"a":1}', 'strict $.missing'))
    .toThrowError(expect.objectContaining({ number: 13608, state: 1 }) as Error)
  expect(() => jsonValue('{"a":{}}', 'strict $.a'))
    .toThrowError(expect.objectContaining({ number: 13623, state: 2 }) as Error)
  expect(() => jsonQuery('{"a":1}', 'strict $.a'))
    .toThrowError(expect.objectContaining({ number: 13624, state: 2 }) as Error)
  expect(() => jsonValue('{bad}', '$.a'))
    .toThrowError(expect.objectContaining({ number: 13609, state: 1 }) as Error)
  expect(() => jsonValue('{"a":1}', '$.['))
    .toThrowError(expect.objectContaining({ number: 13607, state: 1 }) as Error)
})

test('JSON_VALUE enforces the 4000 UTF-16-unit limit by path mode', () => {
  const source = JSON.stringify({ value: 'x'.repeat(4001) })
  expect(jsonValue(source, '$.value')).toBeNull()
  expect(() => jsonValue(source, 'strict $.value'))
    .toThrowError(expect.objectContaining({ number: 13625, state: 1 }) as Error)
  expect(jsonValue(JSON.stringify({ value: '😀'.repeat(2000) }), '$.value'))
    .toBe('😀'.repeat(2000))
})
