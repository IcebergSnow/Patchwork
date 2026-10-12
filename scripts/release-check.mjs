import { readFile, appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const stable = (version) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
const parts = (version) => version.split(".").map(Number);
const compare = (a, b) => {
  const x = parts(a), y = parts(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// An existing version is a successful no-op, including after a workflow retry.
// Registry failures must never be mistaken for an unpublished version.
export function shouldPublish(pkg, registry) {
  if (!stable(pkg.version) || !parts(pkg.version).every(Number.isSafeInteger))
    throw new Error("Automatic publishing requires an explicit stable x.y.z version.");
  if (registry.name !== pkg.name || !registry.versions ||
      typeof registry.versions !== "object" || Array.isArray(registry.versions) ||
      !registry["dist-tags"]?.latest || !registry.versions[registry["dist-tags"].latest])
    throw new Error("Cannot verify the existing npm package. No release was authorized.");
  if (Object.hasOwn(registry.versions, pkg.version)) return false;
  if (Object.keys(registry.versions).some((v) => stable(v) && compare(v, pkg.version) >= 0))
    throw new Error("Bump the CLI version above published stable versions before releasing.");
  return true;
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      !["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME) ||
      !process.env.GITHUB_OUTPUT || !process.env.GITHUB_STEP_SUMMARY)
    throw new Error("Release checking must run in the main-branch publishing job.");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const mainHead = execFileSync("git", ["ls-remote", "origin", "refs/heads/main"], {
    encoding: "utf8", timeout: 30_000,
  }).trim().split(/\s+/)[0];
  let publish = false, summary;
  if (head !== process.env.GITHUB_SHA || head !== mainHead) {
    summary = "Skipped an outdated checkout; the newer main commit must pass its own checks.";
  } else {
    const pkg = JSON.parse(await readFile("packages/cli/package.json", "utf8"));
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`Cannot verify npm release metadata (HTTP ${response.status}). Retry after registry access is restored; first packages must be published manually.`);
    publish = shouldPublish(pkg, await response.json());
    summary = publish
      ? `Ready to publish ${pkg.name}@${pkg.version} after all platform checks passed.`
      : `${pkg.name}@${pkg.version} already exists. No publish; bump the CLI version explicitly for a new release.`;
  }
  await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
