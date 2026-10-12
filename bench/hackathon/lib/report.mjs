import { writeFile } from "node:fs/promises";
import path from "node:path";
import { save, redact } from "./common.mjs";
export async function report(run) {
  const m = run.manifest;
  const checks = Object.entries(m.evidence).map(([key, value]) => `| ${key} | ${value ? "PASS" : "FAIL"} |`).join("\n");
  const followup = m.followupValidation
    ? `\n## Configuration follow-up\n\nA credential-free native Codex MCP probe verified forwarding of ${m.followupValidation.variables.join(", ")}. It used ${m.followupValidation.modelTurns} model turns and ${m.followupValidation.githubCalls} GitHub calls. The full preflight has not been rerun after this fix.\n`
    : "";
  const text = `# ${m.kind === "local-check" ? "Local Codex configuration check (no live trial)" : "Patchwork native hook preflight"}\n\nResult: **${m.status}**\n\nRun: ${m.runId}\nRepository: ${m.repo}\nModel: ${m.model}; reasoning: ${m.reasoning}\nBudget: ${m.runtimeSeconds} seconds shared by both sessions; ${m.tokenBudget} reported tokens\nPhase 0 complete: ${m.phase0Complete === true ? "yes" : "no"}\nAuthentication: ${m.authentication?.verified ? "ChatGPT verified; API-key fallback disabled" : "not recorded"}\nCodex: ${m.codexVersion || "not started"}\n\n${m.blocker || ""}\n\n| Directly observed check | Result |\n| --- | --- |\n${checks}\n\n## Sessions\n\n${m.agents.map((a) => `- ${a.id}: ${a.status}; thread ${a.threadId || "not created"}; Patchwork ${a.chatIds?.join(", ") || "not registered"}; usage ${a.usage ? JSON.stringify(a.usage) : "unavailable"}`).join("\n")}\n\n## Cleanup\n\n${m.cleanup.complete ? "Operational resources cleaned; report retained." : "INCOMPLETE: do not reuse this run for another experiment."}\n${m.cleanup.errors.map((e) => `- ${e}`).join("\n")}\n\nClosed run requests: ${(m.closedRequests || []).join(", ") || "none"}\n\nRemote history retained (never erased):\n${(m.remoteArtifacts || []).map((a) => `- ${a.url || `${a.type} ${a.id}`}`).join("\n")}\n\n## Limits\n\n${m.limitations.map((s) => `- ${s}`).join("\n")}\n\nThis preflight tests native integration only. No baseline comparison or claim of effectiveness was made.\n`;
  await save(path.join(run.dir, "report.json"), JSON.parse(redact(m)));
  await writeFile(path.join(run.dir, "report.md"), redact(text + followup), { mode: 0o600 });
  return path.join(run.dir, "report.md");
}
