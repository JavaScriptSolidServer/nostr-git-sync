import 'websocket-polyfill'
import { SimplePool, nip19 } from 'nostr-tools'
import { loadConfig } from './config.js'
import { verifyEvent, verifyAnchor } from './verify.js'
import { gitSync, getCurrentCommit, runPostSync } from './git.js'

export async function startDaemon(configPath) {
  const config = loadConfig(configPath)
  const pool = new SimplePool()

  const repoIds = Object.keys(config.repos)

  console.log('[daemon] Starting nostr-git-sync')
  console.log(`[daemon] Watching ${repoIds.length} repo(s): ${repoIds.join(', ')}`)
  console.log(`[daemon] Relays: ${config.relays.join(', ')}`)

  // Subscribe to 30618 events for our repos
  const sub = pool.subscribeMany(
    config.relays,
    [{ kinds: [30618], '#d': repoIds }],
    {
      onevent: async (event) => {
        await handleEvent(event, config, nip19)
      },
      oneose: () => {
        console.log('[daemon] Caught up with relay history')
      }
    }
  )

  console.log('[daemon] Subscribed, waiting for events...')

  // Keep alive
  process.on('SIGINT', () => {
    console.log('\n[daemon] Shutting down...')
    sub.close()
    process.exit(0)
  })
}

async function handleEvent(event, config, nip19) {
  // Extract repo ID from d tag
  const dTag = event.tags.find(t => t[0] === 'd')
  if (!dTag) return

  const repoId = dTag[1]
  const repo = config.repos[repoId]
  if (!repo) return

  console.log(`\n[event] Received 30618 for ${repoId}`)
  console.log(`[event] From: ${nip19.npubEncode(event.pubkey).slice(0, 20)}...`)

  // Find branch ref
  const refTag = event.tags.find(t => t[0].startsWith('refs/heads/'))
  if (!refTag) {
    console.log('[event] No branch ref found, skipping')
    return
  }

  const branch = refTag[0].replace('refs/heads/', '')
  const commit = refTag[1]

  console.log(`[event] Branch: ${branch}, Commit: ${commit.slice(0, 7)}`)

  // Check if we're tracking this branch
  if (repo.branch && repo.branch !== branch) {
    console.log(`[event] Not tracking branch ${branch}, skipping`)
    return
  }

  // Verify pubkey is trusted
  const verification = verifyEvent(event, repo, nip19)
  if (!verification.ok) {
    console.log(`[event] ✗ Rejected: ${verification.reason}`)
    return
  }
  console.log('[event] ✓ Trusted publisher')

  // Optional: verify Blocktrails anchor
  if (repo.requireAnchor) {
    const npub = nip19.npubEncode(event.pubkey)
    const anchor = await verifyAnchor(npub, commit)
    if (!anchor.ok) {
      console.log(`[event] ✗ Anchor required but not found: ${anchor.reason}`)
      return
    }
    console.log('[event] ✓ Blocktrails anchor verified')
  }

  // Check if we're already at this commit
  const currentCommit = getCurrentCommit(repo.path)
  if (currentCommit === commit) {
    console.log('[event] Already at this commit, skipping')
    return
  }

  // Sync!
  const synced = gitSync(repo.path, commit, repo.cloneUrl)

  if (synced && repo.postSync) {
    await runPostSync(repo.path, repo.postSync)
  }
}
