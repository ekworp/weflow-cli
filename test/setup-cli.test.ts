import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseRequirements, resolvePackages } from '../src/services/setupVenv.js'
import { orderCandidates } from '../src/utils/python.js'

/** Runs the real CLI with HOME redirected, so nothing touches the user's state. */
function runCli(home: string, args: string[]) {
  return spawnSync(process.execPath, [
    '--import', 'tsx', join(process.cwd(), 'bin', 'weflow-cli.ts'), ...args,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
}

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'weflow-setup-cli-'))
  try {
    run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function payload(stdout: string): any {
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error(`no JSON payload in output: ${stdout.slice(0, 120)}`)
  return JSON.parse(stdout.slice(start))
}

test('setup previews the plan without touching anything', () => {
  withHome((home) => {
    const result = runCli(home, ['setup', '--dry-run', '--json'])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const body = payload(result.stdout)
    assert.equal(body.dryRun, true)
    assert.equal(body.action, 'setup.venv')
    // The venv lives under the redirected HOME, never the real one.
    assert.equal(body.venvDir, join(home, '.weflow-cli', 'venv'))
    assert.equal(body.venvExists, false)
    assert.equal(body.readsLocalData, false)
    assert.equal(body.network, true)
    assert.ok(body.requirementFiles.includes('requirements.txt'))

    // The package list comes from requirements.txt with comments stripped.
    assert.ok(body.packages.includes('zstandard'))
    assert.ok(body.packages.includes('cryptography'))
    assert.ok(!body.packages.some((p: string) => p.startsWith('#')))
    // The Windows substitution is stated, and actually applied.
    if (process.platform === 'win32') {
      assert.ok(body.packages.includes('sqlcipher3-wheels'))
      assert.ok(!body.packages.includes('sqlcipher3'))
      assert.equal(body.substitutions.length, 1)
    } else {
      assert.ok(body.packages.includes('sqlcipher3'))
      assert.equal(body.substitutions.length, 0)
    }
  })
})

test('setup requires --yes for machine execution, and --non-interactive cannot bypass it', () => {
  withHome((home) => {
    const refused = runCli(home, ['setup', '--json'])
    assert.equal(refused.status, 1)
    assert.equal(payload(refused.stdout).code, 'CONFIRMATION_REQUIRED')

    const nonInteractive = runCli(home, ['setup', '--non-interactive', '--json'])
    assert.equal(nonInteractive.status, 1)
    assert.equal(payload(nonInteractive.stdout).code, 'CONFIRMATION_REQUIRED')
    // Nothing was created: the refusal happens before any filesystem write.
    assert.equal(payload(nonInteractive.stdout).dryRun, false)
  })
})

test('requirements parsing drops comments and blanks; substitution is platform-gated', () => {
  const names = parseRequirements(
    '# a comment\nsqlcipher3\n\npymem\n  cryptography  \n# trailing comment')
  assert.deepEqual(names, ['sqlcipher3', 'pymem', 'cryptography'])

  const win = resolvePackages(names, 'win32')
  assert.ok(win.packages.includes('sqlcipher3-wheels'))
  assert.ok(!win.packages.includes('sqlcipher3'))
  assert.equal(win.substitutions.length, 1)

  const linux = resolvePackages(names, 'linux')
  assert.deepEqual(linux.packages, names)
  assert.deepEqual(linux.substitutions, [])
})

test('the managed venv is always the first python candidate once it exists', () => {
  // This ordering is the whole point of setup: a venv that was installed but not
  // preferred leaves both sides "working" while the runtime keeps hitting the
  // PATH interpreter - exactly the 9009 support burden setup exists to remove.
  const managed = join('home', '.weflow-cli', 'venv', 'bin', 'python')
  assert.equal(orderCandidates(managed, ['python3', 'python'])[0], managed)
  // It is not duplicated when the PATH list already contains the same path.
  assert.deepEqual(orderCandidates(managed, [managed, 'python3']), [managed, 'python3'])
  // No managed venv: order unchanged.
  assert.deepEqual(orderCandidates(null, ['python3']), ['python3'])
})
