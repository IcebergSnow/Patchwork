#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { rm, readdir } from "node:fs/promises";
import { authorize, defaultOutput, json, ownedDirectory, repoName, runId, save } from "./lib/common.mjs";
import { preflight, cleanup } from "./lib/preflight.mjs";
import { report } from "./lib/report.mjs";
import { locked, digest } from "../../packages/cli/lib/store.js";
import { localCheck } from "./lib/local-check.mjs";

const HELP = `Patchwork simulator — Phase 0 native hook feasibility

npm run sim -- preflight --repo OWNER/TEST_REPO --sandbox-repo --allow-live
npm run sim -- check-local --codex PATH
npm run sim -- report --run RUN_ID
npm run sim -- reset --run RUN_ID --allow-live
npm run sim -- delete --run RUN_ID --yes

Options: --output DIR --model gpt-6-luna --reasoning low --seconds 300 --tokens 250000 --codex PATH
--setup-only checks configuration without model prompts; native SessionStart may wait for a turn.
preflight is currently macOS only, using enforced per-process isolation.
--sandbox-repo attests the explicitly named repository is a dedicated test sandbox.
--allow-live authorizes GitHub writes and (preflight only) bounded model usage.
reset retires only this run's chats and removes owned temporary environments.
delete requires completed cleanup and removes only this run's local reports.
check-local uses read-only Codex account discovery, with no model turns or GitHub access. It cannot pass Phase 0.
Only ChatGPT authentication with the standard OpenAI provider is allowed.
No automatic repository deletion. No live runs in ordinary tests or CI.
preflight runs a UserPromptSubmit round trip, then a separate PostToolUse round trip.
Both paths and cleanup must pass. Idle waits do not repeatedly call models.
Phase 1 requires separate approval even after a passing preflight.
`;
try {
  const { positionals, values: o } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, repo: { type: "string" }, run: { type: "string" }, output: { type: "string" },
    model: { type: "string" }, reasoning: { type: "string" }, seconds: { type: "string" }, tokens: { type: "string" }, codex: { type: "string" },
    "allow-live": { type: "boolean" }, "sandbox-repo": { type: "boolean" }, yes: { type: "boolean" }, "setup-only": { type: "boolean" },
  } });
  const [cmd] = positionals;
  if (!cmd || o.help) console.log(HELP);
  else if (positionals.length !== 1) throw new Error("Use one simulator command.");
  else if (cmd === "check-local") {
    if ((await localCheck(o)).manifest.status !== "PASS") process.exitCode = 1;
  } else if (cmd === "preflight") {
    authorize(o); repoName(o.repo);
    const output = path.resolve(o.output || defaultOutput);
    await locked(path.join(output, "locks", digest(o.repo.toLowerCase())), async () => {
      for (const name of await readdir(output).catch((e) => { if (e.code === "ENOENT") return []; throw e; })) {
        if (!name.startsWith("sim-")) continue;
        const previous = await json(path.join(output, name, "manifest.json"));
        if (!previous.cleanup.complete && previous.repo.toLowerCase() === o.repo.toLowerCase()) throw new Error(`Unfinished cleanup in ${name}. Run reset first.`);
      }
      const { manifest } = await preflight(o);
      if (manifest.status !== "PASS" || !manifest.cleanup.complete) process.exitCode = 1;
    });
  } else if (["report", "reset", "delete"].includes(cmd)) {
    const dir = path.join(path.resolve(o.output || defaultOutput), runId(o.run));
    await ownedDirectory(dir, o.run);
    const manifest = await json(path.join(dir, "manifest.json"));
    if (manifest.runId !== o.run || manifest.version !== 1) throw new Error("Invalid run manifest.");
    const run = { dir, manifest, persist: () => save(path.join(dir, "manifest.json"), manifest) };
    if (cmd === "reset") {
      if (!o["allow-live"]) throw new Error("reset requires --allow-live to authorize retirement on GitHub.");
      await locked(path.join(path.dirname(dir), "locks", digest(manifest.repo.toLowerCase())), () => cleanup(run)); console.log(await report(run));
      if (!manifest.cleanup.complete) process.exitCode = 1;
    } else if (cmd === "delete") {
      if (!o.yes || !manifest.cleanup.complete) throw new Error("delete requires --yes and completed cleanup; run reset first.");
      await rm(dir, { recursive: true });
      console.log("Removed only the selected local run reports. GitHub history remains.");
    } else console.log(await report(run));
  } else if (cmd === "compare") throw new Error("Phase 1 is gated on a passing real native-hook preflight. No simulated fallback.");
  else throw new Error(HELP);
} catch (e) { console.error(e.message); process.exitCode = 1; }
