# Hackathon simulator

A small, isolated Codex benchmark under `bench/hackathon/`. **Phase 0 remains
INCONCLUSIVE:** the staged live run verified the UserPromptSubmit round trip and
receiver-side PostToolUse delivery/acknowledgment, but not the sender's return
PostToolUse delivery. Phase 1 implementation was explicitly authorized despite
that limitation. No manual hook invocation counts as native delivery evidence.

Phase 1 is implemented and requires a separate explicit live opt-in. Ordinary
local tests and repository setup never launch model turns.

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

## Phase 1: booking comparison

Three independent agents own frontend (`public/`), backend (`server/`) and storage
(`storage/`). The starter has a genuine camelCase/snake_case API mismatch and an
unfinished persistence layer. The agents must deliver a working SQLite booking
app, commit/push their own changes, and integrate into remote `main` themselves.
The runner never implements, merges, assigns dependencies, or relays board messages.

Both conditions use the same starter commit, requirements, scopes, model/effort,
budgets, Codex version and scripted human responses. Baseline has normal shell,
Git and `gh`, with no Patchwork MCP/hooks. Enabled adds actual Patchwork MCP and
native hooks, including the unchanged production polling interval. Account apps,
plugins, nested-agent tools, web search and computer/browser control are disabled
in both conditions. These simulator-only settings follow the
[official configuration guidance](https://learn.chatgpt.com/docs/enterprise/managed-configuration#configure-network-access-requirements).

Each condition starts three independent app-server processes and sessions with
separate homes, auth copies, Git clones, Patchwork homes and cursors. Their editing
scopes are user instructions, not a new Patchwork role-management system. Sessions
receive the same two human checkpoints at 180 and 420 seconds, deferred until the
current turn finishes. The first permits shared root-file edits; neither permits
editing peer directories. Interactive questions receive one fixed scope-preserving
response. Agents may finish blocked while the runner waits locally for a checkpoint:
there are no model-driven wait loops. Actual delivery times and responses are logged.

### Optional private repository setup

```sh
npm run sim -- setup \
  --baseline-repo YOUR_ACCOUNT/BookingBaseline \
  --patchwork-repo YOUR_ACCOUNT/BookingEnabled --allow-create
npm run sim -- validate-setup \
  --baseline-repo YOUR_ACCOUNT/BookingBaseline \
  --patchwork-repo YOUR_ACCOUNT/BookingEnabled
```

`setup` uses existing `gh` authentication, creates only missing private repositories
under the active personal account, and initializes both with the same deterministic
commit. It inspects existing repositories and leaves them untouched, even if empty.
An interrupted creation/push is journaled; setup never force-pushes or repairs an
existing repository. Setup receipts are retained separately under `runs/setups/`;
`setup.json` is only the latest pointer. Older single-file receipts are preserved
before updating that pointer. `validate-setup` is read-only and requires private repositories
with exactly the starter commit on `main`, no other branches, tags or issue history.
Source-repository names are refused. No personal sandbox is hardcoded.

Two fresh repositories form one comparison pair. Conditions run sequentially,
with a local lock and unfinished-cleanup guard. Enabled requires the baseline run
ID, checks every control and the pre-authorized enabled repository's immutable ID,
and refuses changed or contaminated starting state. Keep the same output directory
and reserve both repositories exclusively for this experiment. The local lock does
not coordinate runners on different computers.

### Repeat comparisons without resetting repositories

Cleanup **does not restore a used repository to its starter commit**. Moving an
advanced `main` back to its ancestor would rewrite history; replacing files with a
new revert commit would not have the identical commit ID. Neither is used here.
Closed board history also makes an otherwise unchanged repository unsuitable for a
new comparison. Cleanup completion and repository reusability are reported separately.

After a comparison finishes and cleanup succeeds, use either Phase 1 run ID:

```sh
npm run sim -- fresh-pair --from-run PREVIOUS_PHASE1_RUN_ID --allow-create
```

This setup-only command automatically creates two uniquely named private repositories
under the same authenticated account, for example `BookingBaseline-sim-<suffix>` and
`BookingEnabled-sim-<suffix>`. It pins both to the previous run's **exact original
starter commit and scenario hash**, validates them after creation, and prints the
baseline and enabled trial commands with the new repository names. It never starts
Codex. Use the same `--output DIR` as the previous run if you changed the default.

The old repositories and all reports remain intact. A name collision is refused
before creation; an ambiguous or partial creation leaves a receipt for inspection
and is never retried automatically. If the local starter has changed since the
original comparison, creation stops before any GitHub write instead of silently
changing the experiment. Restore the original scenario version to continue that
series. Completed cleanup is required; resolve any failed cleanup before continuing.

Before every live condition, the simulator checks private ownership, permissions,
repository identity, exact starter `main` SHA, branches, tags and all issue history
again. Each isolated checkout also verifies its fetched commit. There is no automatic
reset, force-push of `main`, issue deletion, or repository deletion. Reserve sandbox
repositories exclusively for the experiment; validation is not a cross-machine lock.

### Commands (only after live authorization)

```sh
npm run sim -- trial --condition baseline \
  --repo YOUR_ACCOUNT/BookingBaseline --peer-repo YOUR_ACCOUNT/BookingEnabled \
  --sandbox-repo --allow-live --model gpt-6-luna --reasoning low \
  --seconds 900 --tokens 1000000 --codex /path/to/codex

npm run sim -- trial --condition patchwork \
  --repo YOUR_ACCOUNT/BookingEnabled --baseline-run BASELINE_RUN_ID \
  --sandbox-repo --allow-live --model gpt-6-luna --reasoning low \
  --seconds 900 --tokens 1000000 --codex /path/to/codex

npm run sim -- compare --baseline-run BASELINE_RUN_ID --patchwork-run ENABLED_RUN_ID
```

Recommended initial limits: **15 minutes and 1,000,000 reported tokens per
condition**, across all three agents, including cached input. These are stop
thresholds, not consumption forecasts; in-flight calls can overshoot. The pair
therefore allows up to 30 live minutes and approximately 2,000,000 reported tokens,
plus setup/grading/cleanup time. Runtime is configurable from 30–1800 seconds.
Short limits may end before both scripted checkpoints; reports record that rather
than silently changing the script. The runner never upgrades models or retries a
live condition automatically. Subscription allowance percentage cannot be predicted.

`caffeinate -i -s` prevents idle macOS sleep while agents run and exits when the
runner dies; lid closure or manual sleep can still interrupt a trial. Time and token
limits terminate entire agent process groups. Keep the laptop open and powered.

### External grading, evidence and cleanup

The grader checks the published `main` snapshot under a separate OS sandbox,
without credentials or access to agents' homes. Tests and reference solutions live
outside editable workspaces. Eight deterministic checks cover slots, booking/list,
validation, atomic duplicate prevention, UI module/selector wiring, the real browser
API client against HTTP, restart persistence, and SQLite/availability integration.
UI wiring is a smoke test, not a full browser usability assessment. Agents know the
public requirements but cannot modify the grader.

Reports include redacted native hooks/MCP results and IDs, tokens (cached included),
Git SHAs, code bundles, uncommitted tracked patches, worktree status, conflicts,
authored scope flags, duplicate patch IDs, overlapping files, blocker messages and
scripted human interventions. `collaboration-before-cleanup.json` captures issue
state and comments before cleanup closes anything. Acknowledgments or closure alone
never prove that a dependency was fixed. Review direct GitHub links and code evidence.
Authored commit metadata supports scope review but is not tamper-proof. Untracked
files appear in worktree status but their content is not archived.

The instrumented `gh` counts actual HTTP requests from agent shells and Patchwork
MCP/hooks, including isolated installation. A separate `liveRequests` count excludes
pre-launch installation. It discards debug headers/bodies and records only verb/time.
Host-side setup, grading fetches, cleanup, Git transport, direct HTTP and an absolute-path bypass of
`gh` are excluded; reports state this coverage. It is not account-wide accounting.

Cleanup stops agents, retires only owned chats, closes owned requests/issues/PRs,
and removes owned role branches with an atomic expected-SHA lease pinned to the
archived run snapshot. Only heads also present in the agents' local branch histories
are eligible; a name alone never proves ownership. Cleanup retries do not update
the lease to a newly observed head. Foreign resources,
changed accounts, or uncertain ownership cause cleanup to fail closed and retain
local recovery state. `reset --run ID --allow-live` retries cleanup. Credentials and
operational temporary directories are removed only after cleanup succeeds.
Repositories, final main, closed GitHub history/labels, and local reports/bundles are
retained intentionally for review. No command deletes or resets a repository. Use a
`fresh-pair --from-run RUN_ID --allow-create` to prepare another comparison
automatically; consumed repositories are refused.

PASS means all eight checks pass, every role contributed to submitted main, expected
session/identity/native-startup evidence exists, token accounting is available, and
cleanup succeeded. FAIL denotes an incomplete application in a valid condition;
INCONCLUSIVE denotes missing evidence or infrastructure/cleanup failure. Budget
stops are censored time observations, not completion times. One sequential pair
provides descriptive evidence, not a statistically reliable effectiveness claim.

### Free checks

```sh
npm run test:sim
npm test
npm run build
npm run sim -- check-local --phase1 --condition baseline --codex /path/to/codex
npm run sim -- check-local --phase1 --condition patchwork --codex /path/to/codex
```

These configuration checks start three independent sessions, verify subscription
mode, exact model/effort and expected tool/hook inventory, then clean up. Patchwork
connections are disabled with a nonworking GitHub credential. There are no model
turns, live registrations, or board messages. This does not claim live three-agent
integration is verified. Current runner/grader isolation requires macOS; other
platforms fail closed.

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
names, never credential values. Phase 1 also writes a mode-0600 credential file in each
isolated `GH_CONFIG_DIR` so ordinary Git/GitHub tools work equally in both conditions.
Credentials are outside the project and never committed. The existing GitHub token
retains its original permissions; sandbox repository scope is an experiment
instruction, not a server-side restriction on that token. Credential files live only in private temporary
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

This Phase 0 command is retained for reference. Phase 0 remains INCONCLUSIVE;
implementation approval for Phase 1 is separate from permission to run any live
trial. No live trial is launched by setup, cleanup, or the free tests.

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
repository. Phase 1 requires separate fresh baseline/Patchwork repositories.

## Current Phase 0 evidence

The staged live run `sim-2026-10-12T16-59-54-992Z-a71d6963` remains INCONCLUSIVE.
It verified native startup, independent registrations, the complete UserPromptSubmit
round trip, and Agent B receiving/acknowledging through PostToolUse. Agent A's return
PostToolUse check encountered GitHub network/timeouts. Reported usage was 295,928
including 265,984 cached input tokens. macOS sleep extended wall time beyond the
configured 300 seconds; Phase 1 now prevents idle sleep. Cleanup succeeded.

Phase 1 implementation is authorized. No live three-agent comparison has been run.
