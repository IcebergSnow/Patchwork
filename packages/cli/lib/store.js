import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const home = () =>
  path.resolve(
    process.env.PATCHWORK_HOME || path.join(os.homedir(), ".patchwork"),
  );
export async function regular(file) {
  try {
    const s = await lstat(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
      throw new Error(`Refusing linked or non-regular file: ${file}`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
export async function directory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (
    (await lstat(dir)).isSymbolicLink() ||
    (await realpath(dir)) !== path.resolve(dir)
  )
    throw new Error("Refusing a linked configuration directory.");
}
export async function read(file) {
  await regular(file);
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e;
  }
}
export async function write(file, value) {
  await directory(path.dirname(file));
  await regular(file);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    await rename(temp, file);
  } finally {
    await handle.close();
    await unlink(temp).catch(() => {});
  }
}
export const readJSON = async (file) => {
  const text = await read(file);
  return text ? JSON.parse(text) : null;
};
export const writeJSON = (file, value) =>
  write(file, `${JSON.stringify(value, null, 2)}\n`);
export const connectionFile = (root, client) =>
  path.join(home(), "connections", `${digest(`${root}\0${client}`)}.json`);

// Serialize chat delivery and installer updates across processes on this computer.
// OS process death releases abandoned locks; live, slow requests are never stolen.
export async function locked(file, fn) {
  await directory(path.dirname(file));
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      const h = await open(lock, "wx", 0o600);
      await h.writeFile(String(process.pid));
      await h.close();
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let dead = false;
      try {
        const pid = Number(await read(lock));
        if (pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (e) {
            dead = e.code === "ESRCH";
          }
        }
      } catch {}
      if (dead) {
        await unlink(lock).catch(() => {});
        continue;
      }
      if (attempt >= 100)
        throw new Error(
          "Another Patchwork operation is still running. Retry shortly.",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

export async function loadConnection(file, enabled = true) {
  const c = await readJSON(file);
  if (!c || c.version !== 1)
    throw new Error("Run Patchwork connect in this project first.");
  if (enabled && !c.enabled)
    throw new Error(
      "Patchwork is disconnected in this project. Run connect to enable it.",
    );
  return c;
}
