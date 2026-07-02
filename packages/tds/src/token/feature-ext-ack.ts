import { Encode } from '@mssqlite/bytes'
import { Token } from '../token.ts'

/** @returns FEATUREEXTACK token bytes for acknowledged features. */
export const featureExtAck =
  (features: readonly { id: number, data: Uint8Array }[]): Uint8Array =>
    Encode.concat(
      Encode.uint8(Token.featureExtAck),
      ...features.map(feature =>
        Encode.concat(
          Encode.uint8(feature.id),
          Encode.lVarbyte(feature.data)
        )),
      Encode.uint8(0xff)
    )

export default featureExtAck
