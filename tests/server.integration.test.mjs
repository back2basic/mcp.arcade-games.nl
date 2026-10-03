import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
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

async function waitUntilHealthy(url, process = child) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`MCP process exited (${process.exitCode}).`)
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

test('MCP handshake lists seven-game tools and keeps public mutations operator-gated', async () => {
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
    'arcade_read_replay',
  ])
  const gameTool = tools.find(tool => tool.name === 'arcade_start_game')
  assert.deepEqual(gameTool.inputSchema.properties.game.enum, [
    'signal-hunter', 'circuit-garden', 'protocol-duel', 'crate-current', 'bloom-shift', 'tidal-atlas', 'orrery-of-echoes',
  ])
  const moveTool = tools.find(tool => tool.name === 'arcade_make_move')
  assert.match(JSON.stringify(moveTool.inputSchema), /"turn"/)
  assert.match(JSON.stringify(moveTool.inputSchema), /"clockwise"/)
  assert.match(JSON.stringify(moveTool.inputSchema), /"counterclockwise"/)
  assert.match(JSON.stringify(moveTool.inputSchema), /"ring"/)

  const account = await client.callTool({ name: 'arcade_create_account', arguments: { name: 'Test Agent', operatorApproval: true } })
  assert.equal(account.isError, true)
  assert.match(account.content[0].text, /disabled by the arcade operator/)

  const score = await client.callTool({ name: 'arcade_submit_score', arguments: {
    sessionId: 'a'.repeat(32), accountToken: 'b'.repeat(64), sessionToken: 'c'.repeat(64), operatorApproval: true,
  } })
  assert.equal(score.isError, true)
  assert.match(score.content[0].text, /disabled by the arcade operator/)
})

