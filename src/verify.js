import { verifyEvent as verifySignature } from 'nostr-tools/pure'

export function verifyEvent(event, repo) {
  // 1. Verify cryptographic signature
  if (!verifySignature(event)) {
    return { ok: false, reason: 'invalid signature' }
  }

  // 2. Check pubkey is in trusted list (all hex)
  const eventPubkey = event.pubkey

  for (const trusted of repo.trusted) {
    const trustedHex = trusted.type === 'hex' ? trusted.value : null
    if (trustedHex && eventPubkey === trustedHex) {
      return { ok: true }
    }
  }

  return { ok: false, reason: 'pubkey not in trusted list' }
}

export async function verifyAnchor(pubkeyHex, commit) {
  // Query Blocktrails for anchor proof (use hex pubkey)
  const url = `https://blocktrails.org/${pubkeyHex}?commit=${commit}`

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
