import { Encode } from '@mssqlite/bytes'
import { Token } from '../token.ts'
import * as TypeInfo from '../type-info.ts'
import * as Value from '../value.ts'

/** RETURNVALUE fields — an OUTPUT parameter or UDF return value. */
export type ReturnValue = {
  readonly ordinal: number,
  readonly name: string,
  /** 0x01 = OUTPUT parameter, 0x02 = UDF return value. */
  readonly status?: number,
  readonly userType?: number,
  readonly flags?: number,
  readonly typeInfo: TypeInfo.t,
  readonly value: Value.t
}

/** @returns RETURNVALUE token bytes. */
export const returnValue =
  (parameter: ReturnValue): Uint8Array =>
    Encode.concat(
      Encode.uint8(Token.returnValue),
      Encode.uint16(parameter.ordinal),
      Encode.bVarchar(parameter.name),
      Encode.uint8(parameter.status ?? 0x01),
      Encode.uint32(parameter.userType ?? 0),
      Encode.uint16(parameter.flags ?? 0x0001),
      TypeInfo.encode(parameter.typeInfo),
      Value.encode(parameter.typeInfo, parameter.value)
    )

export default returnValue
