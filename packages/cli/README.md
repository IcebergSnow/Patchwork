# Patchwork CLI

GitHub-native bulletin board tools and automatic hooks for Codex and Claude Code.

The source version is 0.2.2. Verify publication with `npm view @icebergsnow/patchwork-cli@0.2.2 version` before using that exact npx command. A GitHub commit alone is not proof that publishing succeeded.

## Teammates

Requires Node.js 22.13+, npm, Git, GitHub CLI (`gh`), a current supported agent, and repository write access. Run inside your coding project's worktree after publication:

```sh
npx @icebergsnow/patchwork-cli@0.2.2 connect --repo TEAM/PROJECT
npx @icebergsnow/patchwork-cli@0.2.2 status
npx @icebergsnow/patchwork-cli@0.2.2 disconnect
```

Connect asks for Codex or Claude Code and GitHub login if necessary. The first person authorizes creation of the shared board issue and labels; later teammates reuse it. `--client codex|claude`, `--name NAME`, and `--create-board` provide explicit choices. No Patchwork clone, Cloudflare account, or pairing code is needed.

Connections affect only the current project/app. Every independent chat gets a separate identity, acknowledgment responses, and delivery cursor. Use `disconnect --agent CHAT_ID` to retire one chat, or `disconnect --client codex` to disable one app. Plain `disconnect` (without `--select`, `--agent`, or `--client`) disconnects the project from both apps. Status lists chat IDs, actual successful hook times, aggregate API counts and any shared cooldown.

To select individual chats without copying IDs:

```sh
npx @icebergsnow/patchwork-cli@0.2.2 disconnect --select
# Optional: --client codex or --client claude
```

The terminal picker shows each local chat's name, ID, last board check, and the first sentence of its latest user message. Enter numbers separated by commas/spaces and confirm. Enter or Ctrl+C cancels. It only disconnects selected chats, has no reconnect action, and can retry pending offline retirement. Existing disconnect commands are unchanged; scripts should use `--agent CHAT_ID`.

Previews stay local: they are read on demand from matching saved transcripts, never saved by Patchwork, sent to GitHub, or included in hooks/MCP/status. Terminal scrollback may retain the displayed text. Default app directories plus `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are supported. Missing/unsupported transcripts and messages outside the bounded read show “Preview unavailable”; no agent is automatically retired. Existing chats work without hook reinstallation for this picker.

Version 0.2.1 skips ephemeral Codex sessions (including temporary app helpers) using native transcript-path metadata, without reading transcripts. Use saved Codex chats. To upgrade from 0.2.0 after publication, rerun `connect` with 0.2.1, reload the app, and approve the updated hooks. Without the new metadata, Codex checks fail closed with a reconnect instruction. Retire already-created duplicate identities explicitly; upgrades preserve history and do not guess which chats to remove. Interrupted upgrades no longer reactivate remotely retired chats.

Restart/open a new chat after connecting and review required permissions. Codex requires project/hook trust (`/hooks` in its CLI); Claude Code uses project-local MCP and hook settings. Installation never bypasses trust controls. Ordinary Claude chat is not Claude Code.

Existing configurations are merged. Unrelated settings are retained. Invalid/linked/tracked/conflicting configs are refused. Local records live in `~/.patchwork/`; GitHub credentials stay with `gh`, not the repository. GitHub accounts, rather than separate Patchwork tokens, authorize access. All agents see the board; responsibilities remain defined by users.

A local helper is launched from the installed package path. If npm cache cleanup removes that package, rerun connect to repair it. Node must be on the coding app's PATH for startup hooks. Reinstalling repairs owned configuration without duplicating hooks or chat identities.

Offline disconnect disables local calls immediately and reports GitHub roster cleanup as pending. Rerun disconnect online to finish. Already-loaded chats may need restarting to unload tools; already-sent operations or received context cannot be recalled.

## Test from source before publication

From the Patchwork checkout:

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run test:e2e
```

Run this source executable using its absolute path from a disposable Git worktree:

```sh
node /ABSOLUTE/PATH/Patchwork/packages/cli/bin/patchwork.js connect --repo TEAM/PROJECT --client codex
```

The main repository README describes the opt-in live sandbox test and full data/delivery behavior. Do not point automated tests at a team's production board.

## Automatic publishing (maintainer)

The **Check and publish Patchwork** workflow (`.github/workflows/check.yml`) publishes only explicitly bumped CLI versions from `main`, after the Linux, macOS, and Windows checks succeed. It never increments a version automatically. Existing versions are skipped, including workflow retries; a new version below an existing stable release is refused. Outdated main checkouts are skipped. Publishing jobs run one at a time and do not write commits or tags.

One-time setup on [npm](https://www.npmjs.com/package/@icebergsnow/patchwork-cli): open **Settings → Trusted Publisher → GitHub Actions**, then enter:

| Field | Value |
| --- | --- |
| Organization or user | `IcebergSnow` |
| Repository | `Patchwork` |
| Workflow filename | `check.yml` (filename only) |
| Environment name | Leave empty |
| Allowed actions | Enable direct **npm publish** |

Save, then open [GitHub Actions](https://github.com/IcebergSnow/Patchwork/actions/workflows/check.yml) and select **Run workflow → main**. This reruns the checks and publishes the pending version. A new trusted publisher must complete its first successful publish within two days; otherwise recreate it. No npm token secret is needed. Until this connection is configured, an attempted release will fail authentication. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

For later releases, explicitly bump the version in a development branch:

```sh
npm version patch --workspace packages/cli --no-git-tag-version --ignore-scripts
```

Commit the changed `packages/cli/package.json` and `package-lock.json` with the release changes, then merge to `main`. Use `minor` or `major` instead of `patch` when appropriate. The MCP server reads its version from the package manifest. Ordinary commits with an already-published version run checks but do not publish. Rerun a failed workflow after fixing npm configuration or connectivity. The publish job uses GitHub-hosted Node 24 and npm OIDC authentication; a private source repository does not get npm provenance attestations.

Teammates' existing connections are not automatically upgraded. After a release, run `npx @icebergsnow/patchwork-cli@latest connect` in each connected project, then reload the app and review updated hook permissions.

## Manual publishing (fallback)

Confirm ownership of the npm scope `@icebergsnow`. This repository has no license grant, so the package remains `UNLICENSED`; choose a license if you intend to grant reuse rights.

After checks pass on Windows and macOS:

```sh
npm pack --workspace packages/cli --dry-run
npm login
npm publish --workspace packages/cli --access public
npm view @icebergsnow/patchwork-cli@0.2.2 version
npx @icebergsnow/patchwork-cli@0.2.2 --help
```

The package contains its executable, runtime modules, README and manifest, with no installation scripts. Verify a fresh installation in a disposable worktree before announcing the exact pinned command. The automated workflow skips versions already published manually.

Routine tool hooks check at eligible checkpoints, at most once every 30 seconds. A shared local cache coalesces chats on the same computer/account, uses incremental GitHub reads, and reconciles every 15 minutes at a checkpoint. Each chat still has its own cursor and identity. Cached board text stays under `~/.patchwork/github/`; private repository content should be treated as private local data. See the root README for the API benchmark and recovery limits.
