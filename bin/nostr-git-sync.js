#!/usr/bin/env node

import { startDaemon } from '../src/daemon.js'

const configPath = process.argv[2] || 'repos.json'

console.log(`Loading config from: ${configPath}`)

startDaemon(configPath).catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
