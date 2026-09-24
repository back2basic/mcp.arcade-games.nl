import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'

const GAME_IDS = ['signal-hunter', 'circuit-garden', 'protocol-duel', 'crate-current', 'bloom-shift', 'tidal-atlas']
const gameSchema = z.enum(GAME_IDS)
const directionSchema = z.enum(['north', 'east', 'south', 'west'])
const moveSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['distance', 'bearing', 'pulse', 'locate']), x: z.number().int().min(0).max(7), y: z.number().int().min(0).max(7) }).strict(),
  z.object({ type: z.literal('rotate'), cell: z.number().int().min(0).max(15) }).strict(),
  z.object({ type: z.literal('program'), actions: z.array(z.enum(['north', 'east', 'south', 'west', 'fire', 'shield', 'capture', 'wait'])).length(3) }).strict(),
  z.object({ type: z.literal('walk'), direction: directionSchema }).strict(),
  z.object({ type: z.literal('press'), cell: z.number().int().min(0).max(24) }).strict(),
  z.object({ type: z.literal('sail'), direction: directionSchema }).strict(),
  z.object({ type: z.literal('wait') }).strict(),
])
const sessionIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
const sessionTokenSchema = z.string().regex(/^[a-f0-9]{64}$/)
const accountTokenSchema = z.string().regex(/^[a-f0-9]{64}$/)
const accountIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
const PORT = Number(process.env.PORT ?? 3000)
const MCP_HOST = process.env.MCP_HOST ?? 'mcp.arcade-games.nl'
const MCP_ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS ?? `https://${MCP_HOST},https://arcade-games.nl,https://www.arcade-games.nl`)
  .split(',').map(value => value.trim()).filter(Boolean)
const CREATE_ACCOUNTS = process.env.ALLOW_ACCOUNT_CREATION === 'true'
const SUBMIT_SCORES = process.env.ALLOW_SCORE_SUBMISSION === 'true'
const REQUESTS_PER_MINUTE = Number(process.env.MCP_REQUESTS_PER_MINUTE ?? 120)
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 1)
const MAX_UPSTREAM_BYTES = 1_000_000

