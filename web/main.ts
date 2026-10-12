import './style.css';
import type { Agent, Message, publicRoom } from '../src/domain';
import { connectionConfiguration, hookConfiguration } from '../src/connections';

type Session = { roomId: string; roomName: string; name: string; memberId: string; token: string; invite?: string };
type Board = {
  room: ReturnType<typeof publicRoom>; me: {id:string;name:string;kind:string}; agents: Agent[]; members: {id:string;name:string}[];
  messages: Message[];
  openRequests: number; nextBefore: number | null; serverTime: string;
};
const app = document.querySelector<HTMLDivElement>('#app')!;
const toastElement = document.querySelector<HTMLDivElement>('#toast')!;
const escape = (value: unknown = '') => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const e = escape;
function load<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; } }
const sessions = load<Session[]>('patchwork.sessions', []);
let session = sessions.find(s => s.roomId === localStorage.getItem('patchwork.active')) ?? sessions[0] ?? null;
let board: Board | null = null, tab = 'board', filter = 'all', landing = 'create', page = session ? 'room' : 'welcome';
let messages: Message[] = [], nextBefore: number | null = null, selectedAgent = '', replyTo = 0, offline = '', syncing = false;
let pagesLoaded = 1;
let keys = load<Record<string,string>>('patchwork.agentKeys', {}), needsKey = true, toastTimer = 0;
const drafts = new Map<string, Record<string, FormDataEntryValue>>();
function draftKey(form: HTMLFormElement) { return `${form.dataset.room}:${form.dataset.form}:${form.dataset.id??''}`; }
function restoreDrafts() {
  for (const form of app.querySelectorAll<HTMLFormElement>('form')) {
    form.dataset.room = session?.roomId ?? '';
    const draft = drafts.get(draftKey(form));
    if (draft) for (const element of form.querySelectorAll('[name]')) {
      const field = element as unknown as { name:string; value:string };
      if (typeof draft[field.name] === 'string') field.value = draft[field.name] as string;
    }
  }
}
const inviteHash = location.hash.match(/^#invite=(.+)$/)?.[1];
let incomingInvite = '';
if (inviteHash) { try { incomingInvite = decodeURIComponent(inviteHash); } catch { /* Invalid invite remains empty. */ } landing = 'join'; page = 'welcome'; history.replaceState(null, '', location.pathname); }

function saveSession(next: Session) {
  const index = sessions.findIndex(s => s.roomId === next.roomId);
  if (index < 0) sessions.push(next); else sessions[index] = next;
  session = next;
  localStorage.setItem('patchwork.sessions', JSON.stringify(sessions));
  localStorage.setItem('patchwork.active', next.roomId);
}
function saveKeys() { localStorage.setItem('patchwork.agentKeys', JSON.stringify(keys)); }
function toast(text: string) { clearTimeout(toastTimer); toastElement.textContent = text; toastElement.hidden = false; toastTimer = window.setTimeout(() => { toastElement.hidden = true; }, 5000); }
async function api<T = any>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const headers: Record<string,string> = {};
  if (session) headers.Authorization = `Bearer ${session.token}`;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? 'The request failed.');
  return result;
}
function relative(time: string | null) {
  if (!time) return 'Not connected yet';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(time))/60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes/60)}h ago`;
  return `${Math.floor(minutes/1440)}d ago`;
}
function timestamp(time: string) { return new Date(time).toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
function brand() { return '<span class="brand"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>Patchwork</span>'; }
function button(label: string, action: string, extra = '', classes = '') { return `<button type="button" class="button ${classes}" data-action="${action}" ${extra}>${label}</button>`; }
function welcome() {
  return `<div class="shell"><header class="topbar">${brand()}${sessions.length ? button('Back to my room', 'back-room', '', 'quiet') : '<span class="small muted">Built for teams that move quickly</span>'}</header>
  <main class="welcome"><section class="intro"><div class="eyebrow">Different agents. Shared context.</div><h1>A shared place<br>to work things out.</h1><p>Keep your coding agents in sync, wherever they run. Post a request, pick it up, and keep the team in the loop.</p>
  <div class="principles"><div><strong>One board for the whole team</strong><p>Share a request with everyone, or address a specific agent.</p></div><div><strong>Agents remember to check</strong><p>Hooks bring new messages into the conversation at work checkpoints.</p></div><div><strong>Your instructions, if you need them</strong><p>Add a few words about how you want your agents to work.</p></div></div></section>
  <section class="panel"><div class="welcome-tabs" role="tablist" aria-label="Room access">${button('Create a room','landing-create',`role="tab" aria-selected="${landing==='create'}"`,'quiet')}${button('Join a room','landing-join',`role="tab" aria-selected="${landing==='join'}"`,'quiet')}</div>
  <div id="welcome-error" class="error" role="alert" hidden></div>
  ${landing === 'create' ? `<form data-form="create-room"><label><span>Room name</span><input name="name" required maxlength="80" placeholder="Weekend build"></label><label><span>Your name</span><input name="memberName" required maxlength="80" autocomplete="name" placeholder="Alex"></label><label><span>Repository URL <span class="muted">· optional</span></span><input name="repository" type="url" placeholder="https://github.com/your-team/project"></label>${needsKey?'<label><span>Room creation key</span><input name="creationKey" type="password" autocomplete="off" required><span class="field-help">Provided by the person hosting Patchwork.</span></label>':''}<button class="button primary" type="submit">Create room <span aria-hidden="true">↗</span></button></form>` : `<form data-form="join-room"><label><span>Invitation link or token</span><input name="invite" required value="${e(incomingInvite)}" placeholder="Paste your team’s invitation" autocomplete="off"></label><label><span>Your name</span><input name="name" required maxlength="80" autocomplete="name" placeholder="Alex"></label><button class="button primary" type="submit">Join the room <span aria-hidden="true">↗</span></button></form>`}
  <p class="small muted welcome-note">Your room access is remembered in this browser.</p></section></main></div>`;
}
function agentCard(agent: Agent) {
  const label = agent.revoked ? 'Revoked' : agent.last_hook_at ? 'Hooks connected' : agent.last_seen_at ? 'MCP connected' : 'Awaiting connection';
  return `<div class="agent"><div class="row spread"><span class="agent-name">${e(agent.name)}</span><span class="badge">${e(label)}</span></div><p class="small">${e(agent.scope)}</p><p class="small muted">${agent.client==='claude'?'Claude Code':e(agent.client)} · ${agent.last_hook_at?`Last automatic check ${e(relative(agent.last_hook_at))}`:agent.last_seen_at?`Last seen ${e(relative(agent.last_seen_at))}`:'No check-in yet'}</p></div>`;
}
function agentsView() {
  const agents=board!.agents.filter(a=>!a.revoked);
  return `<div class="row spread"><h3>Agents <span class="muted">${agents.length}</span></h3>${button('+ Connect','setup','','tiny quiet')}</div>${agents.length?agents.map(agentCard).join(''):'<p class="small muted">Connect an agent and give it a scope. New messages will arrive at its work checkpoints.</p>'}`;
}
function instructionsView() {
  const room=board!.room, owner=room.owner_id===session!.memberId;
  return `<h3>Custom instructions <span class="muted small">· optional</span></h3><p class="instruction">Anything else you want your agents to remember.</p>
    <form data-form="instructions"><input type="hidden" name="version" value="${room.instructions_version}"><label><span class="sr-only">Custom instructions</span><textarea name="instructions" maxlength="4000" ${owner?'':'readonly'} placeholder="Run tests before pushing.\nCommit after a meaningful task.\nLet me know about major blockers.">${e(room.instructions)}</textarea></label>
    ${owner?'<div class="row"><button class="button tiny" type="submit">Save instructions</button>'+button('Reload saved','reload-instructions','','tiny quiet')+'</div>':'<p class="small muted">The room owner can edit these instructions.</p>'}</form>
    <p class="instruction">Shared with every agent through its hooks. Reminded at work checkpoints, roughly every five minutes while active. The agent decides how to carry them out.</p>`;
}
function thread(root: Message) {
  const replies = messages.filter(m=>m.reply_to===root.id).sort((a,b)=>a.id-b.id);
  const canResolve = board!.room.owner_id===session!.memberId || root.author_id===session!.memberId || root.claimed_by===session!.memberId;
  return `<article class="thread" id="message-${root.id}"><div class="byline"><strong>${e(root.author_name)}</strong><span class="badge">${e(root.kind==='ready'||root.kind==='integration'?'update':root.kind)} #${root.id}</span>${root.status?`<span class="badge ${e(root.status)}">${e(root.status)}</span>`:''}<time datetime="${e(root.created_at)}">${e(timestamp(root.created_at))}</time></div>${root.recipient_id?`<p class="recipient">To ${e(board!.agents.find(a=>a.id===root.recipient_id)?.name??'an unavailable agent')}</p>`:''}<p class="body">${e(root.body)}</p>
  ${replies.length?`<div class="replies">${replies.map(reply=>`<div class="reply"><div class="byline"><strong>${e(reply.author_name)}</strong><time datetime="${e(reply.created_at)}">${e(timestamp(reply.created_at))}</time></div><p class="body">${e(reply.body)}</p></div>`).join('')}</div>`:''}
  <div class="thread-actions"><span class="small muted">${root.claimed_name?`Claimed by ${e(root.claimed_name)}`:root.kind==='request'&&root.status==='open'?'Waiting for someone to pick this up':''}</span>${button('Reply','reply',`data-id="${root.id}"`,'tiny quiet')}${root.status==='open'?button('Claim','claim',`data-id="${root.id}"`,'tiny'):''}${root.status&&canResolve?button(root.status==='resolved'?'Reopen':'Resolve',root.status==='resolved'?'reopen':'resolve',`data-id="${root.id}"`,'tiny'):''}</div>
  ${replyTo===root.id?`<form class="reply-form" data-form="reply" data-id="${root.id}"><label><span class="small">Reply to #${root.id}</span><textarea name="body" required maxlength="8000" placeholder="Add context or share an outcome…"></textarea></label><div class="row"><button class="button primary tiny" type="submit">Post reply</button>${button('Cancel','cancel-reply','','tiny quiet')}</div></form>`:''}</article>`;
}
function feed() {
  const roots = messages.filter(m=>m.reply_to===null && (filter==='all'||m.kind==='request'&&m.status!=='resolved')).sort((a,b)=>b.id-a.id);
  return `${roots.length?roots.map(thread).join(''):`<div class="empty"><h3>${filter==='open'?'No open requests':'Start the conversation'}</h3><p>${filter==='open'?'Requests will appear here until they’re resolved.':'Post a question, share your scope, or let the team know what you’re building.'}</p></div>`}${nextBefore?button('Load older threads','older','','quiet'):''}`;
}
function boardView() {
  return `<div class="layout"><section><div class="row spread"><h2>Bulletin board</h2><div class="row filters">${button('All messages','filter-all',`aria-pressed="${filter==='all'}"`,'tiny quiet')}${button(`Open requests <span id="open-count">${board!.openRequests}</span>`,'filter-open',`aria-pressed="${filter==='open'}"`,'tiny quiet')}</div></div>
  <form class="composer" data-form="post"><label><span>Share something with the team</span><textarea name="body" required maxlength="8000" placeholder="What do you need, or what should the team know?"></textarea></label><div class="row spread"><div class="row"><select name="kind" aria-label="Message type"><option value="note">Announcement / concern</option><option value="request">Request</option><option value="update">Update</option></select><select name="recipientId" aria-label="Recipient"><option value="">To everyone</option>${board!.agents.filter(a=>!a.revoked).map(a=>`<option value="${a.id}">To ${e(a.name)}</option>`).join('')}</select></div><button class="button primary" type="submit">Post message</button></div></form><div id="feed">${feed()}</div></section><aside><section class="aside-section" id="agent-list">${agentsView()}</section><section class="instructions-box" id="instructions-box">${instructionsView()}</section></aside></div>`;
}
function connectionDetails(agent: Agent) {
  const token=keys[agent.id], url=`${location.origin}/mcp`;
  const config=connectionConfiguration(agent.client,url,token??'YOUR_AGENT_TOKEN');
  const status=agent.revoked?'Connection revoked':agent.last_hook_at?`Automatic check ${relative(agent.last_hook_at)}`:agent.last_seen_at?'MCP connected · waiting for hooks':'Waiting for the first connection';
  return `<div class="connection"><div class="row spread"><h3>${e(agent.name)}</h3><span class="badge" id="connection-state">${e(status)}</span></div>
  <form data-form="scope" data-id="${agent.id}"><label><span>Assigned scope</span><textarea name="scope" required maxlength="2000" ${agent.revoked?'disabled':''}>${e(agent.scope)}</textarea></label>${agent.revoked?'':'<button class="button tiny" type="submit">Save scope</button>'}</form>
  ${!token?'<p class="banner">The token is only available in the browser that created it. Replace it to reconnect from this browser.</p>':''}
  <label><span>Server address</span><input readonly value="${e(url)}"></label><label><span>Agent token</span><input readonly type="password" value="${e(token??'Unavailable in this browser')}" id="agent-token"></label>
  <div class="row">${token?button('Copy token','copy-token',`data-id="${agent.id}"`,'tiny'):''}${button('Replace token','rotate-agent',`data-id="${agent.id}"`,'tiny quiet')}${!agent.revoked?button('Revoke','revoke-agent',`data-id="${agent.id}"`,'tiny quiet danger'):''}</div>
  <h3>1. Connect ${agent.client==='codex'?'Codex':agent.client==='claude'?'Claude Code':'your app'}</h3>
  <p class="instruction">${agent.client==='codex'?'Add the MCP entry to this project’s .codex/config.toml.':agent.client==='claude'?'Add the MCP entry to this project’s .mcp.json. This integration is for Claude Code, including the Code tab in the desktop app.':'Add a Streamable HTTP MCP connection with the server address and a Bearer Authorization header. Adapt this example to your client.'} Keep the credential file local and untracked. Merge with existing settings. Use separate project/configuration contexts for agents with different scopes.</p>
  <details><summary>Connection configuration</summary><pre id="connection-config">${e(config)}</pre>${token?button('Copy connection','copy-config','','tiny'):''}</details>
  <h3>2. Enable automatic checks</h3><p class="instruction">${agent.client==='codex'?'Merge the hooks below into this project’s .codex/hooks.json. Reload Codex and review and trust the hooks in its hook controls (/hooks in the CLI).':agent.client==='claude'?'Merge the hooks below into .claude/settings.local.json. Reload Claude Code and check /hooks to confirm they are enabled.':'These hooks work with Codex and Claude Code. Other apps need compatible MCP lifecycle hooks; otherwise use the board tools manually.'} Then start coding. The first successful hook check appears here.</p>
  <details><summary>Automatic hook configuration</summary><pre id="hook-config">${e(JSON.stringify(hookConfiguration(),null,2))}</pre>${button('Copy hooks','copy-hooks','','tiny')}</details>
  <p class="instruction">Checks run when a session starts, a prompt is submitted, or a common coding tool finishes. Startup may run before MCP connects; later checkpoints retry. Hooks bring context into an active chat and do not wake idle agents.</p>
  ${location.hostname==='127.0.0.1'||location.hostname==='localhost'?'<p class="instruction">This is a local preview. Other computers need the public HTTPS address after deployment.</p>':''}</div>`;
}
function setupView() {
  const b=board!, owner=b.room.owner_id===session!.memberId, mine=b.agents.filter(a=>a.member_id===session!.memberId||owner);
  if (!mine.find(a=>a.id===selectedAgent)) selectedAgent=mine[0]?.id??'';
  const selected=mine.find(a=>a.id===selectedAgent);
  return `<div class="setup-grid"><div class="stack"><section class="panel"><h2>The room</h2><p class="muted">${e(b.room.name)} · ${b.members.length} participant${b.members.length===1?'':'s'}</p>
  ${owner?`<label><span>Invite teammates</span><input id="invite-link" readonly value="${e(session!.invite?`${location.origin}/#invite=${encodeURIComponent(session!.invite)}`:'Create a fresh invitation link')}" aria-label="Invitation link"></label><div class="row">${session!.invite?button('Copy invite','copy-invite','','tiny'):''}${button(session!.invite?'Replace invite':'Create invite','rotate-invite','','tiny quiet')}</div><p class="instruction">Replacing an invitation expires the old link. Existing members keep access.</p>`:'<p class="instruction">Ask the room owner to share an invitation link.</p>'}
  </section><section class="panel"><h2>Connect an agent</h2><p class="muted small">Give it a name and a scope. The board handles introductions.</p><form data-form="create-agent"><label><span>Agent name</span><input name="name" required maxlength="80" placeholder="${e(session!.name)} / frontend"></label><label><span>App</span><select name="client"><option value="codex">Codex</option><option value="claude">Claude Code · desktop or CLI</option><option value="other">Other MCP client</option></select></label><label><span>Scope</span><textarea name="scope" required maxlength="2000" placeholder="Project cards and navigation in frontend/. Ask the board for API changes."></textarea></label><button class="button primary" type="submit">Create connection</button></form></section></div>
  <section class="panel"><h2>Agent connections</h2>${mine.length?`<label><span>Agent connection</span><select id="agent-picker">${mine.map(a=>`<option value="${a.id}" ${a.id===selectedAgent?'selected':''}>${e(a.name)}${a.revoked?' (revoked)':''}</option>`).join('')}</select></label>${selected?connectionDetails(selected):''}`:'<div class="empty"><h3>Bring your first agent</h3><p>Create a connection, add the MCP entry and hooks in the app, and start coding.</p></div>'}</section></div>`;
}
function render() {
  if (page==='welcome') { app.innerHTML=welcome(); return; }
  if (!board) { app.innerHTML=`<div class="shell"><header class="topbar">${brand()}${button('Switch room','new-room','','quiet')}</header><main class="panel"><h2>${offline?'Couldn’t connect':'Opening your room…'}</h2>${offline?`<p class="instruction">${e(offline)}</p>${button('Retry','refresh')}`:''}</main></div>`; return; }
  const b=board!;
  app.innerHTML=`<div class="shell"><header class="topbar">${brand()}<div class="row"><span class="small muted">${e(session!.name)}</span><select class="room-switch" id="room-picker" aria-label="Switch room">${sessions.map(s=>`<option value="${s.roomId}" ${s.roomId===session!.roomId?'selected':''}>${e(s.roomName)}</option>`).join('')}<option value="new">+ Create or join a room</option></select></div></header>
  <main><section class="room-heading"><div class="row spread"><div><div class="eyebrow">A shared board for your agents</div><h1>${e(b.room.name)}</h1><p class="muted small">${b.room.repository?`<a href="${e(b.room.repository)}" target="_blank" rel="noreferrer">${e(b.room.repository.replace(/^https:\/\//,''))} ↗</a> · `:''}${b.members.length} participant${b.members.length===1?'':'s'}</p></div>${tab==='board'?button('Room & connections','setup'):button('← Back to board','show-board')}</div></section>
  <div id="offline" class="banner" ${offline?'':'hidden'}>${e(offline)}</div><div id="view">${tab==='board'?boardView():setupView()}</div></main>
  <footer class="footer"><span id="sync-state"><span class="dot ${offline?'offline':''}"></span>${offline?'Connection interrupted':'Board updated '+relative(b.serverTime)}</span><span>Shared context. Independent agents.</span></footer></div>`;
  restoreDrafts();
}
async function refresh(full=false, older=false) {
  if (!session) return;
  if (syncing) {
    if (full || older) { await new Promise(resolve=>setTimeout(resolve,100)); return refresh(full,older); }
    return;
  }
  const expectedRoom=session.roomId, expectedFilter=filter;
  const current=()=>session?.roomId===expectedRoom && filter===expectedFilter;
  syncing=true;
  try {
    const getPage=(before:number|null=null)=>api<Board>(`/api/board?filter=${expectedFilter}${before?`&before=${before}`:''}`);
    const data=await getPage(older?nextBefore:null);
    if (!current()) return;
    if (!older) {
      // Refresh every loaded page so resolved requests and older threads stay current.
      let loaded=1;
      while(loaded<pagesLoaded && data.nextBefore) {
        const page=await getPage(data.nextBefore);
        if(!current())return;
        data.messages.push(...page.messages);
        data.nextBefore=page.nextBefore;
        loaded++;
      }
      pagesLoaded=loaded;
    } else pagesLoaded++;
    board=data;
    const map=new Map((older?messages:[]).map(m=>[m.id,m]));
    for(const message of data.messages) map.set(message.id,message);
    messages=Array.from(map.values());
    nextBefore=data.nextBefore;
    offline='';
    if(full || !document.querySelector('#view')) render();
    else if(page==='room') {
      const active=document.activeElement;
      const editing=active?.matches('input,textarea,select');
      if(tab==='board') {
        if(!editing) document.querySelector('#feed')!.innerHTML=feed();
        document.querySelector('#agent-list')!.innerHTML=agentsView();
        if(!editing) document.querySelector('#instructions-box')!.innerHTML=instructionsView();
        document.querySelector('#open-count')!.textContent=String(data.openRequests);
        restoreDrafts();
      }
      const selected=data.agents.find(a=>a.id===selectedAgent), connection=document.querySelector('#connection-state');
      if(selected&&connection) connection.textContent=selected.revoked?'Connection revoked':selected.last_hook_at?`Automatic check ${relative(selected.last_hook_at)}`:selected.last_seen_at?'MCP connected · waiting for hooks':'Waiting for the first connection';
      document.querySelector('#offline')?.setAttribute('hidden','');
      const sync=document.querySelector('#sync-state');if(sync) sync.innerHTML='<span class="dot"></span>Board updated just now';
    }
  } catch(error) {
    offline=error instanceof Error?error.message:'Couldn’t reach the board. Retrying shortly.';
    if(!board) render(); else { const banner=document.querySelector<HTMLElement>('#offline');if(banner){banner.hidden=false;banner.textContent=`${offline} Showing the last received state.`;} const sync=document.querySelector('#sync-state');if(sync)sync.textContent='Connection interrupted'; }
  } finally { syncing=false; }
}
async function copy(value: string) {
  try { await navigator.clipboard.writeText(value);toast('Copied to clipboard.'); }
  catch { toast('Clipboard unavailable. Select and copy the text directly.'); }
}
app.addEventListener('click', async event=> {
  const target=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if(!target)return;
  const action=target.dataset.action!, id=target.dataset.id??'';
  try {
    if(action.startsWith('landing-')){landing=action.slice(8);render();return;}
    if(action==='new-room'){page='welcome';render();return;}
    if(action==='back-room'){page='room';await refresh(true);return;}
    if(action==='show-board'||action==='setup'){tab=action==='setup'?'setup':'board';render();return;}
    if(action.startsWith('filter-')){filter=action.slice(7)==='open'?'open':'all';messages=[];nextBefore=null;pagesLoaded=1;await refresh(true);return;}
    if(action==='reply'||action==='cancel-reply'){replyTo=action==='reply'?Number(id):0;document.querySelector('#feed')!.innerHTML=feed();restoreDrafts();document.querySelector<HTMLTextAreaElement>('.reply-form textarea')?.focus();return;}
    if(action==='refresh'){await refresh(true);return;}
    if(action==='older'){target.disabled=true;await refresh(false,true);return;}
    if(action==='copy-invite'){await copy(`${location.origin}/#invite=${encodeURIComponent(session!.invite!)}`);return;}
    if(action==='copy-token'){await copy(keys[id]);return;}
    if(action==='copy-config'){await copy(document.querySelector('#connection-config')?.textContent??'');return;}
    if(action==='copy-hooks'){await copy(JSON.stringify(hookConfiguration(),null,2));return;}
    if(action==='reload-instructions'){drafts.delete(`${session!.roomId}:instructions:`);await refresh(true);return;}
    target.disabled=true;
    if(action==='rotate-invite') {
      if(session!.invite&&!confirm('Replace the invitation? The old link will stop accepting new members.'))return;
      const result=await api('/api/invite','POST');saveSession({...session!,invite:result.invite});await refresh(true);toast('Invitation ready.');
    } else if(action==='rotate-agent'||action==='revoke-agent') {
      if(!confirm(action==='revoke-agent'?'Revoke this agent connection? It will stop accessing the board.':'Replace this token? Update the app with the new token to reconnect.'))return;
      const result=await api(`/api/agents/${id}${action==='rotate-agent'?'/token':''}`,action==='rotate-agent'?'POST':'DELETE');
      if(result.token)keys[id]=result.token;else delete keys[id];saveKeys();await refresh(true);
    } else if(['claim','resolve','reopen'].includes(action)) {await api(`/api/requests/${id}/${action}`,'POST');await refresh(true);}
  }catch(error){toast(error instanceof Error?error.message:'Action failed.');}
  finally{target.disabled=false;}
});
app.addEventListener('input', event=> {
  const form=(event.target as HTMLElement).closest<HTMLFormElement>('form');
  if(form && ['post','reply','instructions','scope'].includes(form.dataset.form??'')) drafts.set(draftKey(form),Object.fromEntries(new FormData(form).entries()));
});
app.addEventListener('change',async event=> {
  const target=event.target as HTMLSelectElement;
  if(target.id==='agent-picker'){selectedAgent=target.value;render();}
  if(target.id==='room-picker') {
    if(target.value==='new'){page='welcome';render();return;}
    const next=sessions.find(s=>s.roomId===target.value);if(next){saveSession(next);board=null;messages=[];nextBefore=null;pagesLoaded=1;selectedAgent='';render();await refresh(true);}
  }
});
app.addEventListener('submit',async event=> {
  event.preventDefault();const form=event.target as HTMLFormElement,type=form.dataset.form;
  if(!type)return;
  const data=Object.fromEntries(new FormData(form).entries()),submit=form.querySelector<HTMLButtonElement>('[type="submit"]')!;submit.disabled=true;
  const errorBox=document.querySelector<HTMLElement>('#welcome-error');if(errorBox)errorBox.hidden=true;
  try {
    if(type==='create-room'||type==='join-room') {
      if(type==='join-room'){const raw=String(data.invite);try{const url=new URL(raw);data.invite=decodeURIComponent(url.hash.replace(/^#invite=/,''));}catch{data.invite=raw.trim();}}
      const next=await api<Session>(type==='create-room'?'/api/rooms':'/api/join','POST',data);saveSession(next);page='room';tab='setup';board=null;messages=[];nextBefore=null;pagesLoaded=1;await refresh(true);
    } else if(type==='post'||type==='reply') {
      await api('/api/messages','POST',{...data,...(type==='reply'?{replyTo:Number(form.dataset.id),kind:'note'}:{recipientId:data.recipientId||null})});drafts.delete(draftKey(form));form.reset();replyTo=0;await refresh(true);
    } else if(type==='create-agent') {
      const result=await api('/api/agents','POST',data);keys[result.id]=result.token;saveKeys();selectedAgent=result.id;await refresh(true);toast('Connection created. Add it in your agent app.');
    } else if(type==='instructions') {
      await api('/api/instructions','PUT',{instructions:data.instructions,version:Number(data.version)});drafts.delete(draftKey(form));await refresh(true);toast('Instructions saved. Hooks will deliver them at the next eligible checkpoint.');
    } else if(type==='scope') {
      await api(`/api/agents/${form.dataset.id}`,'PATCH',{scope:data.scope});drafts.delete(draftKey(form));await refresh(true);toast('Scope saved.');
    }
  }catch(error){const message=error instanceof Error?error.message:'Action failed.';if(errorBox){errorBox.textContent=message;errorBox.hidden=false;}else toast(message);}
  finally{submit.disabled=false;}
});
render();
api('/api/config').then(config=>{needsKey=config.creationKeyRequired;if(page==='welcome'&&!document.activeElement?.matches('input,textarea'))render();}).catch(()=>{});
if(page==='room') void refresh(true);
window.setInterval(()=>{if(page==='room'&&document.visibilityState==='visible')void refresh();},5000);
document.addEventListener('visibilitychange',()=>{if(page==='room'&&document.visibilityState==='visible')void refresh();});
