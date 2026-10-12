# Hackathon simulator — Phase 0

A two-agent native Codex hook preflight, separate from Patchwork's production
runtime. **Phase 0 is pending an authorized staged delivery trial.** The booking
comparison is not implemented. Phase 1 requires separate user approval even if
Phase 0 passes. No manual hook invocation counts as native delivery evidence.

## Requirements

- macOS with `sandbox-exec`; no unisolated fallback or Windows runner yet.
- Node.js 22.13+, Git, `gh`, and installed repository dependencies.
- Codex with native hooks and the stdio app-server interface (checked with
  `0.162.0-alpha.2`). Supply `--codex PATH` if it isn't on PATH.
- ChatGPT login cached in `$CODEX_HOME/auth.json`, normally `~/.codex/auth.json`.
- The exact requested model and reasoning effort; defaults: `gpt-6-luna`, `low`.
- For live runs only: an explicitly named dedicated GitHub sandbox you own or
  administer, with Issues enabled and `gh` authenticated. Prefer a repository-
  restricted GitHub credential. No personal repository is a built-in default.

## Subscription-only authentication

Before launching Codex, the runner verifies the source authentication file and
configuration, then each copied authentication file, environment, generated MCP
configuration, and exact native hook configuration. It requires
`auth_mode: "chatgpt"` and complete ChatGPT tokens. API keys, mixed credentials,
unknown modes, selected custom providers, custom provider definitions/endpoints,
and incompatible profile/auth overrides fail closed. This intentionally supports
only standard OpenAI/ChatGPT authentication, not enterprise custom gateways.

Each isolated home explicitly sets:

```toml
model_provider = "openai"
forced_login_method = "chatgpt"
cli_auth_credentials_store = "file"
```

Before any model turn, Codex itself must report a ChatGPT account through
`account/read`, and `config/read` must confirm the effective policy. Source-file
inspection alone does not pass this gate. Account details are never persisted;
reports retain only the verified mode. Auth-mode changes or model substitutions
stop the trial. No API-key fallback is allowed.

The environment is built from an allowlist: `OPENAI_API_KEY`, `CODEX_API_KEY`,
provider overrides, and external Codex auth tokens are never inherited. The
separate `GH_TOKEN` is forwarded only to Patchwork's MCP server and native startup
hook; it is excluded from model-run shell commands. MCP config contains variable
names, never credential values. Credential files live only in private temporary
homes and are removed during successful cleanup.

This consumes the ChatGPT account's Codex allowance/credits, not API-key billing.
It does not promise unlimited or cost-free usage. The runner records actual
reported tokens, including cached input; it cannot translate them reliably into
a percentage of subscription allowance or a dollar cost.

## Free verification

```sh
npm run test:sim
npm run sim -- check-local --codex /path/to/codex
```

`check-local` starts two isolated Codex configuration sessions, verifies copied
ChatGPT authentication, model availability, distinct session IDs, native hook
discovery, and real Patchwork MCP tool discovery, then removes both environments.
It never submits a model turn, invokes board tools, or registers a chat. The
protocol client rejects model-turn, tool-call, and authentication-change methods.
The board connections are disabled and the GitHub credential is a non-working
sentinel. Codex's account check does require a read-only online workspace routing
lookup; blocking all network access makes that check fail closed.

A local PASS proves configuration only. Real Patchwork identities, per-chat
cursors, and native delivery must still be proven by the authorized live test.

## Live test — requires explicit authorization

For your own sandbox:

```sh
npm run sim -- preflight --repo OWNER/TEST_REPO \
  --sandbox-repo --allow-live \
  --model gpt-6-luna --reasoning low --seconds 300 --tokens 300000 \
  --codex /path/to/codex
```

`--sandbox-repo` attests the named repository is a dedicated test sandbox.
`--allow-live` deliberately authorizes GitHub mutations and subscription usage.
Tests and CI never launch live trials. Never treat approval of local checks as
approval for this command.

The next proposed test for this workspace is explicitly scoped to
`IcebergSnow/PatchworkTesting`; its live execution is **awaiting authorization**.
There is no permission to start Phase 1 afterward.

The `--seconds` limit is configurable from 30 to 300 seconds, shared by both
sessions starting at session launch. Setup and cleanup can take additional time.
`--tokens` is a configurable aggregate reported-token stop threshold, including
cached input (default 250,000; the proposed command above explicitly uses 300,000).
An in-flight call can overshoot before accounting arrives. Missing usage remains
unavailable rather than estimated. There is no automatic trial retry, model
upgrade, or budget increase.

### Staged test: six bounded turns

**UserPromptSubmit round trip**

1. B takes a brief READY turn. Its real SessionStart registers its identity.
2. A's first turn registers through SessionStart, posts one unique request with
   real MCP, and finishes immediately.
3. The runner waits out the existing 15-second prompt cache if necessary, with
   no model calls. A subsequent B prompt receives the request through the real
   UserPromptSubmit hook. B acknowledges it through MCP and finishes.
4. After another cache-safe local wait if necessary, a subsequent A prompt
   receives the exact acknowledgment through UserPromptSubmit. A uses no tools.

The receiving prompts contain neither the random message marker nor its issue
or comment IDs. SessionStart or PostToolUse delivery cannot pass this path.

