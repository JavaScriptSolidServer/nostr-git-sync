import { execSync, exec } from 'child_process'
import { existsSync } from 'fs'

export function gitSync(repoPath, commit, cloneUrl) {
  // Only update existing repos for now
  if (!existsSync(repoPath)) {
    console.error(`[git] ✗ Repo doesn't exist: ${repoPath}`)
    return false
  }

  // If no commit specified (30617 event), just pull latest
  if (!commit) {
    console.log(`[git] Pulling latest for ${repoPath}`)
    try {
      execSync(`git pull`, {
        cwd: repoPath,
        stdio: 'pipe'
      })
      console.log(`[git] ✓ Pulled latest`)
      return true
    } catch (err) {
      console.error(`[git] ✗ Pull failed:`, err.message)
      return false
    }
  }

  // Specific commit (30618 event)
  console.log(`[git] Syncing ${repoPath} to ${commit.slice(0, 7)}`)

  try {
    // Fetch latest
    execSync(`git fetch --all`, {
      cwd: repoPath,
      stdio: 'pipe'
    })

    // Checkout specific commit
    execSync(`git checkout ${commit}`, {
      cwd: repoPath,
      stdio: 'pipe'
    })

    console.log(`[git] ✓ Synced to ${commit.slice(0, 7)}`)
    return true
  } catch (err) {
    console.error(`[git] ✗ Failed:`, err.message)
    return false
  }
}

export function getCurrentCommit(repoPath) {
  try {
    const result = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      stdio: 'pipe'
    })
    return result.toString().trim()
  } catch {
    return null
  }
}

export function runPostSync(repoPath, command) {
  if (!command) return true

  console.log(`[post-sync] Running: ${command}`)

  return new Promise((resolve) => {
    exec(command, { cwd: repoPath }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[post-sync] ✗ Failed:`, err.message)
        resolve(false)
      } else {
        console.log(`[post-sync] ✓ Complete`)
        resolve(true)
      }
    })
  })
}
