import { parse, stringify } from "smol-toml";
import { isDeepStrictEqual } from "node:util";
import { hookConfiguration } from "./connections.js";
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
const normalize = (x) =>
  Array.isArray(x)
    ? x.map(normalize)
    : object(x) &&
        (Object.getPrototypeOf(x) === null ||
          Object.getPrototypeOf(x) === Object.prototype)
      ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, normalize(v)]))
      : x;
const same = (a, b) => isDeepStrictEqual(normalize(a), normalize(b));
export function parseConfig(text) {
  try {
    return parse(text, { integersAsBigInt: true });
  } catch {
    throw new Error(
      "Cannot parse Codex config.toml. Repair its syntax before connecting; no settings were replaced.",
    );
  }
}
export function parseJSON(text) {
  let x;
  try {
    x = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      "Cannot parse agent JSON settings. Repair their syntax before connecting; no settings were replaced.",
    );
  }
  if (!object(x)) throw new Error("Expected a JSON object in agent settings.");
  return x;
}
export function mergeCodex(text, desired, previous, remove = false) {
  const config = parseConfig(text);
  if (config.mcp_servers !== undefined && !object(config.mcp_servers))
    throw new Error("Invalid Codex MCP settings.");
  const existing = config.mcp_servers?.patchwork;
  if (existing && !same(existing, desired) && !same(existing, previous))
    throw new Error(
      "An unowned or modified Patchwork MCP entry exists. Preserve it and resolve this conflict before connecting.",
    );
  if (remove) {
    if (!existing) return text;
    delete config.mcp_servers.patchwork;
  } else {
    if (same(existing, desired)) return text;
    config.mcp_servers ??= {};
    config.mcp_servers.patchwork = desired;
  }
  if (!existing && !remove) {
    const snippet = `\n[mcp_servers.patchwork]\ncommand = ${JSON.stringify(desired.command)}\nargs = ${JSON.stringify(desired.args)}\n`;
    try {
      const appended = text + snippet;
      if (same(parseConfig(appended), config)) return appended;
    } catch {}
  }
  const result = stringify(config, { numbersAsFloat: true });
  if (!same(parseConfig(result), config))
    throw new Error("Could not safely preserve Codex settings.");
  return result;
}
export function mergeClaude(text, root, desired, previous, remove = false) {
  const config = parseJSON(text);
  if (config.projects !== undefined && !object(config.projects))
    throw new Error("Invalid Claude project settings.");
  const project = config.projects?.[root];
  if (project !== undefined && !object(project))
    throw new Error("Invalid Claude project settings.");
  if (project?.mcpServers !== undefined && !object(project.mcpServers))
    throw new Error("Invalid Claude MCP settings.");
  const existing = project?.mcpServers?.patchwork;
  if (existing && !same(existing, desired) && !same(existing, previous))
    throw new Error(
      "An unowned or modified Claude Patchwork entry exists. Resolve the conflict first.",
    );
  if (remove) {
    if (!existing) return text;
    delete project.mcpServers.patchwork;
  } else {
    if (same(existing, desired)) return text;
    config.projects ??= {};
    config.projects[root] ??= {};
    config.projects[root].mcpServers ??= {};
    config.projects[root].mcpServers.patchwork = desired;
  }
  return JSON.stringify(config, null, 2) + "\n";
}
const mcpHook = (h) =>
  h?.type === "mcp_tool" &&
  h.server === "patchwork" &&
  h.tool === "check_board";
export function mergeHooks(
  text,
  entry,
  file,
  previous = [],
  remove = false,
  inline = {},
) {
  const config = parseJSON(text);
  if (config.hooks !== undefined && !object(config.hooks))
    throw new Error("Invalid hook settings.");
  for (const groups of Object.values(inline))
    if (Array.isArray(groups) && groups.some((g) => g.hooks?.some(mcpHook)))
      throw new Error(
        "Patchwork hooks also exist inline in Codex config. Resolve them before installing another source.",
      );
  const desired = hookConfiguration(entry, file).hooks;
  const owned = [
    ...previous,
    ...Object.values(desired).flatMap((groups) =>
      groups.flatMap((g) => g.hooks),
    ),
  ];
  config.hooks ??= {};
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (
      !Array.isArray(groups) ||
      groups.some((g) => !object(g) || !Array.isArray(g.hooks))
    )
      throw new Error(`Invalid ${event} hooks.`);
    config.hooks[event] = groups.flatMap((group) => {
      for (const h of group.hooks)
        if (mcpHook(h) && !owned.some((x) => same(x, h)))
          throw new Error(
            "A modified Patchwork hook exists. Resolve it before changing settings.",
          );
      const hooks = group.hooks.filter((h) => !owned.some((x) => same(x, h)));
      return hooks.length || !group.hooks.length ? [{ ...group, hooks }] : [];
    });
  }
  if (!remove)
    for (const [event, groups] of Object.entries(desired))
      config.hooks[event] = [...(config.hooks[event] || []), ...groups];
  if (same(parseJSON(text), config)) return text;
  return JSON.stringify(config, null, 2) + "\n";
}
