import { execFileSync } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mergeConfig, mergeHooks, parseConfig } from './config.js';

export function serverURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Use the HTTPS address of your Patchwork website.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTPS server origin without credentials, path, query, or fragment. HTTP is allowed only on localhost.');
  }
  return url.origin;
}

async function request(server, endpoint, body, token) {
  let response;
  try {
    response = await fetch(`${server}${endpoint}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch { throw new Error('Could not reach Patchwork securely. Check the server address and network, then retry.'); }
  if (!response.ok) {
    await response.body?.cancel();
    if (endpoint.includes('redeem') && response.status === 400) throw new Error('Pairing code is invalid, expired, or already used. Get a new code in Room settings.');
    if (response.status === 401) throw new Error('Connection token was revoked or replaced. Get a new code and run with --re-pair.');
    throw new Error(`Patchwork returned HTTP ${response.status}. Retry or ask the room host.`);
  }
  // Never print remote response bodies (including errors) or credentials.
  const reader = response.body?.getReader();
  let size = 0, text = '';
  const decoder = new TextDecoder();
  const streaming = response.headers.get('Content-Type')?.includes('text/event-stream');
  if (!reader) throw new Error('Patchwork returned an empty response.');
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 256_000) { await reader.cancel(); throw new Error('Patchwork returned an oversized response.'); }
    text += decoder.decode(part.value, { stream: true });
    if (streaming) {
      let boundary;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(text))) {
        const event = text.slice(0, boundary.index); text = text.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let message;
        try { message = JSON.parse(data); } catch { await reader.cancel(); throw new Error('Patchwork returned an invalid MCP event.'); }
        if (message.id === body.id) { await reader.cancel(); return message; }
      }
    }
  }
  try { return JSON.parse(text + decoder.decode()); }
  catch { throw new Error('Patchwork returned an invalid response.'); }
}

export async function verifyConnection(server, token) {
  const initialized = await request(server, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'patchwork-cli', version: '0.1.0' },
  } }, token);
  if (initialized.error || initialized.result?.serverInfo?.name !== 'patchwork') throw new Error('This endpoint is not a compatible Patchwork MCP server.');
  const tools = await request(server, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, token);
  if (!['check_board', 'read_messages', 'post_message'].every(name => tools.result?.tools?.some(t => t.name === name))) throw new Error('The server is missing required Patchwork tools.');
}

async function safeFile(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Refusing a linked or non-regular configuration file.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function read(file) {
  await safeFile(file);
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function write(file, value) {
  await safeFile(file);
  const temp = path.join(path.dirname(file), `.patchwork-${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8'); await handle.sync(); await handle.close();
    await rename(temp, file);
  } finally { await handle.close(); await unlink(temp).catch(() => {}); }
}
function git(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('Run this command inside your project’s Git worktree, with Git installed.'); }
}

export async function connect({ server, cwd = process.cwd(), rePair = false, pairingCode, log = console.log }) {
  server = serverURL(server);
  const root = await realpath(git(cwd, ['rev-parse', '--show-toplevel']));
  const directory = path.join(root, '.codex');
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing a linked or non-directory .codex path.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(directory, { mode: 0o700 }); }
  const lockFile = path.join(directory, '.patchwork-install.lock');
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch { throw new Error('Another installer may be running. If it has stopped, remove .codex/.patchwork-install.lock and retry.'); }
  try {
    const configFile = path.join(directory, 'config.toml'), hooksFile = path.join(directory, 'hooks.json'), stateFile = path.join(directory, 'patchwork.json');
    if (git(root, ['ls-files', '--', '.codex/config.toml', '.codex/patchwork.json'])) throw new Error('Credential files are tracked by Git. Untrack .codex/config.toml and .codex/patchwork.json before connecting; the installer will not write secrets to tracked files.');
    const [config, hooks, stateText] = await Promise.all([read(configFile), read(hooksFile), read(stateFile)]);
    const parsed = parseConfig(config), existing = parsed.mcp_servers?.patchwork;
    const nextHooks = mergeHooks(hooks, parsed.hooks);
    let state;
    try { state = stateText ? JSON.parse(stateText) : null; }
    catch { throw new Error('Invalid local Patchwork connection file. Restore it or remove it and use --re-pair.'); }
    if (!rePair && state && (state.server !== server || !/^pw_a_[a-f0-9]{64}$/.test(state.token))) throw new Error('A different or invalid local connection exists. Use --re-pair with a new code.');
    if (!state && !rePair && existing?.url === `${server}/mcp` && /^Bearer pw_a_[a-f0-9]{64}$/.test(existing.http_headers?.Authorization)) {
      state = { server, token: existing.http_headers.Authorization.slice(7) };
    }
    // Validate every merge before consuming a code. An explicit re-pair only replaces Patchwork.
    const configDigest = createHash('sha256').update(config).digest('hex');
    const repair = state?.configDigest === configDigest;
    mergeConfig(config, server, state?.token ?? 'PAIRING_PREFLIGHT', rePair || repair);
    const ignoreFile = path.join(directory, '.gitignore'), ignore = await read(ignoreFile);
    const patterns = ['/config.toml', '/patchwork.json', '/.patchwork-*'];
    const additions = patterns.filter(pattern => !ignore.split(/\r?\n/).includes(pattern));
    if (additions.length) await write(ignoreFile, `${ignore}${ignore.endsWith('\n') || !ignore ? '' : '\n'}${additions.join('\n')}\n`);
    // Ignore rules do not protect files already tracked; check both before writing secrets.
    if (git(root, ['ls-files', '--', '.codex/config.toml', '.codex/patchwork.json'])) throw new Error('Credential files became tracked. Stop tracking them before retrying.');
    for (const file of ['.codex/config.toml', '.codex/patchwork.json']) git(root, ['check-ignore', '--', file]);
    log('Configuring Codex in this project’s .codex folder.');
    if (!state || rePair) {
      const code = await pairingCode();
      const paired = await request(server, '/api/pairing/redeem', { code });
      if (!/^pw_a_[a-f0-9]{64}$/.test(paired.token) || typeof paired.id !== 'string' || typeof paired.roomId !== 'string') throw new Error('Patchwork returned invalid pairing credentials. Get a new code and retry.');
      state = { server, token: paired.token, id: paired.id, roomId: paired.roomId, configDigest };
      // Save first: a network or config-write failure can be repaired without another identity.
      if (git(root, ['ls-files', '--', '.codex/config.toml', '.codex/patchwork.json'])) throw new Error('Credential files became tracked. Untrack them before reconnecting with a new code.');
      await write(stateFile, JSON.stringify(state, null, 2) + '\n');
    }
    await verifyConnection(server, state.token);
    if (await read(configFile) !== config || await read(hooksFile) !== hooks) throw new Error('Codex settings changed during installation. Rerun to merge the latest files. Your connection is saved.');
    if (git(root, ['ls-files', '--', '.codex/config.toml', '.codex/patchwork.json'])) throw new Error('Credential files became tracked. Untrack them and retry.');
    const nextConfig = mergeConfig(config, server, state.token, rePair || repair);
    if (nextConfig !== config) await write(configFile, nextConfig);
    if (nextHooks !== hooks) await write(hooksFile, nextHooks);
    log('Connected. MCP authentication and board tools verified.');
    log('Restart Codex or open a new chat in this project. Trust the project and review the Patchwork hooks in Codex’s hook controls (/hooks in the CLI).');
    log('Board checked in Room settings confirms the first successful hook. Disabled hooks or managed policies may require your attention.');
    return { id: state.id };
  } finally { await lock.close(); await unlink(lockFile); }
}
