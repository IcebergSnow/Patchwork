# Hackathon simulator — Phase 0

A two-agent native Codex hook preflight, separate from Patchwork's production
runtime. **Phase 0 is pending a live request/acknowledgment trial.** The booking
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
  --model gpt-6-luna --reasoning low --seconds 300 --tokens 250000 \
  --codex /path/to/codex
```

`--sandbox-repo` attests the named repository is a dedicated test sandbox.
`--allow-live` deliberately authorizes GitHub mutations and subscription usage.
Tests and CI never launch live trials. Never treat approval of local checks as
approval for this command.

The next proposed test for this workspace is explicitly scoped to
`IcebergSnow/PatchworkTesting`; its live execution is **awaiting authorization**.
There is no permission to start Phase 1 afterward.

The five-minute timer is shared by both sessions, starting when session launch
begins. Setup and cleanup can take additional time. The 250,000-token stop
threshold is aggregate reported usage, including cached input. An in-flight call
can overshoot before accounting arrives. Missing usage remains unavailable rather
than being estimated. The previous two-session trial reported 172,203 tokens,
mostly cached input; that is a reference point, not a prediction for this test.

### Required evidence

1. Both real native SessionStart hooks register separate GitHub chat identities.
2. Agent A (`sender`) uses real MCP `post_message` with `kind=request` and a unique
   run marker. The runner does not manufacture the request.
3. Agent B (`receiver`) gets that exact issue through native lifecycle context (normally PostToolUse;
   startup/prompt delivery also counts if the request already exists).
4. B uses real MCP `acknowledge_request` with `can_handle` for the same issue.
5. A receives that exact acknowledgment comment through native PostToolUse.
6. Remote records, separate chat IDs/keys, independent sessions and cursors, and
   both received event IDs agree with the observed native events.
7. Both chats are retired, the run-owned request is closed, and temporary
   environments/processes are removed. Only then can `phase0Complete` be true.

Agents use ordinary shell checkpoints; the runner never invokes internal hooks
or calls board tools on their behalf. Manual board reads disqualify the test.
The prompts prescribe this handshake only to test infrastructure, not to evaluate
spontaneous hackathon collaboration. Acknowledgment is not resolution; closing the
disposable request is explicit simulator cleanup after agents stop.

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
removed. These runs remain INCONCLUSIVE; new local verification does not change
their results. No new live trial is authorized yet.

This runner uses process-based macOS isolation and the same GitHub account for
both chats. It has no baseline comparison, booking scenario, automatic merging,
background service, or claim that Patchwork improves outcomes.