**PostToolUse round trip, separately**

5. B starts one genuine `sleep 65` shell command before the new request exists.
   The runner waits for its actual command-start event before starting A.
6. A posts a different, uniquely marked request through MCP, then executes one
   `sleep 95` shell command in that same turn. B's command completion triggers
   PostToolUse after the unchanged 60-second interval; B acknowledges through
   MCP. A's later command completion must deliver that exact acknowledgment
   through PostToolUse. Neither receives another user prompt during this exchange.

The command durations are derived from the production interval plus 5 seconds
for B and another 30 seconds for A's return path. Production polling and hook
configuration are unchanged. A command may need one genuine `write_stdin` wait
for its completion after `exec_command` yields. Prompts request one such wait,
not repeated short sleeps. There is no background polling model and no direct
runner invocation of hooks or board tools. A slow write that misses the single
checkpoint remains a failed/inconclusive trial; the runner does not rescue it
with another prompt or retry.

### PASS requirements and resource estimate

Overall PASS requires **both complete round trips**, both native registrations,
independent sessions/identities/cursors, matching remote request and acknowledgment
IDs, no manual board reads or unexpected commands, unchanged model/authentication,
and successful cleanup. This is stricter than accepting either hook type as a
substitute. Prompt-only success is reported separately and cannot complete Phase 0.

The report records each hook's name, ID, source, turn, timestamp, request/ack IDs,
per-turn usage, aggregate usage, cached input, overshoot, and shutdown diagnostics.
Full usage increments stay in report.json and JSONL. Hooks do not independently
report model tokens; usage is attributed to actual Codex turns, not invented
per-hook costs. An unobserved path is NOT VERIFIED, not a claim that it failed in
production.

Planning estimate, **not a live measurement**: about 2–4 minutes of session time
and roughly 200,000–350,000 reported tokens for both full round trips. The installed
Codex context contributed 15,000–25,000 input tokens per decision in the last run.
The new design targets about 14 model decisions, depending on command yielding,
instead of continuously looping both agents. The 300,000-token proposal may still
stop an expensive run; it is never raised automatically. A 100,000-token threshold
remains supported but may not fit both complete paths. There is no reliable
conversion from reported tokens to subscription-allowance percentage.

### Why the last trial exhausted its budget

Run `sim-2026-10-12T10-41-00-628Z-38a3735a` reported six increments:

| Agent | Total-token increments | Total | Cached input |
| --- | --- | ---: | ---: |
| A | 15,101; 15,405; 15,512 | 46,018 | 40,192 |
| B | 15,042; 25,227; 25,290 | 65,559 | 49,408 |

Combined: 111,181 input tokens and only 396 output tokens; 89,600 of the input
was cached. `sleep` itself did not consume model tokens: each repeated tool
decision reprocessed the conversation/tool context. Cache hits still count toward
our reported-token threshold. The logs do not identify exactly which hidden
context component caused B's later input to grow to about 25,000 tokens.

The last board check was at 10:41:40 UTC. The observed empty PostToolUse hooks
were at 10:42:04, 10:42:06, and 10:42:25, all before their next eligible poll.
At 10:42:25.837 usage jumped from 86,287 to 111,577 and triggered shutdown.
`UnknownProcessId` appeared at 10:42:25.846 while A had an active sleep, followed
by both process exits at 10:42:25.860. This timing is consistent with a cancellation
race, not the cause of the missing delivery; its internal cause is not proven.
The revised runner records shutdown initiation and waits for completed turns on
success, while keeping immediate process-group termination at budget limits.

## Reports and recovery

```sh
npm run sim -- report --run RUN_ID
npm run sim -- reset --run RUN_ID --allow-live
npm run sim -- delete --run RUN_ID --yes
```

Runs are saved under gitignored `bench/hackathon/runs/`, or `--output DIR`.
Use the same output directory for follow-up commands. Live runs retain a durable
manifest, redacted per-agent event logs, Markdown/JSON reports, native evidence,
usage, and owned GitHub records. Local checks produce `local-check.md` and a
manifest and never mark Phase 0 complete.

Cleanup discovers uncertain request writes using the run tag, original author,
and owned chat metadata. It closes only owned requests, retires owned chats, and
verifies remote state. Unknown ownership, changed accounts/repositories, or failed
cleanup block another trial against the same repository. `reset` retries cleanup
idempotently. Reports remain by default; `delete --yes` removes only the selected
local report directory after successful cleanup. No command deletes repositories.

GitHub registration, retirement, request, and acknowledgment history remains.
A preflight can reuse a test board, but this does not make it a clean benchmark
repository. Phase 1 would need separate fresh baseline/Patchwork repositories.

## Current evidence

Earlier live trials proved native startup and independent registration but did
not prove complete delivery: the first encountered hook trust configuration;
the corrected trial encountered missing MCP credential forwarding. Both are now
addressed in simulator configuration. Prior chats were retired and environments
removed. The latest 100,000-token trial also proved A's real MCP request but stopped before
the next eligible tool poll. These runs remain INCONCLUSIVE; local verification
does not change their results. No staged live trial is authorized yet.

This runner uses process-based macOS isolation and the same GitHub account for
both chats. It has no baseline comparison, booking scenario, automatic merging,
background service, or claim that Patchwork improves outcomes.
