import WebSocket from 'ws'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { execSync } from 'child_process'

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band'
]

/**
 * Create Bitcoin anchor for commit using blocktrails
 * Returns txo URI or null if anchoring fails/skipped
 */
async function createAnchor(commit, repoPath, options = {}) {
  const { network = 'tbtc4', dryRun = false } = options

  try {
    const args = ['mark', commit]
    if (dryRun) args.push('--dry')

    const output = execSync(`blocktrails ${args.join(' ')}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })

    // Parse TXID from output: "TXID: <txid>"
    const txidMatch = output.match(/TXID:\s*([a-f0-9]{64})/i)
    if (txidMatch) {
      const txid = txidMatch[1]
      // Output is always vout 0 for mark command
      return `txo:${network}:${txid}:0`
    }

    console.log('[anchor] Could not parse TXID from blocktrails output')
    return null
  } catch (err) {
    console.log(`[anchor] Blocktrails not available or failed: ${err.message}`)
    return null
  }
}

/**
 * Publish a 30618 repo state event
 */
export async function publishState(privateKeyHex, relays, repoId, repoPath, options = {}) {
  const { anchor = false, network = 'tbtc4', dryRun = false } = options

  // Get current branch and commit
  const branch = execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: repoPath,
    encoding: 'utf-8'
  }).trim()

  const commit = execSync('git rev-parse HEAD', {
    cwd: repoPath,
    encoding: 'utf-8'
  }).trim()

  // Build tags
  const tags = [
    ['d', repoId],
    [`refs/heads/${branch}`, commit]
  ]

  // Create Bitcoin anchor if requested
  if (anchor) {
    console.log(`[anchor] Creating Bitcoin anchor for ${commit.slice(0, 7)}...`)
    const txoUri = await createAnchor(commit, repoPath, { network, dryRun })
    if (txoUri) {
      tags.push(['c', txoUri])
      console.log(`[anchor] ✓ Anchored: ${txoUri}`)
    }
  }

  // Create and sign event
  const event = finalizeEvent({
    kind: 30618,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  }, hexToBytes(privateKeyHex))

  console.log(`[publish] Publishing 30618 for ${repoId}`)
  console.log(`[publish] Branch: ${branch}, Commit: ${commit.slice(0, 7)}`)
  console.log(`[publish] From: ${event.pubkey.slice(0, 16)}...`)

  // Publish to relays
  const published = await publishToRelays(relays, event)

  if (published > 0) {
    console.log(`[publish] ✓ Published to ${published} relay(s)`)
  } else {
    console.log('[publish] ✗ Failed to publish to any relay')
  }

  return event
}

function publishToRelays(relays, event) {
  return new Promise((resolve) => {
    let published = 0
    let completed = 0

    relays.forEach(url => {
      const ws = new WebSocket(url)
      const timeout = setTimeout(() => {
        ws.close()
      }, 5000)

      ws.on('open', () => {
        ws.send(JSON.stringify(['EVENT', event]))
      })

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg[0] === 'OK' && msg[1] === event.id) {
          if (msg[2]) published++
          clearTimeout(timeout)
          ws.close()
        }
      })

      ws.on('close', () => {
        completed++
        if (completed === relays.length) {
          resolve(published)
        }
      })

      ws.on('error', () => {
        clearTimeout(timeout)
        completed++
        if (completed === relays.length) {
          resolve(published)
        }
      })
    })
  })
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return bytes
}

// CLI usage
if (process.argv[1].endsWith('publish.js')) {
  const args = process.argv.slice(2)
  const flags = args.filter(a => a.startsWith('-'))
  const positional = args.filter(a => !a.startsWith('-'))

  const anchor = flags.includes('--anchor') || flags.includes('-a')
  const help = flags.includes('--help') || flags.includes('-h')

  if (help) {
    console.log(`
nostr-git-sync publish - Publish 30618 repo state event

Usage:
  node src/publish.js [options] [privkey] [repo-id] [repo-path]

Options:
  -a, --anchor    Create Bitcoin anchor (requires blocktrails CLI)
  -h, --help      Show this help

If no arguments provided, reads from git config:
  git config nostr.privkey <hex>
  git config nostr.repoid <id>  (optional, defaults to directory name)

Examples:
  node src/publish.js                      # Use git config
  node src/publish.js --anchor             # With Bitcoin anchor
  node src/publish.js <key> my-repo .      # Explicit args
`)
    process.exit(0)
  }

  let privkey, repoId, repoPath = '.'

  if (positional.length > 0) {
    // Args provided: privkey repoId [repoPath]
    privkey = positional[0]
    repoId = positional[1]
    repoPath = positional[2] || '.'
  } else {
    // Read from git config
    try {
      privkey = execSync('git config nostr.privkey', { encoding: 'utf-8' }).trim()
      repoId = execSync('git config nostr.repoid', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    } catch {
      // repoId from directory name
    }
    if (!repoId) {
      repoId = process.cwd().split('/').pop()
    }
  }

  if (!privkey) {
    console.log('Usage: node src/publish.js [--anchor] <privkey-hex> <repo-id> [repo-path]')
    console.log('   or: git config nostr.privkey <hex> && node src/publish.js [--anchor]')
    process.exit(1)
  }

  publishState(privkey, DEFAULT_RELAYS, repoId, repoPath, { anchor })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error:', err.message)
      process.exit(1)
    })
}
