import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const registry = JSON.parse(await readFile(new URL('../server.json', import.meta.url), 'utf8'))

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  throw new Error(`Invalid package version: ${packageJson.version}`)
}
if (packageJson.private !== true) {
  throw new Error('The hosted MCP server must not be accidentally published as an npm package.')
}
if (registry.version !== packageJson.version) {
  throw new Error(`server.json version ${registry.version} does not match package.json ${packageJson.version}.`)
}
if (!registry.name || !Array.isArray(registry.remotes) || registry.remotes.length === 0) {
  throw new Error('server.json must include a server name and at least one remote transport.')
}
if (registry.remotes.some(remote => remote.type !== 'streamable-http' || !remote.url?.startsWith('https://'))) {
  throw new Error('Every registry remote must use HTTPS Streamable HTTP transport.')
}
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${packageJson.version}`) {
  throw new Error(`Release tag ${process.env.RELEASE_TAG} must match v${packageJson.version}.`)
}

console.log(`Release metadata is consistent for v${packageJson.version}.`)
