#!/usr/bin/env node
import listen from './server.ts'

const path = process.argv[2] ?? process.env['MSSQLITE_PATH'] ?? ':memory:'
const port = Number(process.argv[3] ?? process.env['MSSQLITE_PORT'] ?? 1433)

const listening = await listen({ path, port })
console.log(`mssqlite listening on port ${listening.port}, database ${path}`)

process.on('SIGINT', () => {
  listening.close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1))
})
