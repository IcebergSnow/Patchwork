#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { rm, readdir } from "node:fs/promises";
import { authorize, defaultOutput, json, ownedDirectory, repoName, runId, save } from "./lib/common.mjs";
import { preflight, cleanup } from "./lib/preflight.mjs";
import { report } from "./lib/report.mjs";
import { locked, digest } from "../../packages/cli/lib/store.js";
import { localCheck } from "./lib/local-check.mjs";
import { setupRepositories, validatePair, freshPair } from "./lib/repositories.mjs";
import { trial } from "./lib/trial.mjs";
import { cleanupTrial } from "./lib/phase1-cleanup.mjs";
import { trialReport, compare, loadRun } from "./lib/trial-report.mjs";

const HELP = `Patchwork simulator — native hook preflight and booking comparison

npm run sim -- setup --baseline-repo OWNER/BASELINE --patchwork-repo OWNER/ENABLED --allow-create
npm run sim -- validate-setup --baseline-repo OWNER/BASELINE --patchwork-repo OWNER/ENABLED
npm run sim -- fresh-pair --from-run PREVIOUS_PHASE1_RUN_ID --allow-create
npm run sim -- trial --condition baseline --repo OWNER/BASELINE --peer-repo OWNER/ENABLED --sandbox-repo --allow-live
npm run sim -- trial --condition patchwork --repo OWNER/ENABLED --baseline-run RUN_ID --sandbox-repo --allow-live
npm run sim -- compare --baseline-run RUN_ID --patchwork-run RUN_ID

npm run sim -- preflight --repo OWNER/TEST_REPO --sandbox-repo --allow-live
npm run sim -- check-local --codex PATH
npm run sim -- report --run RUN_ID
npm run sim -- reset --run RUN_ID --allow-live
npm run sim -- delete --run RUN_ID --yes

Options: --output DIR --model gpt-6-luna --reasoning low --seconds 300 --tokens 250000 --codex PATH
--setup-only checks configuration without model prompts; native SessionStart may wait for a turn.
preflight is currently macOS only, using enforced per-process isolation.
--sandbox-repo attests the explicitly named repository is a dedicated test sandbox.
--allow-live authorizes GitHub writes and bounded model usage for preflight/trial.
reset retries owned-resource cleanup; it never resets main or deletes repository history.
fresh-pair creates uniquely named private sandboxes at the previous run's original starter commit.
delete requires completed cleanup and removes only this run's local reports.
check-local uses read-only Codex account discovery, with no model turns or GitHub access. It cannot pass Phase 0.
Only ChatGPT authentication with the standard OpenAI provider is allowed.
No automatic repository deletion. No live runs in ordinary tests or CI.
preflight runs a UserPromptSubmit round trip, then a separate PostToolUse round trip.
Both paths and cleanup must pass. Idle waits do not repeatedly call models.
Phase 1 defaults to 900 seconds / 1000000 reported tokens per condition (three agents combined).
check-local --phase1 verifies three isolated sessions, with --condition baseline or patchwork.
Phase 0 remains INCONCLUSIVE; Phase 1 is separately authorized. No live runs without opt-in.
`;
try {
  const { positionals, values: o } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, repo: { type: "string" }, run: { type: "string" }, output: { type: "string" },
    model: { type: "string" }, reasoning: { type: "string" }, seconds: { type: "string" }, tokens: { type: "string" }, codex: { type: "string" },
    "allow-live": { type: "boolean" }, "sandbox-repo": { type: "boolean" }, yes: { type: "boolean" }, "setup-only": { type: "boolean" },
    "baseline-repo": { type: "string" }, "patchwork-repo": { type: "string" }, "allow-create": { type: "boolean" },
    "from-run": { type: "string" },
    condition: { type: "string" }, "peer-repo": { type: "string" }, "baseline-run": { type: "string" }, "patchwork-run": { type: "string" }, phase1: { type: "boolean" },
  } });
  const [cmd] = positionals;
  if (!cmd || o.help) console.log(HELP);
  else if (positionals.length !== 1) throw new Error("Use one simulator command.");
  else if (cmd === "setup") console.log(JSON.stringify(await setupRepositories(o),null,2));
  else if (cmd === "fresh-pair") {
    const output=path.resolve(o.output||defaultOutput);
    await locked(path.join(output,'locks','phase1-comparison'),async()=>console.log(JSON.stringify(await freshPair(o),null,2)));
  }
  else if (cmd === "validate-setup") console.log(JSON.stringify(await validatePair(o["baseline-repo"],o["patchwork-repo"]),null,2));
  else if (cmd === "check-local") {
    if ((await localCheck(o)).manifest.status !== "PASS") process.exitCode = 1;
  } else if (cmd === "trial") {
    authorize(o); repoName(o.repo);
    const output=path.resolve(o.output||defaultOutput);
    // Serialize BOTH conditions locally, even when they target distinct repos.
    await locked(path.join(output,"locks","phase1-comparison"),async()=>{
      for(const name of await readdir(output).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
        if(!name.startsWith('sim-'))continue;
        const previous=await json(path.join(output,name,'manifest.json'));
        if(previous.kind==='comparison'&&!previous.cleanup.complete)throw new Error(`Unfinished Phase 1 cleanup in ${name}; run reset first.`);
      }
      const baseline=o['baseline-run']?(await loadRun(output,o['baseline-run'])).manifest:undefined;
      const {manifest}=await trial(o,baseline);
      if(manifest.status!=='PASS'||!manifest.cleanup.complete)process.exitCode=1;
    });
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
      await locked(path.join(path.dirname(dir), "locks", manifest.kind==='comparison'?'phase1-comparison':digest(manifest.repo.toLowerCase())), () => manifest.kind==='comparison'?cleanupTrial(run):cleanup(run)); console.log(await (manifest.kind==='comparison'?trialReport:report)(run));
      if (!manifest.cleanup.complete) process.exitCode = 1;
    } else if (cmd === "delete") {
      if (!o.yes || !manifest.cleanup.complete) throw new Error("delete requires --yes and completed cleanup; run reset first.");
      await rm(dir, { recursive: true });
      console.log("Removed only the selected local run reports. GitHub history remains.");
    } else console.log(await (manifest.kind==='comparison'?trialReport:report)(run));
  } else if (cmd === "compare") {
    const output=path.resolve(o.output||defaultOutput);
    console.log(await compare(await loadRun(output,o['baseline-run']),await loadRun(output,o['patchwork-run']),output));
  }
  else throw new Error(HELP);
} catch (e) { console.error(e.message); process.exitCode = 1; }
