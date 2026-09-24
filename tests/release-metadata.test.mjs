import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const script = new URL('../scripts/verify-release.mjs', import.meta.url)

test('release metadata accepts a tag that matches the package version', () => {
  const result = spawnSync(process.execPath, [script.pathname], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: `v${packageJson.version}` },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`v${packageJson.version.replaceAll('.', '\\.')}`))
})

test('release metadata rejects a tag that differs from the package version', () => {
  const result = spawnSync(process.execPath, [script.pathname], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: 'v99.0.0' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must match/)
})
