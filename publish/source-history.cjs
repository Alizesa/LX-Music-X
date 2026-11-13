const { execFileSync } = require('node:child_process')

// All comparisons concern immutable commit IDs. A concurrent push may add a
// commit after checkout; fetch that object once instead of guessing its ancestry.
function createSourceHistory(root, execute = execFileSync) {
  const comparisons = new Map()
  const run = args => execute('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
  return (ancestor, descendant) => {
    if (![ancestor, descendant].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Invalid source history SHA')
    if (ancestor === descendant) return true
    const key = `${ancestor}/${descendant}`
    if (comparisons.has(key)) return comparisons.get(key)
    const compare = () => {
      try { run(['merge-base', '--is-ancestor', ancestor, descendant]); return true } catch (error) {
        if (error.status === 1) return false
        throw error
      }
    }
    let result
    try { result = compare() } catch {
      run(['fetch', '--no-tags', 'origin', ancestor, descendant])
      result = compare()
    }
    comparisons.set(key, result)
    return result
  }
}

module.exports = { createSourceHistory }
