import WebSocket from 'ws'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadConfig } from './config.js'
import { verifyEvent, verifyAnchor } from './verify.js'
import { gitSync, getCurrentCommit, runPostSync } from './git.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Status tracking
const status = {
  startedAt: new Date().toISOString(),
  repos: {},
  relays: {},
  recentEvents: [],
  discovered: {}
}

function updateStatus(configDir) {
  const statusPath = path.join(configDir, 'status.json')
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2))
}

export async function startDaemon(configPath) {
  const config = loadConfig(configPath)
  const configDir = path.dirname(path.resolve(configPath))
  const repoIds = Object.keys(config.repos)

  // Initialize repo status
  repoIds.forEach(id => {
    const repo = config.repos[id]
    status.repos[id] = {
      path: repo.path,
      lastSync: null,
      lastEvent: null,
      syncCount: 0,
      status: 'watching'
    }
  })
  updateStatus(configDir)

  console.log('[daemon] Starting nostr-git-sync')
  console.log(`[daemon] Watching ${repoIds.length} repo(s): ${repoIds.join(', ')}`)
  console.log(`[daemon] Relays: ${config.relays.join(', ')}`)

  const sockets = []

  // Initialize relay status
  config.relays.forEach(url => {
    status.relays[url] = { connected: false, lastMessage: null }
  })

  // Connect to each relay
  config.relays.forEach((url, index) => {
    connectToRelay(url, index, repoIds, config, configDir, sockets)
  })

  // Connect to same relays as ngit for discovery
  const discoveryRelays = [
    'wss://relay.nostr.net/',
    'wss://nos.lol/',
    'wss://relay.damus.io/',
    'wss://nostr.wine/',
    'wss://relay.snort.social/',
    'wss://nostr.mom/',
    'wss://relay.nostr.band/',
    'wss://purplepag.es/',
    'wss://offchain.pub/'
  ]

  discoveryRelays.forEach((url, index) => {
    connectDiscoveryRelay(url, config, configDir)
  })

  // Start dashboard server
  const port = config.dashboardPort || 3847
  startDashboardServer(port, configDir, config)

  // Keep alive
  process.on('SIGINT', () => {
    console.log('\n[daemon] Shutting down...')
    sockets.forEach(ws => ws.close())
    process.exit(0)
  })
}

let currentConfig = null

function startDashboardServer(port, configDir, config) {
  const dashboardPath = path.join(__dirname, '..', 'dashboard.html')
  const configPath = path.join(configDir, 'repos.json')
  currentConfig = config

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.end()
      return
    }

    if (req.url === '/' || req.url === '/index.html') {
      res.setHeader('Content-Type', 'text/html')
      fs.createReadStream(dashboardPath).pipe(res)
    } else if (req.url === '/status.json' || req.url.startsWith('/status.json?')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(status, null, 2))
    } else if (req.url === '/config.json' || req.url.startsWith('/config.json?')) {
      res.setHeader('Content-Type', 'application/json')
      fs.createReadStream(configPath).pipe(res)
    } else if (req.url.startsWith('/sync/') && req.method === 'POST') {
      const repoId = decodeURIComponent(req.url.replace('/sync/', ''))
      await handleManualSync(repoId, configDir, res)
    } else if (req.url.startsWith('/add/') && req.method === 'POST') {
      const repoId = decodeURIComponent(req.url.replace('/add/', ''))
      await handleAddRepo(repoId, configDir, configPath, res)
    } else if (req.url.startsWith('/delete/') && req.method === 'POST') {
      const repoId = decodeURIComponent(req.url.replace('/delete/', ''))
      await handleDeleteRepo(repoId, configDir, configPath, res)
    } else {
      res.statusCode = 404
      res.end('Not Found')
    }
  })

  server.listen(port, () => {
    console.log(`[dashboard] Running at http://localhost:${port}`)
  })
}

