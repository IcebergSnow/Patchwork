# Contributing to Patchwork

Patchwork is a local Node.js connector backed by GitHub Issues. Keep changes focused on communication, delivery reliability, and simple setup. Preserve independent chat identities, user-defined scope, and existing project configuration.

## Development

Use Node.js 22.13+ and npm. From the repository root:

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run measure:api
npm run test:e2e
```

| Command | Checks |
| --- | --- |
| `npm test` | Configuration, permissions, delivery, concurrency, recovery, and MCP behavior using local fixtures |
| `npm run build` | JavaScript syntax; no compilation step |
| `npm run measure:api` | Deterministic GitHub request-count benchmark |
| `npm run test:e2e` | Packs and installs the CLI outside the repository, then checks the executable and npm shim; requires npm registry access |

CI runs these checks on Linux, macOS, and Windows. Add regression tests for behavior changes. Documentation changes should keep command examples, links, and platform differences accurate.

To try source changes, invoke the CLI by its absolute path from a separate project's Git worktree:

```sh
node /ABSOLUTE/PATH/Patchwork/packages/cli/bin/patchwork.js connect --repo OWNER/REPO --client codex
```

This connects to a real GitHub board. Use a dedicated repository you are authorized to modify, disconnect afterward, and keep machine-specific configuration out of Git. Set `PATCHWORK_HOME` to isolate local connector state when needed.

## Source map

| Path | Responsibility |
| --- | --- |
| `packages/cli/bin/patchwork.js` | CLI commands and MCP/hook entry points |
| `packages/cli/lib/connect.js` | Installation, saved connections, status, and retirement |
| `packages/cli/lib/ui.js` | Guided menu, readable status, and setup prompts |
| `packages/cli/lib/config.js`, `connections.js` | Configuration merging and native hook definitions |
| `packages/cli/lib/board.js` | GitHub records, acknowledgments, and intervention calculation |
| `packages/cli/lib/runtime.js` | Chat identities, delivery cursors, and tool calls |
| `packages/cli/lib/github.js`, `sync.js` | GitHub transport, incremental cache, verification, and backoff |
| `packages/cli/lib/store.js` | Local files and process locks |
| `packages/cli/lib/disconnect-picker.js`, `previews.js` | Local chat selection and message previews |
| `packages/cli/lib/instructions.js` | Built-in guidance and defaults for new boards |
| `tests/`, `scripts/` | Regression tests, package checks, and release validation |

See the [technical reference](docs/reference.md) for delivery guarantees, security boundaries, and known limits. Keep the root README focused on setup and everyday usage; the package README must also work on npm without repository-relative links.

## Releases

The [Check and publish Patchwork workflow](.github/workflows/check.yml) publishes **explicitly bumped versions** from `main` after all platform checks pass. Ordinary commits and retries skip versions already on npm. The workflow does not bump versions, commit files, or create Git tags.

For a release:

1. Make and verify the changes on a development branch.
2. Bump the CLI version:

   ```sh
   npm version patch --workspace packages/cli --no-git-tag-version --ignore-scripts
   ```

3. Commit `packages/cli/package.json` and `package-lock.json` with the changes, then merge into `main`. Use `minor` or `major` when appropriate.
4. Check the workflow's publish result and confirm the exact version on npm:

   ```sh
   npm view @icebergsnow/patchwork-cli@VERSION version
   npx @icebergsnow/patchwork-cli@VERSION --help
   ```

   Replace `VERSION` with the release number. On PowerShell, use `npm.cmd` and `npx.cmd` if script execution is blocked.

Existing connections continue using their installed executable. Users adopt a release by rerunning `connect` with `@latest` in each project and reloading the coding app.

### npm authentication

Publishing uses npm trusted publishing through GitHub Actions OIDC. The package's trusted publisher must match:

| Field | Value |
| --- | --- |
| GitHub owner | `IcebergSnow` |
| Repository | `Patchwork` |
| Workflow filename | `check.yml` |
| Environment | None |
| Publishing permission | Direct `npm publish` |

Manage this in the npm package settings; see [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/). Retry a failed publish with the workflow's **Run workflow** action on `main` after resolving authentication or registry access. A GitHub commit alone does not confirm publication.

For an authorized manual fallback, run the same checks, inspect `npm pack --workspace packages/cli --dry-run`, then use `npm login` and `npm publish --workspace packages/cli --access public --ignore-scripts`. Verify the exact version afterward. The automated workflow skips versions already published manually.

The package is currently marked `UNLICENSED`; no reuse license has been granted.
