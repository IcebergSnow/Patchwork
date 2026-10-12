import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import {
  HttpError, authenticate, createAgent, createRoom, createRoomSchema, hash, joinRoom, now, parse,
  postMessage, postSchema, readMessages, requestAction, acknowledgeRequest, acknowledgmentSchema,
  rotateAgent, rotateInvite, saveInstructions, snapshot, type Actor,
} from './domain';
import { checkBoard, hookSchema } from './hooks';
import { AGENT_INSTRUCTIONS } from './agent-instructions';

export interface Env { DB: D1Database; ASSETS: Fetcher; ROOM_CREATION_KEY?: string }
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const isLocal = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

async function limitedText(request: Request): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new HttpError(413, 'Keep requests under 64 KB.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.includes('application/json')) throw new HttpError(415, 'Send JSON with Content-Type: application/json.');
  const text = await limitedText(request);
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
function integer(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 0 || n > max) throw new HttpError(400, 'Invalid cursor or limit.');
  return n;
}

function createBoardServer(env: Env, actor: Actor) {
  const server = new McpServer({ name: 'patchwork', version: '0.5.0' }, {
    instructions: `${AGENT_INSTRUCTIONS}\nConfigured lifecycle hooks deliver board updates, reminders about unanswered requests, and optional custom instructions. Keep nextCursor when reading manually. This server does not run Git, schedule tasks, or wake idle chats.`,
  });
  const result = async (work: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await work()) }] }; }
    catch (error) {
      if (!(error instanceof HttpError)) console.error('MCP tool failed', error);
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof HttpError ? error.message : 'The board could not complete that action. Retry shortly.' }] };
    }
  };
  server.registerTool('read_messages', {
    description: 'Read room messages using a cursor. Includes agent identities, optional instructions, and open requests with per-agent acknowledgments (null means not responded) and a needsHumanIntervention flag. Use open_only for unresolved requests, including older ones. Every message is shared with the whole room.',
    inputSchema: { after_id: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(100), open_only: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  }, async ({ after_id, limit, open_only }) => result(async () => {
    const [feed, state] = await Promise.all([readMessages(env.DB, actor, after_id, limit, { openOnly: open_only }), snapshot(env.DB, actor, 0, 'open')]);
    return { ...feed, room: state.room, agents: state.agents, openRequests: state.messages.filter(m => m.kind === 'request'),
      moreOpenRequests: state.nextBefore !== null, yourAgentId: actor.id };
  }));
  server.registerTool('post_message', {
    description: 'Post a message or request. Messages include announcements, concerns, and updates. Use replyTo for a thread reply. All messages reach the whole room; address others naturally in the body.',
    inputSchema: postSchema,
    annotations: { destructiveHint: false, openWorldHint: false },
  }, async input => result(() => postMessage(env.DB, actor, input)));
  server.registerTool('acknowledge_request', {
    description: 'Evaluate an open request as Can handle, Cannot handle, or Need clarification. Records only your own response; call again to change it. Broadcasts a threaded reply when changed. Does not assign work or resolve the request. All active agents explicitly declining flags Needs Human Intervention.',
    inputSchema: acknowledgmentSchema,
    annotations: { destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async input => result(() => acknowledgeRequest(env.DB, actor, input)));
  server.registerTool('resolve_request', {
    description: 'Explicitly resolve any request in your room, or set reopen to reopen it. Replies do not change request status.',
    inputSchema: { request_id: z.number().int().positive(), reopen: z.boolean().default(false) }, annotations: { destructiveHint: false, openWorldHint: false },
  }, async ({ request_id, reopen }) => result(() => requestAction(env.DB, actor, request_id, reopen ? 'reopen' : 'resolve')));
  server.registerTool('check_board', {
    description: 'Lifecycle hook adapter: returns event-specific additionalContext with new messages from the whole room and optional custom instructions. Maintains a per-session cursor and throttles tool checkpoints. Does not block work or execute instructions.',
    inputSchema: hookSchema, annotations: { destructiveHint: false, openWorldHint: false },
  }, async input => result(() => checkBoard(env.DB, actor, input)));
  return server;
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/health') { await env.DB.prepare('SELECT 1').first(); return json({ status: 'ok' }); }
  if (!path.startsWith('/api/') && path !== '/mcp') return env.ASSETS.fetch(request);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'This origin is not allowed.');
  if (path === '/mcp') {
    const actor = await authenticate(env.DB, request.headers.get('Authorization'), 'agent');
    await env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').bind(now(), actor.id).run();
    const data = request.method === 'POST' ? await limitedText(request) : undefined;
    const bounded = data === undefined ? request : new Request(request.url, { method: request.method, headers: request.headers, body: data });
    return createMcpHandler(() => createBoardServer(env, actor), {
      route: '/mcp', responseMode: 'json', corsOptions: false,
      allowedHostnames: [url.hostname], allowedOriginHostnames: [url.hostname],
    })(bounded, env, ctx);
  }
  if (request.method === 'GET' && path === '/api/config') return json({ creationKeyRequired: !!env.ROOM_CREATION_KEY || !isLocal(url) });
  if (request.method === 'POST' && path === '/api/rooms') {
    const data = parse(createRoomSchema, await body(request));
    if (!env.ROOM_CREATION_KEY && !isLocal(url)) throw new HttpError(503, 'The host must configure ROOM_CREATION_KEY before creating rooms.');
    if (env.ROOM_CREATION_KEY && await hash(data.creationKey ?? '') !== await hash(env.ROOM_CREATION_KEY)) throw new HttpError(403, 'The room creation key is incorrect.');
    return json(await createRoom(env.DB, data), 201);
  }
  if (request.method === 'POST' && path === '/api/join') return json(await joinRoom(env.DB, await body(request)), 201);
  const actor = await authenticate(env.DB, request.headers.get('Authorization'), 'member');
  if (request.method === 'GET' && path === '/api/board') return json(await snapshot(env.DB, actor, integer(url.searchParams.get('before'), 0), parse(z.enum(['all', 'open', 'intervention']), url.searchParams.get('filter') ?? 'all')));
  if (request.method === 'POST' && path === '/api/invite') return json(await rotateInvite(env.DB, actor));
  if (request.method === 'POST' && path === '/api/agents') return json(await createAgent(env.DB, actor, await body(request)), 201);
  const agentRoute = path.match(/^\/api\/agents\/([a-f0-9-]+)(\/token)?$/);
  if (agentRoute && ((request.method === 'POST' && agentRoute[2]) || request.method === 'DELETE')) return json(await rotateAgent(env.DB, actor, agentRoute[1], request.method === 'DELETE'));
  if (request.method === 'PUT' && path === '/api/instructions') return json(await saveInstructions(env.DB, actor, await body(request)));
  if (request.method === 'POST' && path === '/api/messages') return json(await postMessage(env.DB, actor, await body(request)), 201);
  const actionRoute = path.match(/^\/api\/requests\/(\d+)\/(resolve|reopen)$/);
  if (request.method === 'POST' && actionRoute) return json(await requestAction(env.DB, actor, integer(actionRoute[1], 0), actionRoute[2] as 'resolve' | 'reopen'));
  throw new HttpError(404, 'Endpoint not found.');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    let response: Response;
    try { response = await route(request, env, ctx); }
    catch (error) {
      if (!(error instanceof HttpError)) console.error('Request failed', error);
      response = json({ error: error instanceof HttpError ? error.message : 'Something went wrong. Please retry.' }, error instanceof HttpError ? error.status : 500);
    }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (new URL(request.url).pathname.startsWith('/api/') || new URL(request.url).pathname === '/mcp') headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
