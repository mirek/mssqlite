import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { CaseResult } from './types.ts'

export type Artifact = {
  readonly generatedAt: string,
  readonly image: string,
  readonly architecture: string,
  readonly node: string,
  readonly results: readonly CaseResult[],
  readonly failure?: string
}

export const artifactPath =
  (): string => resolve(import.meta.dirname, '../../..',
    process.env.MSSQLITE_DIFFERENTIAL_ARTIFACT ?? 'artifacts/differential/results.json')

/** Persists complete snapshots while console failures stay concise. */
export const write =
  async (artifact: Artifact): Promise<string> => {
    const path = artifactPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(artifact, null, 2) + '\n', 'utf8')
    return path
  }
