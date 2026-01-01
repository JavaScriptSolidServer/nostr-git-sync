import { getHexPubkey } from './config.js'

export function verifyEvent(event, repo, nip19) {
  // Check pubkey is in trusted list
  const eventPubkey = event.pubkey // hex

  for (const trusted of repo.trusted) {
    const trustedHex = getHexPubkey(trusted, nip19)
    if (eventPubkey === trustedHex) {
      return { ok: true }
    }
  }

  return { ok: false, reason: 'pubkey not in trusted list' }
}

export async function verifyAnchor(npub, commit) {
  // Query Blocktrails for anchor proof
  const url = `https://blocktrails.org/${npub}?commit=${commit}`

  try {
    const response = await fetch(url)
    if (response.ok) {
      const data = await response.json()
      // Check if commit is anchored
      // The git-mark profile uses commit as tweak
      if (data.commits?.includes(commit) || data.tweaks?.includes(commit)) {
        return { ok: true, anchor: data }
      }
    }
    return { ok: false, reason: 'no anchor found' }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}