async function handleAddRepo(dedupKey, configDir, configPath, res) {
  res.setHeader('Content-Type', 'application/json')

  const discovered = status.discovered[dedupKey]
  if (!discovered) {
    res.statusCode = 404
    res.end(JSON.stringify({ ok: false, error: 'Repo not found in discovered list' }))
    return
  }

  const repoId = discovered.id

  // Generate path from clone URL or repo ID
  let repoPath
  if (discovered.cloneUrl) {
    // Extract path from URL like https://github.com/user/repo
    const match = discovered.cloneUrl.match(/github\.com\/(.+?)(\.git)?$/)
    if (match) {
      repoPath = `/home/melvin/sync/github.com/${match[1]}`
    } else {
      repoPath = `/home/melvin/sync/${repoId}`
    }
  } else {
    repoPath = `/home/melvin/sync/${repoId}`
  }

  // Read current config
  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

  // Add new repo
  configData.repos[repoId] = {
    path: repoPath,
    cloneUrl: discovered.cloneUrl,
    trusted: [discovered.pubkey],
    postSync: "echo 'Synced!'"
  }

  // Write config
  fs.writeFileSync(configPath, JSON.stringify(configData, null, 2))

  // Update current config
  currentConfig.repos[repoId] = configData.repos[repoId]

  // Initialize status for new repo
  status.repos[repoId] = {
    path: repoPath,
    lastSync: null,
    lastEvent: null,
    syncCount: 0,
    status: 'watching'
  }

  // Remove from discovered
  delete status.discovered[dedupKey]
  updateStatus(configDir)

  console.log(`[add] Added ${repoId} to config`)
  res.end(JSON.stringify({ ok: true, path: repoPath }))
}

async function handleDeleteRepo(repoId, configDir, configPath, res) {
  res.setHeader('Content-Type', 'application/json')

  if (!currentConfig.repos[repoId]) {
    res.statusCode = 404
    res.end(JSON.stringify({ ok: false, error: 'Repo not found' }))
    return
  }

  // Read current config
  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

  // Remove repo
  delete configData.repos[repoId]
  delete currentConfig.repos[repoId]
  delete status.repos[repoId]

  // Write config
  fs.writeFileSync(configPath, JSON.stringify(configData, null, 2))
  updateStatus(configDir)

  console.log(`[delete] Removed ${repoId} from config`)
  res.end(JSON.stringify({ ok: true }))
}

function handleDiscoveredEvent(event, config, configDir) {
  // Extract repo ID from d tag
  const dTag = event.tags.find(t => t[0] === 'd')
  if (!dTag) return

  const repoId = dTag[1]

  // Skip if already tracking this repo
  if (config.repos[repoId]) return

  // Dedup key: pubkey + d tag (same as ngit)
  const dedupKey = `${event.pubkey}:${repoId}`

  // Skip if we have a newer version of this event
  const existing = status.discovered[dedupKey]
  if (existing && existing.createdAt >= event.created_at) return

  // Extract clone URL
  const cloneTag = event.tags.find(t => t[0] === 'clone')
  const cloneUrl = cloneTag ? cloneTag[1] : null

  // Extract name
  const nameTag = event.tags.find(t => t[0] === 'name')
  const name = nameTag ? nameTag[1] : repoId

  // Extract description
  const descTag = event.tags.find(t => t[0] === 'description')
  const description = descTag ? descTag[1] : ''

  // Store or update discovered repo (keyed by pubkey:repoId for dedup)
  status.discovered[dedupKey] = {
    id: repoId,
    name,
    description,
    cloneUrl,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    eventId: event.id
  }

  // Keep only 50 most recent by created_at (same as ngit)
  const discovered = Object.entries(status.discovered)
  if (discovered.length > 50) {
    discovered.sort((a, b) => b[1].createdAt - a[1].createdAt)
    status.discovered = Object.fromEntries(discovered.slice(0, 50))
  }

  updateStatus(configDir)
}

async function handleManualSync(repoId, configDir, res) {
  res.setHeader('Content-Type', 'application/json')

  const repo = currentConfig?.repos?.[repoId]
  if (!repo) {
    res.statusCode = 404
    res.end(JSON.stringify({ ok: false, error: 'Repository not found' }))
    return
  }

  console.log(`\n[manual] Sync requested for ${repoId}`)

  if (status.repos[repoId]) {
    status.repos[repoId].status = 'syncing'
    updateStatus(configDir)
  }

  try {
    const synced = gitSync(repo.path, null, repo.cloneUrl)
    if (synced) {
      if (status.repos[repoId]) {
        status.repos[repoId].lastSync = new Date().toISOString()
        status.repos[repoId].syncCount++
        status.repos[repoId].status = 'synced'
        updateStatus(configDir)
      }
      if (repo.postSync) {
        await runPostSync(repo.path, repo.postSync)
      }
      console.log(`[manual] ✓ Sync complete for ${repoId}`)
      res.end(JSON.stringify({ ok: true }))
    } else {
      if (status.repos[repoId]) {
        status.repos[repoId].status = 'error'
        updateStatus(configDir)
      }
      res.end(JSON.stringify({ ok: false, error: 'Sync failed' }))
    }
  } catch (err) {
    console.log(`[manual] ✗ Error: ${err.message}`)
    if (status.repos[repoId]) {
      status.repos[repoId].status = 'error'
      updateStatus(configDir)
    }
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: err.message }))
  }
}

