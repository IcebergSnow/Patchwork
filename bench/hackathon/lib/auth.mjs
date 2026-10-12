import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { secret } from "./common.mjs";
import { hookConfiguration, serverConfiguration } from "../../../packages/cli/lib/connections.js";

const fail = (where) => Object.assign(new Error(`Subscription authentication could not be verified (${where}). Use ChatGPT sign-in with the standard OpenAI provider; API keys, custom providers, and unknown modes are refused.`), { code: "SUBSCRIPTION_REQUIRED" });
const present = (value) => value !== undefined && value !== null && value !== "";
export const MCP_ENV = ["GH_TOKEN", "GH_CONFIG_DIR", "PATCHWORK_HOME", "TMPDIR"];
export const AUTH_CONFIG = { model_provider: "openai", forced_login_method: "chatgpt", cli_auth_credentials_store: "file" };

export function subscriptionAuth(text) {
  let auth;
  try { auth = JSON.parse(text); } catch { throw fail("invalid auth file"); }
  // Protect all credential values, including rejected API keys. Never put a
  // parser's input excerpt or the account/credential object in an error.
  const protect = (v) => {
    if (v && typeof v === "object") Object.values(v).forEach(protect);
    else if (typeof v === "string" && v.length > 0) secret(v);
  };
  if (auth && typeof auth === "object") {
    protect(auth.tokens);
    protect(auth.OPENAI_API_KEY);
    protect(auth.CODEX_API_KEY);
  }
  if (auth?.auth_mode !== "chatgpt" || present(auth.OPENAI_API_KEY) || present(auth.CODEX_API_KEY) ||
    ![auth.tokens?.access_token, auth.tokens?.refresh_token, auth.tokens?.id_token].every(v => typeof v === "string" && v.length > 0))
    throw fail("auth file is not exclusively ChatGPT");
  return auth;
}

export function subscriptionConfig(config, isolated = false) {
  if (!config || typeof config !== "object" ||
    (present(config.model_provider) && config.model_provider !== "openai") ||
    (present(config.forced_login_method) && config.forced_login_method !== "chatgpt") ||
    (present(config.cli_auth_credentials_store) && !["file", "auto"].includes(config.cli_auth_credentials_store)) ||
    Object.keys(config.model_providers || {}).length ||
    ["openai_base_url", "api_key", "experimental_bearer_token", "profile"].some(k => present(config[k])) ||
    (present(config.chatgpt_base_url) && !["https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/"].includes(config.chatgpt_base_url)))
    throw fail("provider or authentication override");
  for (const profile of Object.values(config.profiles || {})) subscriptionConfig(profile);
  if (isolated && Object.entries(AUTH_CONFIG).some(([k, v]) => config[k] !== v)) throw fail("isolated auth policy missing");
}
async function configFile(file) {
  try { return parse(await readFile(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw fail("unreadable configuration"); }
}
export async function sourceAuthentication(home) {
  let text;
  try { text = await readFile(path.join(home, "auth.json"), "utf8"); }
  catch { throw fail("source auth file missing or unreadable"); }
  subscriptionAuth(text);
  subscriptionConfig(await configFile(path.join(home, "config.toml")));
  return text;
}
export function subscriptionEnvironment(agent) {
  if (Object.keys(agent.env).some(k => /^OPENAI_|^CODEX_(?!HOME$)/i.test(k)) ||
    agent.env.CODEX_HOME !== agent.codex || agent.env.HOME !== path.dirname(agent.codex))
    throw fail("isolated environment override");
}
export async function agentAuthentication(agent, sourceText) {
  subscriptionEnvironment(agent);
  let text;
  try { text = await readFile(path.join(agent.codex, "auth.json"), "utf8"); }
  catch { throw fail("isolated auth file missing or unreadable"); }
  const source = subscriptionAuth(sourceText), copied = subscriptionAuth(text);
  if (source.tokens.account_id !== copied.tokens.account_id || source.tokens.id_token !== copied.tokens.id_token)
    throw fail("isolated account differs from source");
  subscriptionConfig(await configFile(path.join(agent.codex, "config.toml")), true);
  const project = await configFile(path.join(agent.work, ".codex/config.toml"));
  subscriptionConfig(project);
  const normalize = v => JSON.parse(JSON.stringify(v));
  const expected = { ...serverConfiguration(agent.entry, agent.connection), env_vars: MCP_ENV };
  if (!isDeepStrictEqual(normalize(project.mcp_servers || {}), { patchwork: expected })) throw fail("unexpected MCP configuration");
  let hooks;
  try { hooks = JSON.parse(await readFile(agent.hooks, "utf8")); } catch { throw fail("invalid native hooks"); }
  if (!isDeepStrictEqual(hooks, hookConfiguration(agent.entry, agent.connection))) throw fail("unexpected native hooks");
}
export function subscriptionAccount(result) {
  if (result?.account?.type !== "chatgpt" || result.requiresOpenaiAuth !== true) throw fail("Codex did not report ChatGPT authentication");
  return { mode: "chatgpt", verified: true }; // No email, account ID, or tokens.
}
export async function codexAuthentication(client, agent) {
  let stage = "account/read";
  try {
    const account = subscriptionAccount(await client.call("account/read", { refreshToken: false }));
    stage = "config/read";
    const result = await client.call("config/read", { cwd: agent.work, includeLayers: false });
    subscriptionConfig(result.config, true);
    return account;
  } catch (e) {
    if (e.code === "SUBSCRIPTION_REQUIRED") throw e;
    // Only fixed classifications and a numeric protocol code, never server text.
    const kind = ["method not found", "unknown variant", "missing field", "invalid params", "network", "refresh", "external", "permission", "auth"].find(k => e.message?.toLowerCase().includes(k)) || "unavailable";
    throw fail(`Codex ${stage}: ${kind}${Number.isInteger(e.rpcCode) ? ` (${e.rpcCode})` : ""}`);
  }
}
