import { parse, stringify } from 'smol-toml';
import { isDeepStrictEqual } from 'node:util';
import { connectionConfiguration, hookConfiguration } from './connections.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const patchworkHook = h => h?.type === 'mcp_tool' && h.server === 'patchwork' && h.tool === 'check_board';

export function parseConfig(text) {
  try { return parse(text, { integersAsBigInt: true }); }
  catch { throw new Error('Cannot parse .codex/config.toml. Fix it before connecting; no settings were replaced.'); }
}

export function mergeConfig(text, server, token, replace = false) {
  const config = parseConfig(text), generated = parseConfig(connectionConfiguration('codex', `${server}/mcp`, token));
  if (config.mcp_servers !== undefined && !object(config.mcp_servers)) throw new Error('Invalid mcp_servers configuration.');
  const existing = config.mcp_servers?.patchwork, desired = generated.mcp_servers.patchwork;
  if (existing !== undefined && !object(existing)) throw new Error('Invalid Patchwork MCP configuration.');
  if (existing && !replace) {
    if (existing.url !== desired.url || existing.http_headers?.Authorization !== desired.http_headers.Authorization) {
      throw new Error('A different Patchwork connection exists. Use --re-pair to replace only that connection.');
    }
    return text;
  }
  // Append when possible: preserve comments, whitespace, and all unrelated settings verbatim.
  if (!existing) {
    const appended = `${text}${text.endsWith('\n') || !text ? '' : '\n'}\n${connectionConfiguration('codex', `${server}/mcp`, token)}\n`;
    try { parseConfig(appended); return appended; } catch { /* Inline TOML tables may require reserialization. */ }
  }
  config.mcp_servers ??= Object.create(null);
  // Retain this server's unrelated options, but remove incompatible transport/auth settings.
  const next = Object.assign(Object.create(null), existing, desired);
  for (const key of ['command', 'args', 'env', 'env_vars', 'cwd', 'bearer_token_env_var', 'env_http_headers', 'http_headers_helper', 'auth']) delete next[key];
  next.http_headers = Object.assign(Object.create(null), existing?.http_headers, desired.http_headers);
  for (const key of Object.keys(next.http_headers)) if (key.toLowerCase() === 'authorization' && key !== 'Authorization') delete next.http_headers[key];
  config.mcp_servers.patchwork = next;
  const output = stringify(config, { numbersAsFloat: true });
  if (!isDeepStrictEqual(parseConfig(output), config)) throw new Error('Cannot safely round-trip this TOML configuration. No settings were replaced.');
  return output;
}

export function mergeHooks(text, inlineHooks = {}) {
  let document;
  try { document = text.trim() ? JSON.parse(text) : {}; }
  catch { throw new Error('Cannot parse .codex/hooks.json. Fix it before connecting.'); }
  if (!object(document) || (document.hooks !== undefined && !object(document.hooks))) throw new Error('Invalid hooks.json structure.');
  document.hooks ??= {};
  for (const [event, additions] of Object.entries(hookConfiguration().hooks)) {
    const groups = document.hooks[event] ?? [];
    if (!Array.isArray(groups) || groups.some(g => !object(g) || !Array.isArray(g.hooks))) throw new Error(`Invalid ${event} hooks.`);
    const inline = inlineHooks[event] ?? [];
    if (!Array.isArray(inline)) throw new Error(`Invalid inline ${event} hooks.`);
    // Inline hooks are a separate source. Avoid silently duplicating existing board checks.
    if (inline.some(g => g.hooks?.some(patchworkHook))) throw new Error('Patchwork hooks already exist inline in config.toml. Move those entries to hooks.json before using the installer.');
    const remaining = groups.flatMap(group => {
      const hooks = group.hooks.filter(h => !patchworkHook(h));
      return hooks.length || !group.hooks.length ? [{ ...group, hooks }] : [];
    });
    document.hooks[event] = [...remaining, ...additions];
  }
  const output = JSON.stringify(document, null, 2) + '\n';
  return text.trim() && isDeepStrictEqual(JSON.parse(text), document) ? text : output;
}
