import { expect, test } from 'vitest'
import { Encode, Ucs2 } from '@mssqlite/bytes'
import * as Login7 from './login7.ts'

/** @returns synthetic Login7 payload with variable data and optional feature extension. */
const build =
  (fields: {
    userName: string,
    password: string,
    hostName?: string,
    appName?: string,
    database?: string,
    features?: { id: number, data: Uint8Array }[]
  }): Uint8Array => {
    const withExtension = fields.features !== undefined
    // Variable data entries in offset/length pair order — extension (index 5) is
    // a 4-byte pointer to the feature list, patched once offsets are known.
    const entries: { data: Uint8Array, count: number }[] = [
      { data: Ucs2.encode(fields.hostName ?? ''), count: (fields.hostName ?? '').length },
      { data: Ucs2.encode(fields.userName), count: fields.userName.length },
      { data: Login7.scramblePassword(fields.password), count: fields.password.length },
      { data: Ucs2.encode(fields.appName ?? ''), count: (fields.appName ?? '').length },
      { data: Ucs2.encode(''), count: 0 },
      withExtension ?
        { data: Encode.uint32(0), count: 4 } :
        { data: new Uint8Array(0), count: 0 },
      { data: Ucs2.encode('tds'), count: 3 },
      { data: Ucs2.encode(''), count: 0 },
      { data: Ucs2.encode(fields.database ?? ''), count: (fields.database ?? '').length }
    ]
    const fixedLength = 94
    let offset = fixedLength
    const pairs: Uint8Array[] = []
    for (const entry of entries) {
      pairs.push(Encode.uint16(offset), Encode.uint16(entry.count))
      offset += entry.data.byteLength
    }
    const featureList = withExtension ?
      Encode.concat(
        ...(fields.features ?? []).map(feature =>
          Encode.concat(Encode.uint8(feature.id), Encode.lVarbyte(feature.data))),
        Encode.uint8(0xff)
      ) :
      new Uint8Array(0)
    if (withExtension) {
      const extension = entries[5]
      if (extension !== undefined) {
        extension.data = Encode.uint32(offset)
      }
    }
    return Encode.concat(
      Encode.uint32(offset + featureList.byteLength), // length
      Encode.uint32(0x04000074), // tdsVersion 7.4
      Encode.uint32(4096), // packetSize
      Encode.uint32(7), // clientProgVer
      Encode.uint32(123), // clientPid
      Encode.uint32(0), // connectionId
      Encode.uint8(0xe0), // optionFlags1
      Encode.uint8(0x03), // optionFlags2
      Encode.uint8(0), // typeFlags
      Encode.uint8(withExtension ? 0x10 : 0), // optionFlags3
      Encode.int32(0), // clientTimeZone
      Encode.uint32(0x0409), // clientLcid
      ...pairs,
      new Uint8Array(6), // clientId
      Encode.uint16(0), Encode.uint16(0), // ibSSPI + cbSSPI
      Encode.uint16(0), Encode.uint16(0), // ibAtchDBFile + cchAtchDBFile
      Encode.uint16(0), Encode.uint16(0), // ibChangePassword + cchChangePassword
      Encode.uint32(0), // cbSSPILong
      ...entries.map(entry => entry.data),
      featureList
    )
  }

test('password scramble round trips', () => {
  const scrambled = Login7.scramblePassword('p@ssw0rd!')
  expect(Login7.descramblePassword(scrambled)).toBe('p@ssw0rd!')
})

test('decodes synthetic login', () => {
  const payload = build({
    userName: 'sa',
    password: 'secret',
    hostName: 'skontos1',
    appName: 'node',
    database: 'main'
  })
  const login = Login7.decode(payload)
  expect(login).toBeDefined()
  expect(login?.tdsVersion).toBe(0x04000074)
  expect(login?.packetSize).toBe(4096)
  expect(login?.clientPid).toBe(123)
  expect(login?.hostName).toBe('skontos1')
  expect(login?.userName).toBe('sa')
  expect(login?.password).toBe('secret')
  expect(login?.appName).toBe('node')
  expect(login?.database).toBe('main')
  expect(login?.clientInterfaceName).toBe('tds')
  expect(login?.features).toEqual([])
})

test('decodes feature extension list', () => {
  const payload = build({
    userName: 'sa',
    password: '',
    features: [
      { id: 0x0a, data: new Uint8Array(0) },
      { id: 0x09, data: Uint8Array.of(1) }
    ]
  })
  const login = Login7.decode(payload)
  expect(login?.features).toEqual([
    { id: 0x0a, data: new Uint8Array(0) },
    { id: 0x09, data: Uint8Array.of(1) }
  ])
})

test('rejects malformed input', () => {
  expect(Login7.decode(new Uint8Array(10))).toBeUndefined()
})