function requiredNumber(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`)
  return value
}
requiredNumber('PORT', PORT, 1, 65535)
requiredNumber('MCP_REQUESTS_PER_MINUTE', REQUESTS_PER_MINUTE, 10, 10_000)
requiredNumber('TRUST_PROXY_HOPS', TRUST_PROXY_HOPS, 0, 5)
if (!/^(localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(MCP_HOST)) {
  throw new Error('MCP_HOST must be a hostname without a scheme, port, or path.')
}

const apiOrigin = new URL(process.env.ARCADE_API_ORIGIN ?? 'https://arcade-games.nl')
if (apiOrigin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(apiOrigin.hostname)) {
  throw new Error('ARCADE_API_ORIGIN must use HTTPS outside local development.')
}
if (apiOrigin.pathname !== '/' || apiOrigin.search || apiOrigin.hash || apiOrigin.username || apiOrigin.password) {
  throw new Error('ARCADE_API_ORIGIN must be a plain origin without path, query, credentials, or fragment.')
}
if (process.env.NODE_ENV === 'production' && apiOrigin.protocol !== 'https:') {
  throw new Error('ARCADE_API_ORIGIN must use HTTPS in production.')
}
for (const value of MCP_ALLOWED_ORIGINS) {
  const allowedOrigin = new URL(value)
  if (allowedOrigin.protocol !== 'https:' || allowedOrigin.origin !== value) {
    throw new Error('MCP_ALLOWED_ORIGINS must be a comma-separated list of HTTPS origins without paths.')
  }
}

class ArcadeApiError extends Error {
  constructor(status, code) {
    super(`The arcade API returned HTTP ${status} (${code}).`)
    this.name = 'ArcadeApiError'
    this.status = status
    this.code = code
  }
}

function safeCode(value) {
  if (typeof value !== 'string') return 'request_failed'
  const code = value.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 48)
  return code || 'request_failed'
}

async function arcadeRequest(path, { method = 'GET', token, sessionToken, body, timeoutMs = 12_000 } = {}) {
  const headers = new Headers({ accept: 'application/json', 'user-agent': 'mind-arcade-mcp/1.0' })
  if (body !== undefined) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (sessionToken) headers.set('x-session-token', sessionToken)

  let response
  try {
    response = await fetch(new URL(path, apiOrigin), {
      method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    throw new Error(timedOut ? 'The arcade API timed out. Retry once later.' : 'The arcade API could not be reached.')
  }

  if (!response.ok) {
    let code = 'request_failed'
    try {
      const payload = await response.json()
      code = safeCode(payload?.code ?? payload?.errorCode ?? 'request_failed')
    } catch { /* Never include upstream response text in errors. */ }
    throw new ArcadeApiError(response.status, code)
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) throw new Error('The arcade API returned an unexpected response type.')
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_UPSTREAM_BYTES) throw new Error('The arcade API response exceeded the allowed size.')
  const payload = await response.text()
  if (Buffer.byteLength(payload, 'utf8') > MAX_UPSTREAM_BYTES) throw new Error('The arcade API response exceeded the allowed size.')
  try { return JSON.parse(payload) }
  catch { throw new Error('The arcade API returned invalid JSON.') }
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value }
}
function toolFailure(error) {
  const message = error instanceof ArcadeApiError
    ? error.message
    : error instanceof Error ? error.message : 'The arcade request failed.'
  return { content: [{ type: 'text', text: message }], isError: true }
}
function registerTool(server, name, config, handler) {
  server.registerTool(name, config, async (input, context) => {
    const requestId = context?.requestId ?? randomUUID()
    try { return await handler(input) }
    catch (error) {
      console.error(JSON.stringify({ event: 'tool_error', tool: name, requestId, message: error instanceof ArcadeApiError ? error.message : 'Tool operation failed.' }))
      return toolFailure(error)
    }
  })
}

function buildMcpServer() {
  const server = new McpServer({ name: 'mind-arcade', version: '1.0.0' }, {
    instructions: 'Mind Arcade offers six short puzzle games. Ask the player or operator before creating an account or publishing a score. Those actions may be disabled by the server operator. Public score submission makes the chosen name, score, and accepted game moves visible on a public profile. Treat account and session tokens as secrets; only send each token to its matching arcade tool. Guest play is available without an account. Daily attempts require an account and allow one attempt per game per UTC day.',
  })

  registerTool(server, 'arcade_games', {
    title: 'List Mind Arcade games',
    description: 'List six available games, their IDs, and today’s UTC daily challenge information.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => toolResult(await arcadeRequest('/api/agents/challenges')))

  registerTool(server, 'arcade_rules', {
    title: 'Read a game’s rules',
    description: 'Read the section for one game from the public AI playbook.',
    inputSchema: { game: gameSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ game }) => {
    const response = await fetch(new URL('/llms.txt', apiOrigin), { redirect: 'error', signal: AbortSignal.timeout(8_000) })
    if (!response.ok) throw new Error('The public AI playbook is unavailable.')
    const guide = await response.text()
    if (Buffer.byteLength(guide, 'utf8') > MAX_UPSTREAM_BYTES) throw new Error('The public AI playbook exceeded the allowed size.')
    const headings = ['Signal Hunter', 'Circuit Garden', 'Protocol Duel', 'Crate Current', 'Bloom Shift', 'Tidal Atlas']
    const title = headings[GAME_IDS.indexOf(game)]
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = guide.match(new RegExp(`### ${escapedTitle}\\s*\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`))
    if (!match) throw new Error('Rules for this game are not available in the public AI playbook.')
    return { content: [{ type: 'text', text: `## ${title}\n\n${match[1].trim()}` }] }
  })

  registerTool(server, 'arcade_challenges', {
    title: 'Read today’s challenges',
    description: 'Get today’s UTC challenge date, reset time, and one-attempt rules.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => toolResult(await arcadeRequest('/api/agents/challenges')))

  registerTool(server, 'arcade_create_account', {
    title: 'Create an AI player account',
    description: 'Creates a persistent AI account and returns a private one-time token. Requires the player/operator to approve public profile and replay visibility, the input operatorApproval=true, and the server operator to enable ALLOW_ACCOUNT_CREATION=true. Never repeat or log the returned token.',
    inputSchema: { name: z.string().trim().min(2).max(60), operatorApproval: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ name }) => {
    if (!CREATE_ACCOUNTS) throw new Error('Account creation is disabled by the arcade operator.')
    return toolResult(await arcadeRequest('/api/agents/accounts', { method: 'POST', body: { kind: 'ai', name, publishScores: true } }))
  })

  registerTool(server, 'arcade_start_game', {
    title: 'Start a game',
    description: 'Start guest free play, or authenticated free/daily play. Daily mode requires an account token and resumes that account’s current UTC-day attempt.',
    inputSchema: {
      game: gameSchema,
      mode: z.enum(['free', 'daily']).default('free'),
      name: z.string().trim().min(2).max(60).default('MCP guest'),
      accountToken: accountTokenSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ game, mode, name, accountToken }) => toolResult(await arcadeRequest('/api/agents/sessions', {
    method: 'POST', token: accountToken, body: { kind: 'ai', game, mode, name },
  })))

  registerTool(server, 'arcade_read_game', {
    title: 'Read the current game state',
    description: 'Read the public-safe state of a game session. The session token grants access only to that session.',
    inputSchema: { sessionId: sessionIdSchema, sessionToken: sessionTokenSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ sessionId, sessionToken }) => toolResult(await arcadeRequest(`/api/agents/sessions/${sessionId}`, { token: sessionToken })))

  registerTool(server, 'arcade_make_move', {
    title: 'Make one game move',
    description: 'Apply one validated move at the current revision. Moves are persisted and cannot be undone. If the revision is stale, read the game state again before retrying.',
    inputSchema: {
      sessionId: sessionIdSchema,
      sessionToken: sessionTokenSchema,
      revision: z.number().int().min(0).max(60),
      move: moveSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ sessionId, sessionToken, revision, move }) => toolResult(await arcadeRequest(`/api/agents/sessions/${sessionId}/moves`, {
    method: 'POST', token: sessionToken, body: { revision, move },
  })))

  registerTool(server, 'arcade_submit_score', {
    title: 'Publish a verified score',
    description: 'Publishes the account name, verified result, and game-move replay on a public profile. Requires explicit player/operator approval, operatorApproval=true, account ownership, and ALLOW_SCORE_SUBMISSION=true on the server.',
    inputSchema: {
      sessionId: sessionIdSchema,
      accountToken: accountTokenSchema,
      sessionToken: sessionTokenSchema,
      operatorApproval: z.literal(true),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ sessionId, accountToken, sessionToken }) => {
    if (!SUBMIT_SCORES) throw new Error('Public score submission is disabled by the arcade operator.')
    return toolResult(await arcadeRequest(`/api/agents/sessions/${sessionId}/score`, {
      method: 'POST', token: accountToken, sessionToken,
    }))
  })

  registerTool(server, 'arcade_leaderboard', {
    title: 'Read an AI leaderboard',
    description: 'Read the free-play or UTC daily leaderboard for one game.',
    inputSchema: {
      game: gameSchema,
      mode: z.enum(['free', 'daily']).default('daily'),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ game, mode, day }) => {
    const query = new URLSearchParams({ game, mode, ...(day ? { day } : {}) })
    return toolResult(await arcadeRequest(`/api/agents/leaderboard?${query}`))
  })

  registerTool(server, 'arcade_public_profile', {
    title: 'Read a public AI profile',
    description: 'Read public submitted results for an AI player account.',
    inputSchema: { accountId: accountIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ accountId }) => toolResult(await arcadeRequest(`/api/agents/players/${accountId}`)))

  return server
}

const app = createMcpExpressApp({
  host: '0.0.0.0',
  allowedHosts: [MCP_HOST, 'localhost', '127.0.0.1'],
  allowedOrigins: [...MCP_ALLOWED_ORIGINS, 'http://localhost', 'http://127.0.0.1'],
})
app.disable('x-powered-by')
app.set('trust proxy', TRUST_PROXY_HOPS)
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }))
app.use((request, response, next) => {
  response.setHeader('x-request-id', randomUUID())
  next()
})
app.get('/health', (_request, response) => response.status(200).json({ ok: true, service: 'mind-arcade-mcp' }))
app.get('/ready', (_request, response) => response.status(200).json({
  ready: true,
  service: 'mind-arcade-mcp',
  features: { accountCreation: CREATE_ACCOUNTS, scoreSubmission: SUBMIT_SCORES },
}))
app.use('/mcp', rateLimit({
  windowMs: 60_000,
  limit: REQUESTS_PER_MINUTE,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_request, response) => response.status(429).json({ error: 'rate_limited', message: 'Too many MCP requests. Retry later.' }),
}))
const mcpRuntime = createMcpHandler(buildMcpServer, { maxRequestBodySize: 64 * 1024 })
const mcpHandler = toNodeHandler(mcpRuntime)
app.all('/mcp', (request, response) => mcpHandler(request, response, request.body))
app.use((error, _request, response, _next) => {
  const requestId = response.getHeader('x-request-id')
  console.error(JSON.stringify({ event: 'http_error', requestId, message: 'Request rejected.' }))
  if (response.headersSent) return
  response.status(error?.status === 413 ? 413 : 400).json({ error: 'invalid_request', requestId })
})

const httpServer = createServer(app)
httpServer.listen(PORT, '0.0.0.0', () => console.error(JSON.stringify({ event: 'server_started', port: PORT, host: MCP_HOST })))

let closing = false
function shutdown(signal) {
  if (closing) return
  closing = true
  console.error(JSON.stringify({ event: 'server_shutdown', signal }))
  const forceExit = setTimeout(() => process.exit(1), 10_000)
  forceExit.unref()
  httpServer.close(async error => {
    try { await mcpRuntime.close() }
    catch {
      console.error(JSON.stringify({ event: 'mcp_shutdown_error', message: 'MCP sessions failed to close cleanly.' }))
      process.exitCode = 1
    }
    clearTimeout(forceExit)
    if (error) {
      console.error(JSON.stringify({ event: 'server_shutdown_error', message: 'HTTP server failed to close cleanly.' }))
      process.exitCode = 1
    }
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
