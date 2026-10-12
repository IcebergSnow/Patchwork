import { digest } from "./store.js";

export const BOARD_LABEL = "patchwork:board";
export const REQUEST_LABEL = "patchwork";
export const INTERVENTION_LABEL = "patchwork:needs-human";
export const BOARD_MARKER = "<!-- patchwork-board:v1 -->";
const START = "<!-- patchwork-instructions:start -->",
  END = "<!-- patchwork-instructions:end -->";
const labels = (item) =>
  (item.labels || []).map((l) => (typeof l === "string" ? l : l.name));
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
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
    return match
      ? JSON.parse(Buffer.from(match[1], "base64").toString("utf8"))
      : null;
  } catch {
    return null;
  }
}
export function visible(body = "") {
  return (body || "").replace(
    /\n<!-- patchwork:v1:[A-Za-z0-9+/=]+ -->\s*$/,
    "",
  );
}
export function marked(body, data) {
  return `${body}\n<!-- patchwork:v1:${Buffer.from(JSON.stringify(data)).toString("base64")} -->`;
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
  return `${BOARD_MARKER}\n# Patchwork board\n\nPost announcements and questions in the comments. Create requests with the \`patchwork\` label; reply on the request and close it explicitly when resolved.\n\n[Open requests](https://github.com/${repo}/issues?q=is%3Aissue+is%3Aopen+label%3Apatchwork) · [Needs human intervention](https://github.com/${repo}/issues?q=is%3Aissue+is%3Aopen+label%3Apatchwork%3Aneeds-human)\n\n## Shared instructions (optional)\nEdit between the markers below. Keep this under 4,000 characters. Instructions do not grant agents permission to expand their scope.\n\n${START}\n\n${END}\n\nAgents introduce themselves in registration comments. Registered includes idle chats. Use Patchwork disconnect to retire finished chats; a maintainer can also change a registration comment's metadata active field to false. Acknowledgments are per chat, never assignments.\n`;
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

// The board is the source of truth. A complete small-board snapshot avoids
// maintaining another database or relying on GitHub search indexing delays.
export async function snapshot(gh, boardNumber) {
  const board = await gh.api("GET", `/issues/${boardNumber}`);
  if (
    board.pull_request ||
    board.state !== "open" ||
    !board.body?.startsWith(BOARD_MARKER) ||
    !labels(board).includes(BOARD_LABEL)
  )
    throw new Error("The connected board is missing or closed.");
  const [comments, issues] = await Promise.all([
    gh.list(`/issues/${boardNumber}/comments`),
    gh.list(`/issues?state=all&labels=${encodeURIComponent(REQUEST_LABEL)}`),
  ]);
  const roster = new Map(),
    permissions = new Map();
  async function writer(user) {
    if (!user?.login) return false;
    if (!permissions.has(user.id)) {
      let p;
      try {
        p = await gh.api(
          "GET",
          `/collaborators/${encodeURIComponent(user.login)}/permission`,
        );
      } catch (e) {
        if (e.status !== 404) throw e;
        permissions.set(user.id, false);
        return false;
      }
      permissions.set(
        user.id,
        !!p.user?.permissions?.push ||
          ["admin", "write", "maintain"].includes(p.permission),
      );
    }
    return permissions.get(user.id);
  }
  for (const c of [...comments].sort((a, b) => a.id - b.id)) {
    const m = metadata(c.body);
    if (
      m?.type !== "agent" ||
      !uuid(m.agent_id) ||
      m.owner_id !== c.user?.id ||
      typeof m.active !== "boolean" ||
      !["codex", "claude"].includes(m.client) ||
      typeof m.name !== "string" ||
      m.name.length > 80
    )
      continue;
    if (!(await writer(c.user))) continue;
    const old = roster.get(m.agent_id);
    if (old && old.owner_id !== c.user.id) continue;
    roster.set(m.agent_id, { ...m, login: c.user.login, comment_id: c.id });
  }
  const events = comments.map((c) => commentEvent(c, boardNumber));
  const requests = [];
  for (const i of issues
    .filter((i) => isRequest(i, boardNumber))
    .sort((a, b) => a.number - b.number)) {
    const [replies, transitions] = await Promise.all([
      gh.list(`/issues/${i.number}/comments`),
      gh.list(`/issues/${i.number}/events`),
    ]);
    const acknowledgments = new Map();
    for (const c of [...replies].sort((a, b) => a.id - b.id)) {
      const m = metadata(c.body),
        agent = m && roster.get(m.agent_id);
      if (
        m?.type === "ack" &&
        responses.includes(m.response) &&
        agent &&
        agent.owner_id === c.user?.id
      )
        acknowledgments.set(m.agent_id, m.response);
    }
    const active = [...roster.values()].filter((a) => a.active);
    const needsHumanIntervention =
      i.state === "open" &&
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
  for (const e of events) e.version = digest(JSON.stringify([e.body, e.title]));
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
  };
}
function commentEvent(c, thread) {
  return {
    id: `comment:${c.id}`,
    thread,
    kind: "message",
    body: visible(c.body),
    author: c.user?.login,
    time: c.created_at,
    updated: c.updated_at,
    url: c.html_url,
  };
}
export async function reconcileIntervention(gh, state, guard = async () => {}) {
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
) {
  const comments = await gh.list(`/issues/${issue}/comments`);
  const old = comments.find(
    (c) =>
      metadata(c.body)?.operation_id === meta.operation_id &&
      c.user?.id === meta.owner_id,
  );
  if (old) return old;
  await guard();
  return gh.api("POST", `/issues/${issue}/comments`, {
    body: marked(body, meta),
  });
}
export async function perform(gh, c, chat, input, operationId, guard) {
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
    const issue = await assertRequest(gh, input.request_id, c.board);
    if (issue.state !== "open")
      throw new Error("Reopen the request before changing an acknowledgment.");
    const comments = await gh.list(`/issues/${input.request_id}/comments`);
    const last = comments
      .filter(
        (x) =>
          x.user?.id === c.ownerId &&
          metadata(x.body)?.type === "ack" &&
          metadata(x.body)?.agent_id === chat.id,
      )
      .sort((a, b) => b.id - a.id)[0];
    if (metadata(last?.body)?.response === input.response)
      return { unchanged: true };
    return commentOnce(
      gh,
      input.request_id,
      `${chat.name}: **${responseLabels[input.response]}**.`,
      { ...base, type: "ack", response: input.response },
      guard,
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
    const existing = (
      await gh.list(`/issues?state=all&labels=${REQUEST_LABEL}`)
    ).find(
      (i) =>
        !i.pull_request &&
        i.user?.id === c.ownerId &&
        metadata(i.body)?.operation_id === operationId,
    );
    if (existing) return existing;
    const title = (input.title || body.split("\n")[0]).trim().slice(0, 160);
    await guard();
    const result = await gh.api("POST", "/issues", {
      title,
      body: marked(`${chat.name}:\n\n${body}`, { ...base, type: "request" }),
      labels: [REQUEST_LABEL],
    });
    if (!labels(result).includes(REQUEST_LABEL))
      throw new Error(
        `Created #${result.number}, but GitHub did not apply the Patchwork label. Check permissions; do not recreate the request.`,
      );
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
