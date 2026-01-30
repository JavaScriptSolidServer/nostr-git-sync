# nostr-git-sync

Decentralized git sync daemon using Nostr (NIP-34).

## Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Publisher     │     │  Nostr Relays   │     │   Subscribers   │
│  (git push)     │────▶│  (30618 events) │────▶│  (git pull)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

When a publisher pushes to a repo, they broadcast a NIP-34 event announcing the update. Subscribers watching for that repo automatically pull.

Supports both event kinds:
- **30617** (repo announcement): Simple "repo was updated" trigger → `git pull`
- **30618** (repo state): Specific commit hash → `git checkout <commit>`

## Key Features

- **Unified identity**: Same secp256k1 key for Nostr, Bitcoin (Blocktrails), and ACLs
- **NIP-34 compatible**: Uses standard `kind:30618` repo state events
- **ACL-based trust**: Only pull from `did:nostr:npub...` keys you trust
- **Optional Blocktrails verification**: Require Bitcoin-anchored commits

## Install

```bash
npm install
cp repos.json.example repos.json
# Edit repos.json with your config
```

## Usage

### Subscriber (daemon)

```bash
# Start watching for updates
npm start

# Or with custom config
node bin/nostr-git-sync.js /path/to/repos.json
```

### Publisher (after git push)

```bash
# Announce new repo state
node src/publish.js <nsec> <repo-id> [repo-path]

# Example
node src/publish.js nsec1... JavaScriptSolidServer .
```

## Configuration

```json
{
  "relays": ["wss://relay.damus.io", "wss://nos.lol"],
  "repos": {
    "JavaScriptSolidServer": {
      "path": "/var/www/jss",
      "cloneUrl": "https://github.com/...",
      "branch": "gh-pages",
      "trusted": ["did:nostr:npub1..."],
      "requireAnchor": false,
      "postSync": "npm install"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `path` | Local path to git repo |
| `cloneUrl` | Git remote URL (for future clone support) |
| `branch` | Only sync this branch (optional) |
| `trusted` | Array of `did:nostr:npub...` keys allowed to trigger sync |
| `requireAnchor` | Require Blocktrails verification before sync |
| `postSync` | Command to run after successful sync |

## NIP-34 Event Structure

### Kind 30617: Repository Announcement (Simple)

```json
{
  "kind": 30617,
  "pubkey": "<publisher-hex>",
  "tags": [
    ["d", "JavaScriptSolidServer"],
    ["clone", "https://github.com/..."],
    ["web", "https://jss.example.com"],
    ["name", "JavaScript Solid Server"]
  ],
  "content": "Optional description"
}
```

Use 30617 for simple "repo was updated" notifications. The daemon will `git pull` when received.

### Kind 30618: Repository State (Detailed)

```json
{
  "kind": 30618,
  "pubkey": "<publisher-hex>",
  "tags": [
    ["d", "JavaScriptSolidServer"],
    ["refs/heads/gh-pages", "7a356be..."]
  ],
  "content": ""
}
```

Use 30618 for precise commit tracking. The daemon will `git checkout <commit>` when received.

## Identity Model

The same secp256k1 keypair is used across:

- **Nostr**: Signs 30618 events (`npub1...`)
- **Bitcoin**: Controls UTXOs via Blocktrails key tweaking
- **ACL**: `did:nostr:npub...` format in trusted list

## Roadmap

- [x] 30617 support (simple repo announcement trigger)
- [ ] 30617 discovery (auto-clone from Nostr)
- [ ] Blocktrails anchor verification
- [ ] Git hook for auto-publish
- [ ] Systemd service file
- [ ] Multi-branch support

## License

MIT
