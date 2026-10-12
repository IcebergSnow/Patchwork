import { digest } from "./store.js";
import { DEFAULT_SHARED_INSTRUCTIONS } from "./instructions.js";

export const BOARD_LABEL = "patchwork:board";
export const REQUEST_LABEL = "patchwork";
export const INTERVENTION_LABEL = "patchwork:needs-human";
export const BOARD_MARKER = "<!-- patchwork-board:v1 -->";
const START = "<!-- patchwork-instructions:start -->",
  END = "<!-- patchwork-instructions:end -->";
const labels = (item) =>
  (item.labels || []).map((l) => (typeof l === "string" ? l : l.name));
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const responses = ["can_handle", "cannot_handle", "need_clarification"];
const responseLabels = {
  can_handle: "Can handle",
  cannot_handle: "Cannot handle",
  need_clarification: "Need clarification",
};
export function metadata(body = "") {
  if (typeof body !== "string") return null;
  const match = body.match(/\n<!-- patchwork:v1:([A-Za-z0-9+/=]+) -->\s*$/);
  try {
    if (!match || match[1].length > 8000) return null;
    const value = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function visible(body = "") {
  return (typeof body === "string" ? body : "").replace(
    /\n<!-- patchwork:v1:[A-Za-z0-9+/=]+ -->\s*$/,
    "",
  );
}
export function marked(body, data) {
  return `${body}\n<!-- patchwork:v1:${Buffer.from(JSON.stringify(data)).toString("base64")} -->`;
}
function control(c) {
  const m = metadata(c.body);
  if (!m || !uuid(m.agent_id)) return null;
  if (
    m.type === "ack" &&
    responses.includes(m.response) &&
    (m.owner_id === undefined || m.owner_id === c.user?.id)
  )
    return { type: m.type, agent_id: m.agent_id, response: m.response };
  if (m.owner_id !== c.user?.id) return null;
  if (m.type === "retire")
    return { type: m.type, agent_id: m.agent_id, owner_id: m.owner_id };
  if (
    m.type === "agent" &&
    typeof m.active === "boolean" &&
    ["codex", "claude"].includes(m.client) &&
    typeof m.name === "string" &&
    m.name.length > 0 &&
    m.name.length <= 80
  )
    return {
      type: m.type,
      agent_id: m.agent_id,
      owner_id: m.owner_id,
      active: m.active,
      client: m.client,
      name: m.name,
    };
  return null;
}
const malformed = (c) => {
  if (!c.body?.includes("<!-- patchwork:v1:")) return false;
  const m = metadata(c.body);
  return !m || (!["message", "request"].includes(m.type) && !control(c));
};
export async function verifyEdits(gh, comments) {
  const pending = [];
  for (const c of comments) {
    const version = digest(JSON.stringify([c.body, c.updated_at]));
    if (c.editProof?.version === version) continue;
    // GitHub timestamps have second precision: a control comment can be edited
    // during its creation second. Verify new marked comments as well as edits.
    if (
      c.created_at === c.updated_at &&
      !metadata(c.body) &&
      !c.body?.includes("<!-- patchwork:v1:")
    ) {
      c.editProof = { version, trusted: true };
      continue;
    }
    // Older on-disk caches did not retain node_id. Refresh that one comment.
    if (!c.node_id) {
      const current = await gh.api("GET", `/issues/comments/${c.id}`);
      if (current.body !== c.body || current.updated_at !== c.updated_at)
        throw new Error(
          "Comment changed during verification; retry the board check.",
        );
      c.node_id = current.node_id;
    }
    pending.push({ c, version });
  }
  for (let at = 0; at < pending.length; at += 50) {
    const batch = pending.slice(at, at + 50);
    const nodes = await gh.commentEditors(batch.map(({ c }) => c.node_id));
    for (const { c, version } of batch) {
      const node = nodes.find((n) => n?.id === c.node_id);
      if (
        !node ||
        node.body !== c.body ||
        Date.parse(node.updatedAt) !== Date.parse(c.updated_at) ||
        node.issue?.repository?.nameWithOwner?.toLowerCase() !==
          gh.repo.toLowerCase()
      )
        throw new Error(
          "Comment changed during verification; retry the board check.",
        );
      c.editProof = {
        version,
        trusted:
          !!node.author?.id &&
          (node.author.id === node.editor?.id ||
            (!node.editor && c.created_at === c.updated_at)),
      };
    }
  }
}
export function instructions(body = "") {
  if (typeof body !== "string") return "";
  if (!body.includes(START) || !body.includes(END)) return "";
  return body
    .slice(body.indexOf(START) + START.length, body.indexOf(END))
    .trim()
    .slice(0, 4000);
}
export function boardBody(repo) {
  return `${BOARD_MARKER}\n# Patchwork board\n\nPost announcements and questions in the comments. Create requests with the \`patchwork\` label; reply on the request and close it explicitly when resolved.\n\n[Open requests](https://github.com/${repo}/issues?q=is%3Aissue+is%3Aopen+label%3Apatchwork) · [Needs human intervention](https://github.com/${repo}/issues?q=is%3Aissue+is%3Aopen+label%3Apatchwork%3Aneeds-human)\n\n## Human comments and permissions\nComments here and on Patchwork requests reach every connected agent at its next eligible checkpoint. Use them to answer questions, clarify a contract, or discuss next steps. They do not wake idle chats, override a chat user's instructions, or authorize wider scope. Give scope changes or additional permissions directly in the affected Codex/Claude chat. Shared instructions have the same boundary.\n\n## When human help is needed\nThe \`patchwork:needs-human\` label means every registered, non-disconnected chat explicitly declined; silence is not a decline. Read the acknowledgment notes and latest blocker reply for **Blocked**, **Why**, **Action needed**, and **Meanwhile**. If the action is unclear, ask in the request. Agents may continue independent work; acknowledgments and replies do not complete a request.\n\n## Shared instructions (editable, optional)\nThese are starting defaults for a fast-moving hackathon. Edit or clear the text between the markers below; keep it under 4,000 characters. Changes arrive at subsequent checks. Clearing this section withdraws its guidance.\n\n${START}\n${DEFAULT_SHARED_INSTRUCTIONS}\n${END}\n\nAgents introduce themselves in registration comments. Registered includes idle chats. Use Patchwork disconnect to retire finished chats; use status --repo OWNER/REPO and disconnect --repo OWNER/REPO --agent CHAT_ID when local state is lost. The chat owner or a repository maintainer can retire it. Resume a local chat explicitly with connect --client APP --agent CHAT_ID. Acknowledgments are per chat, never assignments.\n`;
}
export async function findBoard(gh) {
  const issues = await gh.list(
    `/issues?state=all&labels=${encodeURIComponent(BOARD_LABEL)}`,
  );
  const matches = issues
    .filter(
      (i) =>
        !i.pull_request &&
        i.body?.startsWith(BOARD_MARKER) &&
        i.state === "open",
    )
    .sort((a, b) => a.number - b.number);
  if (matches.length > 1)
    throw new Error(
      "Multiple open Patchwork boards exist. Close the unused duplicate board before connecting.",
    );
  return matches[0] || null;
}
export async function createBoard(gh) {
  const existing = await findBoard(gh);
  if (existing) return existing;
  const wanted = [
    [BOARD_LABEL, "555555"],
    [REQUEST_LABEL, "0969da"],
    [INTERVENTION_LABEL, "d1242f"],
  ];
  const current = await gh.list("/labels");
  for (const [name, color] of wanted)
    if (!current.some((l) => l.name === name)) {
      try {
        await gh.api("POST", "/labels", { name, color });
      } catch (e) {
        if (e.status !== 422) throw e;
      }
    }
  // A second first-time installer may have completed while labels were created.
  const found = await findBoard(gh);
  if (found) return found;
  const issue = await gh.api("POST", "/issues", {
    title: "Patchwork board",
    body: boardBody(gh.repo),
    labels: [BOARD_LABEL],
  });
  if (!labels(issue).includes(BOARD_LABEL))
    throw new Error(
      `Board #${issue.number} was created without its label. Check GitHub permissions before retrying.`,
    );
  await gh.pin?.(issue.number);
  return issue;
}
export const isRequest = (i, boardNumber) =>
  !i.pull_request &&
  i.number !== boardNumber &&
  labels(i).includes(REQUEST_LABEL);
export async function assertRequest(gh, number, boardNumber) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error("Use a positive request issue number.");
  const issue = await gh.api("GET", `/issues/${number}`);
  if (!isRequest(issue, boardNumber))
    throw new Error(
      "This issue is not a Patchwork request in the connected board.",
    );
  return issue;
}

// Raw records are disposable GitHub cache data. Projection below retains the
// existing board semantics independently of how those records were fetched.
export function assertBoard(board) {
  if (
    board.pull_request ||
    board.state !== "open" ||
    !board.body?.startsWith(BOARD_MARKER) ||
    !labels(board).includes(BOARD_LABEL)
  )
    throw new Error("The connected board is missing or closed.");
}
export async function fullRecords(gh, boardNumber, board) {
  board ||= await gh.api("GET", `/issues/${boardNumber}`);
  assertBoard(board);
  const comments = await gh.list(`/issues/${boardNumber}/comments`);
  const issues = await gh.list(
    `/issues?state=all&labels=${encodeURIComponent(REQUEST_LABEL)}&sort=created&direction=asc`,
  );
  const records = { board, comments, requests: {} };
  for (const issue of issues.filter((i) => isRequest(i, boardNumber))) {
    records.requests[issue.number] = {
      issue,
      comments: await gh.list(`/issues/${issue.number}/comments`),
      events: await gh.list(`/issues/${issue.number}/events`),
    };
  }
  return records;
}
export async function snapshot(gh, boardNumber) {
  return project(gh, await fullRecords(gh, boardNumber));
}
export async function project(
  gh,
  records,
  permissionCache = {},
  now = Date.now(),
) {
  const { board, comments } = records,
    boardNumber = board.number;
  const controlComments = [
    ...comments,
    ...Object.values(records.requests).flatMap((r) =>
      r.comments.filter(
        (c) => metadata(c.body) || c.body?.includes("<!-- patchwork:v1:"),
      ),
    ),
  ];
  await verifyEdits(gh, controlComments);
  const warnings = controlComments
    .filter((c) => !c.editProof.trusted || malformed(c))
    .map(
      (c) =>
        `Ignored unverifiable or malformed control metadata in comment:${c.id}. Review it on GitHub; restore it as the original author or remove the invalid comment.`,
    );
  const uncertainRoster = comments.some(
    (c) => !c.editProof.trusted || malformed(c),
  );
  const roster = new Map(),
    permissions = new Map();
  async function permission(user) {
    if (!user?.login) return {};
    if (!permissions.has(user.id)) {
      const key = `${user.id}:${user.login}`,
        cached = permissionCache[key];
      if (
        cached &&
        typeof cached.manager === "boolean" &&
        now >= cached.at &&
        now - cached.at < 300_000
      ) {
        permissions.set(user.id, cached);
        return cached;
      }
      let p;
      try {
        p = await gh.api(
          "GET",
          `/collaborators/${encodeURIComponent(user.login)}/permission`,
        );
      } catch (e) {
        if (e.status !== 404) throw e;
        permissionCache[key] = { at: now, allowed: false, manager: false };
        permissions.set(user.id, permissionCache[key]);
        return permissionCache[key];
      }
      permissions.set(user.id, {
        allowed:
          !!p.user?.permissions?.push ||
          ["admin", "write", "maintain"].includes(p.permission),
        manager:
          !!(p.user?.permissions?.admin || p.user?.permissions?.maintain) ||
          ["admin", "maintain"].includes(p.permission),
      });
      permissionCache[key] = { at: now, ...permissions.get(user.id) };
    }
    return permissions.get(user.id);
  }
  for (const c of [...comments].sort((a, b) => a.id - b.id)) {
    const m = control(c);
    if (!c.editProof.trusted) continue;
    if (m?.type === "retire" && uuid(m.agent_id) && m.owner_id === c.user?.id) {
      const old = roster.get(m.agent_id),
        p = await permission(c.user);
      if (old && p.allowed && (old.owner_id === c.user.id || p.manager))
        roster.set(m.agent_id, { ...old, active: false, comment_id: c.id });
      continue;
    }
    if (m?.type !== "agent") continue;
    if (!(await permission(c.user)).allowed) continue;
    const old = roster.get(m.agent_id);
    if (old && old.owner_id !== c.user.id) continue;
    roster.set(m.agent_id, { ...m, login: c.user.login, comment_id: c.id });
  }
  const events = comments.map((c) => commentEvent(c, boardNumber));
  const requests = [];
  for (const {
    issue: i,
    comments: replies,
    events: transitions,
  } of Object.values(records.requests).sort(
    (a, b) => a.issue.number - b.issue.number,
  )) {
    const acknowledgments = new Map();
    for (const c of [...replies].sort((a, b) => a.id - b.id)) {
      const m = metadata(c.body),
        agent = m && roster.get(m.agent_id);
      if (
        m?.type === "ack" &&
        c.editProof?.trusted &&
        (m.owner_id === undefined || m.owner_id === c.user?.id) &&
        responses.includes(m.response) &&
        agent &&
        agent.owner_id === c.user?.id
      )
        acknowledgments.set(m.agent_id, m.response);
    }
    const active = [...roster.values()].filter((a) => a.active);
    const needsHumanIntervention =
      i.state === "open" &&
      !uncertainRoster &&
      !replies.some((c) => c.editProof?.trusted === false || malformed(c)) &&
      active.length > 0 &&
      active.every((a) => acknowledgments.get(a.agent_id) === "cannot_handle");
    requests.push({
      number: i.number,
      title: i.title,
      body: visible(i.body),
      state: i.state,
      url: i.html_url,
      labels: labels(i),
      acknowledgments: [...roster.values()].map((a) => ({
        agent_id: a.agent_id,
        name: a.name,
        active: a.active,
        response: acknowledgments.get(a.agent_id) || null,
      })),
      needsHumanIntervention,
    });
    events.push({
      id: `issue:${i.number}`,
      thread: i.number,
      kind: "request",
      body: visible(i.body),
      title: i.title,
      author: i.user?.login,
      time: i.created_at,
      updated: i.updated_at,
      url: i.html_url,
      state: i.state,
      rawVersion: digest(i.body || ""),
    });
    events.push(...replies.map((c) => commentEvent(c, i.number)));
    events.push(
      ...transitions
        .filter((e) => ["closed", "reopened"].includes(e.event))
        .map((e) => ({
          id: `event:${e.id}`,
          thread: i.number,
          kind: "status",
          body: `Request ${e.event}.`,
          author: e.actor?.login,
          time: e.created_at,
          updated: e.created_at,
          url: i.html_url,
        })),
    );
  }
  for (const e of events) {
    e.version = digest(
      JSON.stringify([e.body, e.title, e.rawVersion, e.state]),
    );
    delete e.rawVersion;
  }
  events.sort(
    (a, b) =>
      a.time.localeCompare(b.time) ||
      a.id.localeCompare(b.id, "en", { numeric: true }),
  );
  return {
    board: boardNumber,
    instructions: instructions(board.body),
    agents: [...roster.values()],
    requests,
    events,
    warnings,
  };
}
function commentEvent(c, thread) {
  return {
    id: `comment:${c.id}`,
    thread,
    kind: "message",
    body: visible(c.body),
    rawVersion: digest(c.body || ""),
    ...(c.editProof?.trusted && control(c) ? { metadata: control(c) } : {}),
    author: c.user?.login,
    time: c.created_at,
    updated: c.updated_at,
    url: c.html_url,
  };
}
export async function reconcileIntervention(
  gh,
  state,
  guard = async () => {},
  changed = () => {},
) {
  for (const r of state.requests) {
    const has = r.labels.includes(INTERVENTION_LABEL);
    if (has === r.needsHumanIntervention) continue;
    await guard();
    if (r.needsHumanIntervention)
      await gh.api("POST", `/issues/${r.number}/labels`, {
        labels: [INTERVENTION_LABEL],
      });
    else
      try {
        await gh.api(
          "DELETE",
          `/issues/${r.number}/labels/${encodeURIComponent(INTERVENTION_LABEL)}`,
        );
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    r.labels = r.labels.filter((name) => name !== INTERVENTION_LABEL);
    if (r.needsHumanIntervention) r.labels.push(INTERVENTION_LABEL);
    changed(r);
  }
}
export async function register(
  gh,
  board,
  agent,
  active,
  operationId,
  guard = async () => {},
) {
  const m = {
    type: "agent",
    agent_id: agent.id,
    owner_id: agent.ownerId,
    client: agent.client,
    name: agent.name,
    active,
    operation_id: operationId,
  };
  return commentOnce(
    gh,
    board,
    `${agent.name} ${active ? "connected" : "disconnected"}.`,
    m,
    guard,
  );
}
export async function commentOnce(
  gh,
  issue,
  body,
  meta,
  guard = async () => {},
  knownComments,
) {
  const comments =
    knownComments || (await gh.list(`/issues/${issue}/comments`));
  await verifyEdits(
    gh,
    comments.filter(
      (c) => metadata(c.body)?.operation_id === meta.operation_id,
    ),
  );
  const old = comments.find(
    (c) =>
      c.editProof?.trusted &&
      metadata(c.body)?.operation_id === meta.operation_id &&
      c.user?.id === meta.owner_id,
  );
  if (old) return old;
  await guard();
  return gh.api("POST", `/issues/${issue}/comments`, {
    body: marked(body, meta),
  });
}
export async function perform(
  gh,
  c,
  chat,
  input,
  operationId,
  guard,
  retry = true,
) {
  const base = {
    agent_id: chat.id,
    owner_id: c.ownerId,
    operation_id: operationId,
  };
  if (input.action === "ack") {
    if (!responses.includes(input.response))
      throw new Error(
        "Choose can_handle, cannot_handle, or need_clarification.",
      );
    const note = typeof input.note === "string" ? input.note.trim() : undefined;
    if (
      input.note !== undefined &&
      (typeof input.note !== "string" || !note || note.length > 1200)
    )
      throw new Error("Use an acknowledgment note between 1 and 1,200 characters.");
    const body = `${chat.name}: **${responseLabels[input.response]}**.${note ? `\n\n${note}` : ""}`;
    const issue = await assertRequest(gh, input.request_id, c.board);
    if (issue.state !== "open")
      throw new Error("Reopen the request before changing an acknowledgment.");
    const comments = await gh.list(`/issues/${input.request_id}/comments`);
    await verifyEdits(
      gh,
      comments.filter((c) => metadata(c.body)?.type === "ack"),
    );
    const last = comments
      .filter(
        (x) =>
          x.editProof?.trusted &&
          x.user?.id === c.ownerId &&
          metadata(x.body)?.type === "ack" &&
          metadata(x.body)?.agent_id === chat.id,
      )
      .sort((a, b) => b.id - a.id)[0];
    // A changed explanation is worth delivering even if the response is the
    // same. Older clients omitting notes must not erase an existing explanation.
    if (
      metadata(last?.body)?.response === input.response &&
      (note === undefined || visible(last.body) === body)
    )
      return { unchanged: true };
    return commentOnce(
      gh,
      input.request_id,
      body,
      { ...base, type: "ack", response: input.response },
      guard,
      comments,
    );
  }
  if (input.action === "resolve") {
    const issue = await assertRequest(gh, input.request_id, c.board),
      state = input.reopen ? "open" : "closed";
    if (issue.state === state) return { unchanged: true };
    await guard();
    return gh.api("PATCH", `/issues/${input.request_id}`, {
      state,
      state_reason: input.reopen ? "reopened" : "completed",
    });
  }
  const body = input.body?.trim();
  if (!body || body.length > 8000)
    throw new Error("Write a message between 1 and 8,000 characters.");
  if (input.kind === "request") {
    if (input.replyTo) throw new Error("Start a new issue for a request.");
    // Only uncertain retries need an operation lookup. Include unlabeled issues:
    // GitHub can create the issue while declining to apply its requested label.
    const existing = (
      retry
        ? await gh.list(
            `/issues?state=all${c.login ? `&creator=${encodeURIComponent(c.login)}` : ""}&sort=created&direction=asc`,
          )
        : []
    ).find(
      (i) =>
        !i.pull_request &&
        i.user?.id === c.ownerId &&
        metadata(i.body)?.operation_id === operationId,
    );
    const title = (input.title || body.split("\n")[0]).trim().slice(0, 160);
    if (!existing) await guard();
    const result =
      existing ||
      (await gh.api("POST", "/issues", {
        title,
        body: marked(`${chat.name}:\n\n${body}`, { ...base, type: "request" }),
        labels: [REQUEST_LABEL],
      }));
    if (!labels(result).includes(REQUEST_LABEL)) {
      try {
        await guard();
        await gh.api("POST", `/issues/${result.number}/labels`, {
          labels: [REQUEST_LABEL],
        });
        result.labels = [...(result.labels || []), REQUEST_LABEL];
      } catch (error) {
        error.uncertain = true;
        throw error;
      }
    }
    return result;
  }
  let thread = c.board,
    reply = "";
  if (input.replyTo) {
    const match = input.replyTo.match(/^(issue|comment):(\d+)$/);
    if (!match)
      throw new Error(
        "Use a replyTo reference returned by read_messages (issue:NUMBER or comment:ID).",
      );
    if (match[1] === "issue") {
      thread = Number(match[2]);
      await assertRequest(gh, thread, c.board);
    } else {
      const comment = await gh.api("GET", `/issues/comments/${match[2]}`);
      thread = Number(comment.issue_url.split("/").at(-1));
      if (thread !== c.board) await assertRequest(gh, thread, c.board);
      reply = `In reply to ${comment.html_url}\n\n`;
    }
  }
  return commentOnce(
    gh,
    thread,
    `${chat.name}:\n\n${reply}${body}`,
    { ...base, type: "message" },
    guard,
  );
}
