import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  lstat,
  realpath,
  readdir,
  rmdir,
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

const heldLocks = new AsyncLocalStorage();
function dead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === "ESRCH";
  }
  return false;
}
// Lock order: connection -> sessions -> GitHub account. Never steal a live
// process's lock. Publish a nonempty directory atomically, so a crash cannot
// leave an ownerless acquisition. Unique owner names make stale cleanup safe
// even when another waiter has already replaced the abandoned directory.
export async function locked(file, fn) {
  file = path.resolve(file);
  const held = heldLocks.getStore() || new Set();
  if (held.has(file)) throw new Error("Recursive Patchwork lock acquisition.");
  await directory(path.dirname(file));
  const lock = `${file}.lock`;
  const owner = `${process.pid}-${crypto.randomUUID()}`;
  const candidate = `${lock}.${owner}`;
  await mkdir(candidate, { mode: 0o700 });
  const handle = await open(path.join(candidate, owner), "wx", 0o600);
  await handle.close();
  const started = Date.now();
  try {
    for (;;) {
      try {
        await rename(candidate, lock);
        break;
      } catch (e) {
        if (
          !["EEXIST", "ENOTEMPTY", "ENOTDIR", "EPERM", "EACCES"].includes(
            e.code,
          )
        )
          throw e;
        try {
          const stat = await lstat(lock);
          if (stat.isSymbolicLink()) throw new Error("Refusing a linked lock.");
          if (stat.isDirectory()) {
            const owners = await readdir(lock);
            for (const name of owners) {
              if (
                /^\d+-[a-f0-9-]{36}$/.test(name) &&
                dead(Number(name.split("-")[0]))
              )
                await unlink(path.join(lock, name)).catch((e) => {
                  if (e.code !== "ENOENT") throw e;
                });
            }
            // rmdir cannot remove a newly published, nonempty lock.
            await rmdir(lock).catch((e) => {
              if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(e.code)) throw e;
            });
          } else if (stat.isFile()) {
            // Compatibility with the previous PID-file lock. unlink cannot
            // remove a new directory lock if another cleaner won the race.
            if (dead(Number(await read(lock))))
              await unlink(lock).catch(() => {});
          } else {
            throw new Error("Invalid Patchwork lock.");
          }
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (Date.now() - started >= 60_000) {
          const error = new Error(
            "Another Patchwork operation is still running. Retry shortly; no delivery cursor was advanced.",
          );
          error.code = "LOCK_BUSY";
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 75 + Math.random() * 50),
        );
      }
    }
    try {
      return await heldLocks.run(new Set([...held, file]), fn);
    } finally {
      await unlink(path.join(lock, owner));
      await rmdir(lock).catch((e) => {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(e.code)) throw e;
      });
    }
  } finally {
    await unlink(path.join(candidate, owner)).catch(() => {});
    await rmdir(candidate).catch(() => {});
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
