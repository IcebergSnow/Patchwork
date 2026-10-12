import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "patchwork-package-")),
  );
function npm(args, cwd) {
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error("Run through npm run test:e2e.");
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: path.join(dir, "npm-cache") },
  });
  if (r.status !== 0) throw new Error(r.stderr || "npm failed");
  return r.stdout;
}
try {
  const packed = JSON.parse(
    npm(
      [
        "pack",
        "--workspace",
        "packages/cli",
        "--json",
        "--pack-destination",
        dir,
      ],
      root,
    ),
  )[0];
  assert(
    packed.files.every((f) =>
      /^(bin\/|lib\/|README.md$|package.json$)/.test(f.path),
    ),
  );
  npm(
    [
      "install",
      "--prefix",
      dir,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(dir, packed.filename),
    ],
    root,
  );
  const pkg = path.join(dir, "node_modules/@icebergsnow/patchwork-cli");
  const manifest = JSON.parse(
    await readFile(path.join(pkg, "package.json"), "utf8"),
  );
  const cli = path.join(pkg, manifest.bin.patchwork);
  const result = spawnSync(process.execPath, [cli, "--help"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert(result.stdout.includes("disconnect"));
  assert(result.stdout.includes("disconnect --select"));
  assert(result.stdout.includes("GitHub"));
  const picker = spawnSync(process.execPath, [cli, "disconnect", "--select"], {
    cwd: dir,
    encoding: "utf8",
    input: "1\ny\n",
  });
  assert.equal(picker.status, 1);
  assert.match(picker.stderr, /requires a terminal/);
  // Also exercise the executable installed by npm, including its Windows shim.
  const shim = path.join(
    dir,
    "node_modules/.bin",
    process.platform === "win32" ? "patchwork.cmd" : "patchwork",
  );
  const executable = spawnSync(
    process.platform === "win32" ? `"${shim}"` : shim,
    ["--help"],
    { cwd: dir, encoding: "utf8", shell: process.platform === "win32" },
  );
  assert.equal(executable.status, 0, executable.stderr);
  console.log(
    `Packaged ${packed.files.length} files; installed outside repository; Node executable and npm shim passed.`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
