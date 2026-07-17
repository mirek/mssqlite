import { write } from './artifact.ts'
import { defaultImage } from './docker.ts'
import { run } from './run.ts'

process.env.TZ = 'UTC'

const main =
  async (): Promise<void> => {
    const generatedAt = new Date().toISOString()
    let completed: Awaited<ReturnType<typeof run>>
    try {
      completed = await run()
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      await write({
        generatedAt,
        image: process.env.MSSQLITE_DIFFERENTIAL_IMAGE ?? defaultImage,
        architecture: process.arch,
        node: process.version,
        results: [],
        failure: message
      })
      throw error
    }
    const path = await write({
      generatedAt,
      image: completed.image,
      architecture: process.arch,
      node: process.version,
      results: completed.results
    })
    const failures = completed.results.filter(result =>
      result.comparison.unexpected.length > 0 ||
      result.comparison.unusedExpectations.length > 0)
    if (failures.length === 0) {
      console.log(`Differential suite passed ${completed.results.length} cases. Artifact: ${path}`)
      return
    }
    for (const failure of failures) {
      console.error(failure.reproduction)
      console.error(JSON.stringify(failure.comparison, null, 2))
    }
    throw new Error(`${failures.length} differential case(s) failed. Artifact: ${path}`)
  }

await main()
