/** Token ids of server response streams. */
export const Token = {
  returnStatus: 0x79,
  colMetadata: 0x81,
  order: 0xa9,
  error: 0xaa,
  info: 0xab,
  returnValue: 0xac,
  loginAck: 0xad,
  featureExtAck: 0xae,
  row: 0xd1,
  nbcRow: 0xd2,
  envChange: 0xe3,
  sessionState: 0xe4,
  sspi: 0xed,
  fedAuthInfo: 0xee,
  done: 0xfd,
  doneProc: 0xfe,
  doneInProc: 0xff
} as const

export type Token =
  typeof Token[keyof typeof Token]

export type t =
  Token