test('Orrery supports an authenticated daily play, verified result, profile, leaderboard, and replay', async () => {
  const accountToken = 'b'.repeat(64)
  const sessionToken = 'c'.repeat(64)
  const sessionId = 'a'.repeat(32)
  const requests = []
  let moveCount = 0
  const dailyMoves = [
    ...Array.from({ length: 6 }, () => ({ type: 'turn', ring: 1, direction: 'counterclockwise' })),
    ...Array.from({ length: 3 }, () => ({ type: 'turn', ring: 2, direction: 'clockwise' })),
  ]
  const state = (count = moveCount) => {
    const positions = [3, 6, 15]
    for (const move of dailyMoves.slice(0, count)) {
      const delta = move.direction === 'clockwise' ? 1 : -1
      const linked = (move.ring + 1) % 3
      positions[move.ring] = (positions[move.ring] + delta + 24) % 24
      positions[linked] = (positions[linked] - delta + 24) % 24
    }
    const won = count === dailyMoves.length
    const remaining = 13 - count
    return {
      sessionId, game: 'orrery-of-echoes', ranked: true, mode: 'daily', day: '2026-09-25', name: 'Orrery Test AI',
      revision: count, expiresAt: '2026-09-26T00:00:00.000Z', status: won ? 'won' : 'playing',
      energy: remaining, score: won ? 1000 + remaining * 40 : 0, rulesVersion: 2,
      positions, target: [0, 0, 0], sectors: 24,
      ringNames: ['Inner ring', 'Middle ring', 'Outer ring'], budget: 13,
      history: dailyMoves.slice(0, count),
    }
  }
  const upstream = createHttpServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bodyText = Buffer.concat(chunks).toString('utf8')
    const body = bodyText ? JSON.parse(bodyText) : undefined
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, sessionToken: request.headers['x-session-token'], body })
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.method === 'GET' && request.url === '/llms.txt') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('### Orrery of Echoes\n\nThree linked rings, each with 24 positions numbered 0–23; target is [0,0,0]. A clockwise turn advances the chosen ring and moves its linked neighbor counterclockwise.\n\nMove: {"type":"turn","ring":0,"direction":"clockwise"}. Win score: 1000 + 40 * remaining turns.\n')
      return
    }
    if (request.method === 'POST' && request.url === '/api/agents/accounts') return send(201, { accountId: 'd'.repeat(32), name: 'Orrery Test AI', token: accountToken })
    if (request.method === 'POST' && request.url === '/api/agents/sessions') return send(201, { ...state(), token: sessionToken })
    if (request.method === 'GET' && request.url === `/api/agents/sessions/${sessionId}`) return send(200, state())
    if (request.method === 'POST' && request.url === `/api/agents/sessions/${sessionId}/moves`) {
      moveCount += 1
      return send(200, state())
    }
    if (request.method === 'POST' && request.url === `/api/agents/sessions/${sessionId}/score`) return send(200, { saved: true, game: 'orrery-of-echoes', score: 1160, leaderboard: '/leaderboard' })
    if (request.method === 'GET' && request.url === '/api/agents/leaderboard?game=orrery-of-echoes&mode=daily') return send(200, { game: 'orrery-of-echoes', scores: [{ accountId: 'd'.repeat(32), score: 1160, won: true, moves: 9 }] })
    if (request.method === 'GET' && request.url === `/api/agents/players/${'d'.repeat(32)}`) return send(200, { accountId: 'd'.repeat(32), name: 'Orrery Test AI', games: { 'orrery-of-echoes': { runs: 1, wins: 1, bestScore: 1160 } } })
    if (request.method === 'GET' && request.url === `/api/agents/replays/${sessionId}`) return send(200, {
      game: 'orrery-of-echoes', score: 1160, initial: state(0),
      frames: dailyMoves.map((_, index) => state(index + 1)),
    })
    return send(404, { code: 'not_found' })
  })
  const upstreamPort = await availablePort()
  upstream.listen(upstreamPort, '127.0.0.1')
  await once(upstream, 'listening')

  const mcpPort = await availablePort()
  const mcpUrl = `http://127.0.0.1:${mcpPort}`
  const enabledProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(mcpPort), MCP_HOST: 'mcp.arcade-games.nl', TRUST_PROXY_HOPS: '0', NODE_ENV: 'test',
      ARCADE_API_ORIGIN: `http://127.0.0.1:${upstreamPort}`, ALLOW_ACCOUNT_CREATION: 'true', ALLOW_SCORE_SUBMISSION: 'true',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const testClient = new Client({ name: 'mind-arcade-orrery-integration-test', version: '1.0.0' })
  try {
    await waitUntilHealthy(mcpUrl, enabledProcess)
    await testClient.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`)))
    const decode = result => {
      assert.notEqual(result.isError, true, result.content?.[0]?.text)
      return JSON.parse(result.content[0].text)
    }
    const rules = await testClient.callTool({ name: 'arcade_rules', arguments: { game: 'orrery-of-echoes' } })
    assert.notEqual(rules.isError, true, rules.content?.[0]?.text)
    assert.match(rules.content[0].text, /24 positions/)
    assert.match(rules.content[0].text, /Win score: 1000 \+ 40 \* remaining turns/)
    const account = decode(await testClient.callTool({ name: 'arcade_create_account', arguments: { name: 'Orrery Test AI', operatorApproval: true } }))
    assert.equal(account.token, accountToken)
    const started = decode(await testClient.callTool({ name: 'arcade_start_game', arguments: { game: 'orrery-of-echoes', mode: 'daily', accountToken } }))
    assert.deepEqual(started.positions, [3, 6, 15])
    assert.equal(started.budget, 13)
    assert.equal(started.rulesVersion, 2)
    const read = decode(await testClient.callTool({ name: 'arcade_read_game', arguments: { sessionId, sessionToken } }))
    assert.equal(read.game, 'orrery-of-echoes')
    let moved
    for (const move of dailyMoves) {
      moved = decode(await testClient.callTool({ name: 'arcade_make_move', arguments: {
        sessionId, sessionToken, revision: moved?.revision ?? 0, move,
      } }))
    }
    assert.deepEqual(moved.positions, [0, 0, 0])
    assert.equal(moved.status, 'won')
    assert.equal(moved.energy, 4)
    assert.equal(moved.score, 1160)
    assert.equal(decode(await testClient.callTool({ name: 'arcade_submit_score', arguments: {
      sessionId, accountToken, sessionToken, operatorApproval: true,
    } })).score, 1160)
    assert.equal(decode(await testClient.callTool({ name: 'arcade_leaderboard', arguments: { game: 'orrery-of-echoes', mode: 'daily' } })).scores[0].score, 1160)
    assert.equal(decode(await testClient.callTool({ name: 'arcade_public_profile', arguments: { accountId: 'd'.repeat(32) } })).games['orrery-of-echoes'].runs, 1)
    const replay = decode(await testClient.callTool({ name: 'arcade_read_replay', arguments: { resultId: sessionId } }))
    assert.equal(replay.game, 'orrery-of-echoes')
    assert.deepEqual(replay.initial.positions, [3, 6, 15])
    assert.equal(replay.frames.length, 9)
    assert.deepEqual(replay.frames.at(-1).positions, [0, 0, 0])
    assert.equal(replay.score, 1160)

    const startRequest = requests.find(entry => entry.method === 'POST' && entry.url === '/api/agents/sessions')
    assert.equal(startRequest.authorization, `Bearer ${accountToken}`)
    assert.deepEqual(startRequest.body, { kind: 'ai', game: 'orrery-of-echoes', mode: 'daily', name: 'MCP guest' })
    const moveRequest = requests.find(entry => entry.method === 'POST' && entry.url.endsWith('/moves'))
    const lastMoveRequest = requests.filter(entry => entry.method === 'POST' && entry.url.endsWith('/moves')).at(-1)
    assert.equal(moveRequest.authorization, `Bearer ${sessionToken}`)
    assert.deepEqual(moveRequest.body, { revision: 0, move: dailyMoves[0] })
    assert.deepEqual(lastMoveRequest.body, { revision: 8, move: dailyMoves[8] })
    const scoreRequest = requests.find(entry => entry.method === 'POST' && entry.url.endsWith('/score'))
    assert.equal(scoreRequest.authorization, `Bearer ${accountToken}`)
    assert.equal(scoreRequest.sessionToken, sessionToken)
    assert.ok(requests.some(entry => entry.url === `/api/agents/replays/${sessionId}`))
  } finally {
    await testClient.close().catch(() => {})
    enabledProcess.kill('SIGTERM')
    if (enabledProcess.exitCode === null) await Promise.race([once(enabledProcess, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))])
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  }
})
