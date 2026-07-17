import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const prefix = 'mssqlite$scrypt$v1'
const keyLength = 64
const saltLength = 16
const maximumPasswordLength = 1024
const scryptOptions = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const

/** Password-hash-only SQL login configuration. */
export type Credential = {
  readonly userName: string,
  readonly passwordHash: string
}

export type AuthenticationOptions =
  | { readonly type: 'insecure' }
  | {
      readonly type: 'password',
      /** A provider is re-read for every login, enabling atomic hash rotation. */
      readonly credentials: readonly Credential[] | (() => readonly Credential[])
    }

/** Returns the canonical configured login name, or undefined on failure. */
export type Authenticator =
  (userName: string, password: string) => string | undefined

type ParsedHash = {
  readonly salt: Uint8Array,
  readonly digest: Uint8Array
}

const parseHash =
  (encoded: string): ParsedHash | undefined => {
    const parts = encoded.split('$')
    if (parts.length !== 5 || parts.slice(0, 3).join('$') !== prefix) {
      return undefined
    }
    try {
      const salt = Buffer.from(parts[3] ?? '', 'base64url')
      const digest = Buffer.from(parts[4] ?? '', 'base64url')
      return salt.byteLength === saltLength && digest.byteLength === keyLength ?
        { salt, digest } : undefined
    } catch {
      return undefined
    }
  }

const validUserName =
  (userName: string): boolean =>
    userName.length > 0 && userName.length <= 128 && !userName.includes('\0')

const validate =
  (credentials: readonly Credential[]): Map<string, Credential> => {
    const result = new Map<string, Credential>()
    for (const credential of credentials) {
      const key = credential.userName.toLowerCase()
      if (!validUserName(credential.userName) || parseHash(credential.passwordHash) === undefined) {
        throw new TypeError('Invalid SQL login credential configuration.')
      }
      if (result.has(key)) {
        throw new TypeError('Duplicate SQL login credential configuration.')
      }
      result.set(key, credential)
    }
    return result
  }

/** Creates a versioned scrypt hash suitable for password authentication configuration. */
export const hashPassword =
  (password: string): string => {
    if (password.length === 0 || password.length > maximumPasswordLength) {
      throw new TypeError('SQL login passwords must contain between 1 and 1024 characters.')
    }
    const salt = randomBytes(saltLength)
    const digest = scryptSync(password, salt, keyLength, scryptOptions)
    return `${prefix}$${salt.toString('base64url')}$${digest.toString('base64url')}`
  }

const verify =
  (password: string, encoded: string): boolean => {
    const parsed = parseHash(encoded)
    if (parsed === undefined) {
      return false
    }
    const digest = scryptSync(password, parsed.salt, keyLength, scryptOptions)
    return timingSafeEqual(digest, parsed.digest)
  }

/** Compiles authentication configuration and validates its startup snapshot. */
export const authenticator =
  (options: AuthenticationOptions): Authenticator => {
    if (options.type === 'insecure') {
      return userName => userName === '' ? 'sa' : userName
    }
    const configured = options.credentials
    const load: () => readonly Credential[] = typeof configured === 'function' ?
      configured : () => configured
    validate(load())
    const dummy = hashPassword(randomBytes(32).toString('base64url'))
    return (userName, password) => {
      const validInput = validUserName(userName) &&
        password.length > 0 && password.length <= maximumPasswordLength
      let credentials: Map<string, Credential> | undefined
      try {
        credentials = validate(load())
      } catch {
        // Reload failures fail closed while retaining the same password work.
      }
      const credential = credentials?.get(userName.toLowerCase())
      const candidate = validInput ? password : password.slice(0, maximumPasswordLength) || 'invalid'
      const matches = verify(candidate, credential?.passwordHash ?? dummy)
      return validInput && matches ? credential?.userName : undefined
    }
  }
