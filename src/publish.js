import WebSocket from 'ws'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { execSync } from 'child_process'

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band'
]

/**
 * Publish a 30618 repo state event
 */
export async function publishState(privateKeyHex, relays, repoId, repoPath) {
  // Get current branch and commit
  const branch = execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: repoPath,
    encoding: 'utf-8'
  }).trim()

  const commit = execSync('git rev-parse HEAD', {
    cwd: repoPath,
    encoding: 'utf-8'
  }).trim()

  // Create and sign event
  const event = finalizeEvent({
    kind: 30618,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', repoId],
      [`refs/heads/${branch}`, commit]
    ],
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
  let privkey, repoId, repoPath = '.'

  // Check args
  if (process.argv[2] && !process.argv[2].startsWith('-')) {
    // Args provided: privkey repoId [repoPath]
    privkey = process.argv[2]
    repoId = process.argv[3]
    repoPath = process.argv[4] || '.'
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
    console.log('Usage: node src/publish.js <privkey-hex> <repo-id> [repo-path]')
    console.log('   or: git config nostr.privkey <hex> && node src/publish.js')
    process.exit(1)
  }

  publishState(privkey, DEFAULT_RELAYS, repoId, repoPath)
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error:', err.message)
      process.exit(1)
    })
}
