# Patchwork CLI

Connect an existing Codex app or CLI to a Patchwork room. No Patchwork checkout or Cloudflare account is needed by teammates.

**Release status: prepared for publication; not published by this change.** The command below becomes available only after the maintainer publishes this exact package/version. The website shows it as unavailable until the host enables the release.

## Connect

Requires Node.js 22.13+ with npm, Git, and a current Codex version with native MCP hooks.

1. Join the room on its website. Open **Room settings → Connect Codex**.
2. In a terminal inside your coding project's Git worktree, run (after publication):

   ```sh
   npx @icebergsnow/patchwork-cli@0.1.0 connect --server https://YOUR-WORKER.workers.dev
   ```

3. Paste the pairing code at the hidden prompt. The code expires in ten minutes and works once. Clicking Connect Codex again invalidates your previous unused code.
4. Restart Codex or open a new chat in that project. Trust the project and review the new hooks in Codex's hook controls (`/hooks` in the CLI). **Board checked** in Patchwork confirms a successful hook. The installer verifies authenticated MCP connectivity; it cannot approve hooks or prove Codex loaded them.

Windows PowerShell and macOS terminals use the same command. It targets the Git worktree root even when run in a subdirectory. It uses Node's built-in HTTPS client and does not run shell scripts, download executables, or change global Codex settings. HTTP is allowed only for localhost development.

## Files and repeat runs

- `.codex/config.toml`: adds the existing Patchwork HTTP MCP configuration with a room-bound token.
- `.codex/hooks.json`: merges the existing session-start, prompt, and tool-checkpoint hooks. Other hooks remain intact.
- `.codex/patchwork.json`: private recovery credentials for this connection.
- `.codex/.gitignore`: excludes credentials, temporary files, and the installer lock. It contains no secrets and can be committed.

Credentials are created with owner-only permissions on macOS/Linux. On Windows they inherit the project directory's ACLs; use a private user-owned worktree. The CLI refuses tracked credential files, symlinks, hard-linked files, malformed configuration, and conflicting connections before asking for a code. It does not automatically untrack files. Existing settings and other MCP servers are preserved. Comments/formatting are retained when appending; inline TOML tables or an explicit replacement may require reserialization with values preserved.

Rerun the same command to verify or repair the saved connection without another pairing code or duplicate hooks. The token is saved immediately after redemption, before verification/configuration, so an interrupted installation can normally resume. If the redemption response itself is lost, get a new code; revoke any unused connection in Room settings. Never paste tokens into chat or commands.

For a revoked token or an intentional room change, obtain a new code and add `--re-pair`. This replaces only the project's Patchwork connection; it does not revoke the old agent. If Patchwork hooks already exist inline in `config.toml`, move those entries to `hooks.json` first to avoid double delivery. Disabled hooks, disabled servers, tool restrictions, managed policies, and inherited global connections remain under Codex's control.

If an installer was forcibly stopped and left `.codex/.patchwork-install.lock`, remove that file only after confirming no installer is running, then retry. Git ignores prevent normal accidental commits, not `git add --force`; never force-add credential files.

## Publish (maintainer only)

The proposed package name is `@icebergsnow/patchwork-cli`. Confirm ownership of that npm scope or change `name` in `packages/cli/package.json`, the fallback command in `web/main.ts`, and these instructions. The repository has no license grant; the package currently declares `UNLICENSED`. Choose a license before publication if you intend to grant reuse rights.

From the repository root:

```sh
npm ci
npm test
npm run build
npm run test:e2e
npm pack --workspace packages/cli --dry-run
npm login
npm publish --workspace packages/cli --access public
npm view @icebergsnow/patchwork-cli@0.1.0 version
npx @icebergsnow/patchwork-cli@0.1.0 --help
```

Publishing needs npm account/scope permission and any required 2FA. Use a new version for each release. The executable has a Node shebang and npm supplies the Windows command shim. The package includes only `bin/`, `lib/`, README, and its manifest; the two configuration generators are shared directly with Patchwork's web app. There are no install scripts or repository-relative runtime imports.

After confirming the package is available, set this Worker variable in `wrangler.jsonc` and deploy the app with migration `0005_pairing.sql` applied:

```json
"vars": { "PATCHWORK_CLI_PACKAGE": "@icebergsnow/patchwork-cli@0.1.0" }
```

This enables the copyable one-command installer in Room settings. It must refer to an exact published version, not `latest`. Leaving it unset keeps the release warning and manual setup available. Do not enable it before verifying publication.

Before publication, maintainers can test the source executable with `node packages/cli/bin/patchwork.js connect --server http://127.0.0.1:8787` from the repository, or use its absolute path from a disposable Git worktree. This local development command is not the teammate distribution flow.
