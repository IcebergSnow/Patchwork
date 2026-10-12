import { randomUUID } from "node:crypto";
import { GitHub } from "./github.js";
import { register, reconcileIntervention, perform } from "./board.js";
import { withBoard, POLL_INTERVAL, PROMPT_INTERVAL } from "./sync.js";
import {
  digest,
  read,
  readJSON,
  writeJSON,
  locked,
  loadConnection,
} from "./store.js";
import { AGENT_INSTRUCTIONS } from "./instructions.js";

export const CHECK_INTERVAL = POLL_INTERVAL,
  REMINDER_INTERVAL = 300_000;
const LIMIT = 12_000;
export const disabledFile = (file, id) =>
  `${file}${id ? `.${id}` : ""}.disabled`;
export const stateFile = (file) => `${file}.sessions.json`;
export async function guard(file, id) {
  if (
    (await read(disabledFile(file))) ||
    (id && (await read(disabledFile(file, id))))
  )
    throw new Error("This Patchwork connection or chat is disconnected.");
  return loadConnection(file);
}
function preview(e, max = 650) {
  return JSON.stringify({
    ...e,
    body: e.body.slice(0, max),
    ...(e.body.length > max ? { truncated: true } : {}),
    version: undefined,
  });
}
function selectEvents(state, seen, maximum = LIMIT - 1000) {
  const selected = [];
  let size = 0;
  for (const event of state.events) {
    if (seen[event.id] === event.version) continue;
    const line = preview(event);
    if (size + line.length > maximum) break;
    selected.push({ event, line });
    size += line.length + 2;
  }
  return selected;
}
export class Runtime {
  constructor(file, { github, clock = Date.now } = {}) {
    this.file = file;
    this.github = github;
    this.clock = clock;
  }
  client(c) {
    return (this.github ||= new GitHub(c.repo));
  }
  async hook(input) {
    if (
      typeof input.session_id !== "string" ||
      !input.session_id ||
      input.session_id.length > 300 ||
      !["SessionStart", "UserPromptSubmit", "PostToolUse"].includes(
        input.hook_event_name,
      )
    )
      throw new Error("Invalid hook session metadata.");
    return locked(stateFile(this.file), async () => {
      const c = await guard(this.file),
        now = this.clock();
      const store = (await readJSON(stateFile(this.file))) || { chats: {} };
      const key = digest(`${c.client}\0${input.session_id}`);
      let chat = store.chats[key];
      if (!chat) {
        const id = randomUUID();
        chat = store.chats[key] = {
          id,
          chat_key: randomUUID(),
          name: `${c.name} / ${id.slice(0, 6)}`,
          ownerId: c.ownerId,
          client: c.client,
          registered: false,
          registrationOperation: randomUUID(),
          seen: {},
          lastCheck: 0,
          lastReminder: 0,
          initialized: false,
          pending: null,
        };
        // Save identity before a network write, so an uncertain response can retry safely.
        await writeJSON(stateFile(this.file), store);
      }
      await guard(this.file, chat.id);
      if (chat.retryAfter && now < chat.retryAfter) return {};
      if (
        input.hook_event_name === "PostToolUse" &&
        now - chat.lastCheck < CHECK_INTERVAL
      )
        return {};
      try {
        const gh = this.client(c);
        const { state, labelWarning } = await withBoard(
          c,
          gh,
          async (sync) => {
            await sync.poll(
              input.hook_event_name === "PostToolUse"
                ? POLL_INTERVAL
                : PROMPT_INTERVAL,
            );
            if (!chat.registered) {
              const registration = await register(
                gh,
                c.board,
                chat,
                true,
                chat.registrationOperation,
                async () => {
                  await guard(this.file, chat.id);
                  await sync.authorize();
                },
              );
              await sync.accept(registration);
              chat.registered = true;
              chat.retireOperation = null;
              await writeJSON(stateFile(this.file), store);
            }
            const state = await sync.view();
            if (!state.agents.some((a) => a.agent_id === chat.id && a.active))
              throw new Error(
                "This chat was retired on GitHub. Reconnect it explicitly.",
              );
            let labelWarning = false;
            try {
              await reconcileIntervention(
                gh,
                state,
                async () => {
                  await guard(this.file, chat.id);
                  await sync.authorize();
                },
                (request) => sync.labels(request),
              );
            } catch {
              labelWarning = true;
            }
            return { state, labelWarning };
          },
          this.clock,
        );
        const initial = !chat.initialized;
        const hash = digest(
          JSON.stringify([
            state.instructions,
            state.agents.map((a) => [a.agent_id, a.name, a.active]),
            AGENT_INSTRUCTIONS,
          ]),
        );
        const fresh =
          initial ||
          chat.contextHash !== hash ||
          input.hook_event_name === "SessionStart";
        const due = fresh || now - chat.lastReminder >= REMINDER_INTERVAL;
        const open = state.requests.filter((r) => r.state === "open");
        let context = "";
        if (fresh)
          context = `Patchwork: ${c.repo}, board #${c.board}. Your agent ID: ${chat.id}. Your private chat_key for board tools: ${chat.chat_key}. Never use another chat\'s key.\n\n${AGENT_INSTRUCTIONS}\n\nRegistered chats: ${JSON.stringify(
            state.agents
              .filter((a) => a.active)
              .map((a) => ({ id: a.agent_id, name: a.name }))
              .slice(0, 20),
          )}. Full roster: read_messages.\n`;
        if (due) {
          context += `\nShared instructions: ${state.instructions || "(none; stop applying previously supplied shared instructions)"}\n`;
          const pending = open.filter(
            (r) =>
              !r.acknowledgments.find((a) => a.agent_id === chat.id)?.response,
          );
          if (pending.length)
            context += `\nRequests you have not evaluated: ${pending
              .slice(0, 20)
              .map((r) => `#${r.number}`)
              .join(
                ", ",
              )}${pending.length > 20 ? " (more remain)" : ""}. Read open requests and acknowledge each with your chat_key. Silence is not a decline.\n`;
          const intervention = open.filter((r) => r.needsHumanIntervention);
          if (intervention.length)
            context += `\nNeeds Human Intervention: ${intervention
              .slice(0, 20)
              .map((r) => `#${r.number}`)
              .join(
                ", ",
              )}. Notify your user if this blocks you; continue independent work.\n`;
        }
        if (initial) {
          context +=
            "\nWelcome: open requests and recent context. Full history is available with read_messages.\n";
          let shown = 0;
          for (const r of open.slice(0, 8)) {
            const line = JSON.stringify({
              ...r,
              body: r.body.slice(0, 220),
              acknowledgments: undefined,
              labels: undefined,
            });
            if (context.length + line.length < LIMIT - 1700) {
              context += line + "\n";
              shown++;
            }
          }
          if (open.length > shown)
            context +=
              "More open requests remain; use read_messages open_only=true and its nextCursor.\n";
          for (const e of state.events.slice(-3)) {
            const line = preview(e, 250);
            if (context.length + line.length < LIMIT - 100)
              context += line + "\n";
          }
          // Only mark events actually present in this complete snapshot, not a
          // timestamp boundary that could swallow a concurrently created post.
          for (const e of state.events) chat.seen[e.id] = e.version;
        } else {
          const selected = selectEvents(
            state,
            chat.seen,
            LIMIT - context.length - 350,
          );
          for (const { event, line } of selected) {
            context += `\n${line}\n`;
            chat.seen[event.id] = event.version;
          }
          if (state.events.some((e) => chat.seen[e.id] !== e.version))
            context +=
              "\nMore updates remain. The next check continues delivery; read_messages can read them now.\n";
        }
        if (labelWarning)
          context +=
            "\nCould not refresh GitHub intervention labels; responses above remain authoritative.\n";
        await guard(this.file, chat.id);
        chat.initialized = true;
        chat.contextHash = hash;
        chat.lastCheck = now;
        chat.lastSuccess = new Date(now).toISOString();
        chat.retryAfter = 0;
        chat.lastError = null;
        if (due) chat.lastReminder = now;
        await writeJSON(stateFile(this.file), store);
        return context
          ? {
              hookSpecificOutput: {
                hookEventName: input.hook_event_name,
                additionalContext: context,
              },
            }
          : {};
      } catch (e) {
        // No failed snapshot advances delivery. A bounded cooldown prevents a
        // tool loop from hammering GitHub while unavailable or rate limited.
        const disk = await readJSON(stateFile(this.file));
        if (disk?.chats[key]) {
          disk.chats[key].retryAfter = Math.max(now + 60_000, e.retryAt || 0);
          disk.chats[key].lastError = e.message;
          await writeJSON(stateFile(this.file), disk);
        }
        throw e;
      }
    });
  }
  async tool(name, input) {
    return locked(stateFile(this.file), async () => {
      const c = await guard(this.file),
        store = await readJSON(stateFile(this.file));
      const chat = Object.values(store?.chats || {}).find(
        (a) => a.chat_key === input.chat_key,
      );
      if (!chat)
        throw new Error(
          "Use the chat_key supplied by this chat's Patchwork hook. Start/reload the chat if no key has arrived.",
        );
      await guard(this.file, chat.id);
      const gh = this.client(c);
      return withBoard(
        c,
        gh,
        async (sync) => {
          await sync.poll(PROMPT_INTERVAL);
          const state = await sync.view();
          if (!state.agents.some((a) => a.agent_id === chat.id && a.active))
            throw new Error(
              "This chat is no longer registered. Reconnect it explicitly.",
            );
          if (name === "read_messages") {
            let cursor = 0;
            if (input.cursor) {
              try {
                const v = JSON.parse(
                  Buffer.from(input.cursor, "base64url").toString(),
                );
                if (
                  v.board !== c.board ||
                  v.open !== !!input.open_only ||
                  !Number.isSafeInteger(v.offset) ||
                  v.offset < 0
                )
                  throw 0;
                cursor = v.offset;
              } catch {
                throw new Error("Invalid cursor for this board/filter.");
              }
            }
            const items = input.open_only
              ? state.requests.filter((r) => r.state === "open")
              : state.events;
            const batch = items.slice(cursor, cursor + 30);
            return {
              agents: state.agents,
              instructions: state.instructions,
              messages: batch,
              requests: input.open_only
                ? batch
                : state.requests.filter((r) => r.state === "open"),
              hasMore: cursor + 30 < items.length,
              nextCursor:
                cursor + 30 < items.length
                  ? Buffer.from(
                      JSON.stringify({
                        board: c.board,
                        open: !!input.open_only,
                        offset: cursor + 30,
                      }),
                    ).toString("base64url")
                  : null,
            };
          }
          const actions = {
            post_message: "post",
            acknowledge_request: "ack",
            resolve_request: "resolve",
          };
          if (!actions[name]) throw new Error("Unknown board tool.");
          const data = { ...input, chat_key: undefined, action: actions[name] };
          const fingerprint = digest(JSON.stringify(data));
          if (chat.pending && chat.pending.fingerprint !== fingerprint)
            throw new Error(
              "An earlier write has an uncertain result. Retry that exact operation first to avoid duplicate or reordered posts.",
            );
          chat.pending ??= { fingerprint, id: randomUUID() };
          await writeJSON(stateFile(this.file), store);
          let result;
          try {
            result = await perform(
              gh,
              c,
              chat,
              data,
              chat.pending.id,
              async () => {
                await guard(this.file, chat.id);
                await sync.authorize();
              },
            );
          } catch (e) {
            // Validation and definite rejections can safely be corrected. Unknown
            // network/5xx results retain the same operation ID for a safe retry.
            if (!("status" in e) || (e.status >= 400 && e.status < 500)) {
              chat.pending = null;
              await writeJSON(stateFile(this.file), store);
            }
            throw e;
          }
          chat.pending = null;
          await writeJSON(stateFile(this.file), store);
          let labelWarning;
          try {
            await sync.accept(result);
            await reconcileIntervention(
              gh,
              await sync.view(),
              async () => {
                await guard(this.file, chat.id);
                await sync.authorize();
              },
              (request) => sync.labels(request),
            );
          } catch {
            labelWarning =
              "Post saved; intervention labels will refresh on a later check.";
          }
          return {
            id: result.id,
            number: result.number,
            url: result.html_url,
            unchanged: result.unchanged,
            ...(labelWarning ? { warning: labelWarning } : {}),
          };
        },
        this.clock,
      );
    });
  }
}
