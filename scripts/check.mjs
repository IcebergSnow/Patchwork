import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
async function check(dir) {
  for (const file of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, file.name);
    if (file.isDirectory()) await check(full);
    else if (/\.m?js$/.test(file.name)) {
      const r = spawnSync(process.execPath, ["--check", full], {
        stdio: "inherit",
      });
      if (r.status !== 0) process.exit(r.status || 1);
    }
  }
}
for (const dir of ["packages/cli/bin", "packages/cli/lib", "tests", "scripts"])
  await check(dir);
console.log(
  "All JavaScript source checked. No compilation or cloud deployment is required.",
);
