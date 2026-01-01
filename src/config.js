import { readFileSync } from 'fs'
import { resolve } from 'path'

export function loadConfig(configPath) {
  const fullPath = resolve(configPath || 'repos.json')
  const content = readFileSync(fullPath, 'utf-8')
  const config = JSON.parse(content)

  // Validate
  if (!config.relays?.length) {
    throw new Error('Config must have at least one relay')
  }
  if (!config.repos || Object.keys(config.repos).length === 0) {
    throw new Error('Config must have at least one repo')
  }

  // Normalize trusted keys to hex pubkeys
  for (const [id, repo] of Object.entries(config.repos)) {
    repo.trusted = repo.trusted.map(key => normalizeKey(key))
  }

  return config
}

// Convert did:nostr:npub... or npub... to hex
function normalizeKey(key) {
  // did:nostr:npub1abc... → npub1abc...
  if (key.startsWith('did:nostr:')) {
    key = key.slice(10)
  }

  // npub1... → hex (defer to nostr-tools)
  if (key.startsWith('npub1')) {
    // Will be decoded at runtime
    return { type: 'npub', value: key }
  }

  // Assume hex
  return { type: 'hex', value: key }
}

export function getHexPubkey(normalized, nip19) {
  if (normalized.type === 'hex') return normalized.value
  if (normalized.type === 'npub') {
    const decoded = nip19.decode(normalized.value)
    return decoded.data
  }
  throw new Error(`Unknown key type: ${normalized.type}`)
}