function connectDiscoveryRelay(url, config, configDir) {
  const ws = new WebSocket(url)

  ws.on('open', () => {
    console.log(`[discover] Connected to ${url}`)

    // Only subscribe to 30617 for discovery
    const discoverSubscription = JSON.stringify([
      'REQ',
      'discover-extra',
      { kinds: [30617], limit: 100 }
    ])
    ws.send(discoverSubscription)
  })

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString())
      if (message[0] === 'EVENT' && message[2]) {
        handleDiscoveredEvent(message[2], config, configDir)
      }
    } catch (err) {
      // ignore parse errors
    }
  })

  ws.on('error', () => {})

  ws.on('close', () => {
    console.log(`[discover] Disconnected from ${url}, reconnecting in 30s...`)
    setTimeout(() => connectDiscoveryRelay(url, config, configDir), 30000)
  })
}

function connectToRelay(url, index, repoIds, config, configDir, sockets) {
  const ws = new WebSocket(url)

  ws.on('open', () => {
    console.log(`[daemon] Connected to ${url}`)
    sockets.push(ws)
    status.relays[url] = { connected: true, connectedAt: new Date().toISOString() }
    updateStatus(configDir)

    // Subscribe to 30617 (repo announcement) and 30618 (repo state) events for tracked repos
    const subscription = JSON.stringify([
      'REQ',
      `git-sync-${index}`,
      { kinds: [30617, 30618], '#d': repoIds }
    ])
    ws.send(subscription)

    // Subscribe to ALL 30617 events for discovery (limit to recent)
    const discoverSubscription = JSON.stringify([
      'REQ',
      `discover-${index}`,
      { kinds: [30617], limit: 100 }
    ])
    ws.send(discoverSubscription)
  })

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString())
      status.relays[url].lastMessage = new Date().toISOString()

      if (message[0] === 'EVENT' && message[2]) {
        const subId = message[1]
        if (subId.startsWith('discover-')) {
          handleDiscoveredEvent(message[2], config, configDir)
        } else {
          await handleEvent(message[2], config, configDir)
        }
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
    status.relays[url].connected = false
    updateStatus(configDir)

    setTimeout(() => {
      connectToRelay(url, index, repoIds, config, configDir, sockets)
    }, 10000)
  })
}

async function handleEvent(event, config, configDir) {
  // Extract repo ID from d tag
  const dTag = event.tags.find(t => t[0] === 'd')
  if (!dTag) return

  const repoId = dTag[1]
  const repo = config.repos[repoId]
  if (!repo) return

  const kind = event.kind
  console.log(`\n[event] Received ${kind} for ${repoId}`)
  console.log(`[event] From: ${event.pubkey.slice(0, 16)}...`)

  // Track event received
  if (status.repos[repoId]) {
    status.repos[repoId].lastEvent = new Date().toISOString()
    status.repos[repoId].lastEventKind = kind
  }

  // Log to recent events
  status.recentEvents.unshift({
    time: new Date().toISOString(),
    kind,
    repo: repoId,
    pubkey: event.pubkey.slice(0, 16),
    id: event.id?.slice(0, 8)
  })
  if (status.recentEvents.length > 10) {
    status.recentEvents.pop()
  }
  updateStatus(configDir)

  // Verify pubkey is trusted
  const verification = verifyEvent(event, repo)
  if (!verification.ok) {
    console.log(`[event] ✗ Rejected: ${verification.reason}`)
    return
  }
  console.log('[event] ✓ Trusted publisher')

  // Handle 30617 (repo announcement) - simpler, just trigger sync
  if (kind === 30617) {
    console.log('[event] Repository announcement, triggering sync')

    // Extract clone URL from event if present
    const cloneTag = event.tags.find(t => t[0] === 'clone')
    const cloneUrl = cloneTag ? cloneTag[1] : repo.cloneUrl

    const synced = gitSync(repo.path, null, cloneUrl)
    if (synced) {
      if (status.repos[repoId]) {
        status.repos[repoId].lastSync = new Date().toISOString()
        status.repos[repoId].syncCount++
        status.repos[repoId].status = 'synced'
        updateStatus(configDir)
      }
      if (repo.postSync) {
        await runPostSync(repo.path, repo.postSync)
      }
    }
    return
  }

  // Handle 30618 (repo state) - detailed with commit info
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

  if (synced) {
    if (status.repos[repoId]) {
      status.repos[repoId].lastSync = new Date().toISOString()
      status.repos[repoId].lastCommit = commit
      status.repos[repoId].syncCount++
      status.repos[repoId].status = 'synced'
      updateStatus(configDir)
    }
    if (repo.postSync) {
      await runPostSync(repo.path, repo.postSync)
    }
  }
}
