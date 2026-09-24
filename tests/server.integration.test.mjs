import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { after, before, test } from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

let child
let client
let transport
let baseUrl

async function availablePort() {
  const socketServer = createServer()
  socketServer.listen(0, '127.0.0.1')
  await once(socketServer, 'listening')
  const { port } = socketServer.address()
  await new Promise((resolve, reject) => socketServer.close(error => error ? reject(error) : resolve()))
  return port
}

async function waitUntilHealthy(url) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MCP process exited (${child.exitCode}).`)
    try {
      const response = await fetch(`${url}/health`)
      if (response.ok) return
    } catch { /* Server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('MCP process did not become healthy.')
}

before(async () => {
  const port = await availablePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), MCP_HOST: 'mcp.arcade-games.nl', TRUST_PROXY_HOPS: '0', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000) })
  await waitUntilHealthy(baseUrl).catch(error => { throw new Error(`${error.message}\n${stderr}`) })
})

after(async () => {
  await client?.close().catch(() => {})
  child?.kill('SIGTERM')
  if (child && child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))])
})

test('health and readiness endpoints expose service status without secrets', async () => {
  const [health, readiness] = await Promise.all([fetch(`${baseUrl}/health`), fetch(`${baseUrl}/ready`)])
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true, service: 'mind-arcade-mcp' })
  assert.equal(readiness.status, 200)
  assert.deepEqual(await readiness.json(), {
    ready: true,
    service: 'mind-arcade-mcp',
    features: { accountCreation: false, scoreSubmission: false },
  })
})

test('DNS rebinding guard rejects an unconfigured Host header', async () => {
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(`${baseUrl}/health`, { headers: { host: 'attacker.example' } }, response => resolve(response))
    request.on('error', reject)
    request.end()
  })
  assert.equal(response.statusCode, 403)
})

test('MCP handshake lists six-game tools and keeps public mutations operator-gated', async () => {
  client = new Client({ name: 'mind-arcade-integration-test', version: '1.0.0' })
  transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`))
  await client.connect(transport)
  const { tools } = await client.listTools()
  const names = tools.map(tool => tool.name)
  assert.deepEqual(names, [
    'arcade_games',
    'arcade_rules',
    'arcade_challenges',
    'arcade_create_account',
    'arcade_start_game',
    'arcade_read_game',
    'arcade_make_move',
    'arcade_submit_score',
    'arcade_leaderboard',
    'arcade_public_profile',
  ])
  const gameTool = tools.find(tool => tool.name === 'arcade_start_game')
  assert.deepEqual(gameTool.inputSchema.properties.game.enum, [
    'signal-hunter', 'circuit-garden', 'protocol-duel', 'crate-current', 'bloom-shift', 'tidal-atlas',
  ])

  const account = await client.callTool({ name: 'arcade_create_account', arguments: { name: 'Test Agent', operatorApproval: true } })
  assert.equal(account.isError, true)
  assert.match(account.content[0].text, /disabled by the arcade operator/)

  const score = await client.callTool({ name: 'arcade_submit_score', arguments: {
    sessionId: 'a'.repeat(32), accountToken: 'b'.repeat(64), sessionToken: 'c'.repeat(64), operatorApproval: true,
  } })
  assert.equal(score.isError, true)
  assert.match(score.content[0].text, /disabled by the arcade operator/)
})
