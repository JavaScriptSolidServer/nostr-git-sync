import 'websocket-polyfill'
import { SimplePool, finalizeEvent, nip19 } from 'nostr-tools'
import { execSync } from 'child_process'

/**
 * Publish a 30618 repo state event
 */
export async function publishState(privateKey, relays, repoId, repoPath) {
  const pool = new SimplePool()

  // Get current branch and commit
  const branch = execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: repoPath,
    encoding: 'utf-8'
  }).trim()

  const commit = execSync('git rev-parse HEAD', {
    cwd: repoPath,
    encoding: 'utf-8'
  }).trim()

  const event = finalizeEvent({
    kind: 30618,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', repoId],
      [`refs/heads/${branch}`, commit]
    ],
    content: ''
  }, privateKey)

  console.log(`[publish] Publishing 30618 for ${repoId}`)
  console.log(`[publish] Branch: ${branch}, Commit: ${commit.slice(0, 7)}`)
  console.log(`[publish] From: ${nip19.npubEncode(event.pubkey).slice(0, 20)}...`)

  await Promise.any(pool.publish(relays, event))

  console.log('[publish] ✓ Published to relays')

  pool.close(relays)

  return event
}

// CLI usage
if (process.argv[1].endsWith('publish.js')) {
  const [,, nsec, repoId, repoPath = '.'] = process.argv

  if (!nsec || !repoId) {
    console.log('Usage: node src/publish.js <nsec> <repo-id> [repo-path]')
    process.exit(1)
  }

  const { data: privateKey } = nip19.decode(nsec)

  const relays = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band'
  ]

  publishState(privateKey, relays, repoId, repoPath)
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error:', err.message)
      process.exit(1)
    })
}
