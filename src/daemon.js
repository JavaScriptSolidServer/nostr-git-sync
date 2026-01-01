import WebSocket from 'ws'
import { loadConfig } from './config.js'
import { verifyEvent, verifyAnchor } from './verify.js'
import { gitSync, getCurrentCommit, runPostSync } from './git.js'

export async function startDaemon(configPath) {
  const config = loadConfig(configPath)
  const repoIds = Object.keys(config.repos)

  console.log('[daemon] Starting nostr-git-sync')
  console.log(`[daemon] Watching ${repoIds.length} repo(s): ${repoIds.join(', ')}`)
  console.log(`[daemon] Relays: ${config.relays.join(', ')}`)

  const sockets = []

  // Connect to each relay
  config.relays.forEach((url, index) => {
    connectToRelay(url, index, repoIds, config, sockets)
  })

  // Keep alive
  process.on('SIGINT', () => {
    console.log('\n[daemon] Shutting down...')
    sockets.forEach(ws => ws.close())
    process.exit(0)
  })
}

function connectToRelay(url, index, repoIds, config, sockets) {
  const ws = new WebSocket(url)

  ws.on('open', () => {
    console.log(`[daemon] Connected to ${url}`)
    sockets.push(ws)

    // Subscribe to 30618 events for our repos
    const subscription = JSON.stringify([
      'REQ',
      `git-sync-${index}`,
      { kinds: [30618], '#d': repoIds }
    ])
    ws.send(subscription)
  })

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString())

      if (message[0] === 'EVENT' && message[2]) {
        await handleEvent(message[2], config)
      } else if (message[0] === 'EOSE') {
        console.log(`[daemon] Caught up with ${url}`)
      } else if (message[0] === 'NOTICE') {
        console.log(`[notice] ${url}: ${message[1]}`)
      }
    } catch (err) {
      console.error('[daemon] Error parsing message:', err.message)
    }
  })

  ws.on('error', (err) => {
    console.log(`[daemon] Error from ${url}: ${err.message}`)
  })

  ws.on('close', () => {
    console.log(`[daemon] Disconnected from ${url}, reconnecting in 10s...`)
    const idx = sockets.indexOf(ws)
    if (idx > -1) sockets.splice(idx, 1)

    setTimeout(() => {
      connectToRelay(url, index, repoIds, config, sockets)
    }, 10000)
  })
}

async function handleEvent(event, config) {
  // Extract repo ID from d tag
  const dTag = event.tags.find(t => t[0] === 'd')
  if (!dTag) return

  const repoId = dTag[1]
  const repo = config.repos[repoId]
  if (!repo) return

  console.log(`\n[event] Received 30618 for ${repoId}`)
  console.log(`[event] From: ${event.pubkey.slice(0, 16)}...`)

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
  const verification = verifyEvent(event, repo)
  if (!verification.ok) {
    console.log(`[event] ✗ Rejected: ${verification.reason}`)
    return
  }
  console.log('[event] ✓ Trusted publisher')

  // Optional: verify Blocktrails anchor
  if (repo.requireAnchor) {
    const anchor = await verifyAnchor(event.pubkey, commit)
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
