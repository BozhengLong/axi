import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isObject } from "./api/types.ts";
import { loadConfig, requestPolicy, type APIConfig, type Protocol } from "./config.ts";

export const presets = {
  anthropic: { label: "Claude API", protocol: "anthropic-messages", url: "https://api.anthropic.com", model: "claude-opus-5-5", env: "ANTHROPIC_API_KEY" },
  openai: { label: "OpenAI API", protocol: "openai-responses", url: "https://api.openai.com/v1", model: "gpt-5.4-mini", env: "OPENAI_API_KEY" },
  deepseek: { label: "DeepSeek", protocol: "chat-completions", url: "https://api.deepseek.com", model: "deepseek-flash", env: "DEEPSEEK_API_KEY" },
  openrouter: { label: "OpenRouter", protocol: "chat-completions", url: "https://openrouter.ai/api/v1", model: "openai/gpt-5.4-mini", env: "OPENROUTER_API_KEY" },
  bailian: { label: "Bailian Coding Plan (China mainland)", protocol: "chat-completions", url: "https://coding.dashscope.aliyuncs.com/v1", model: "qwen3.7-plus", env: "BAILIAN_CODING_PLAN_API_KEY" },
  ollama: { label: "Ollama (local)", protocol: "chat-completions", url: "http://127.0.0.1:11434/v1", model: "qwen3:8b", env: "" },
} as const;
export type Preset = keyof typeof presets;
export const protocols: readonly Protocol[] = ["anthropic-messages", "openai-responses", "chat-completions"];
export type Auth =
  | { type: "env"; name: string }
  | { type: "keychain"; ref: string }
  | { type: "prompt" | "none" };
export interface Profile {
  provider: Preset | "custom";
  protocol: Protocol;
  model: string;
  baseUrl?: string;
  auth: Auth;
  verified?: boolean;
}
export interface Profiles {
  schema: 1;
  defaultProfile: string | null;
  profiles: Record<string, Profile>;
}
export type Env = Record<string, string | undefined>;
export type SecretReader = (prompt: string) => Promise<string | null>;
const service = "axi.model";
export const credentialOptions = (name: string) => ({ service, name });
export const profileNameValid = (name: unknown): name is string => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name);
export const envNameValid = (name: unknown): name is string => typeof name === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);

export function profilePath(env: Env = process.env): string {
  const home = env.XDG_CONFIG_HOME;
  return join(home && isAbsolute(home) ? home : join(homedir(), ".config"), "axi", "config.json");
}

export function endpoint(profile: Profile): string {
  const preset = profile.provider === "custom" ? undefined : presets[profile.provider];
  const base = profile.baseUrl ?? preset?.url;
  if (preset && profile.protocol !== preset.protocol) throw new Error("提供商与协议不匹配。");
  if (preset && profile.provider !== "ollama" && base !== preset.url) throw new Error("官方预设使用固定地址。请用自定义配置设置其他地址。");
  let url: URL;
  try { url = new URL(base ?? ""); } catch { throw new Error("模型地址无效。"); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && local)) {
    throw new Error("模型地址需要 HTTPS。本机回环地址可用 HTTP。地址不能含认证信息、查询参数或片段。");
  }
  if ((profile.provider === "ollama" && (!local || profile.auth.type !== "none")) || (profile.auth.type === "none" && !local)) {
    throw new Error("免密配置只允许连接本机。Ollama 预设使用本机免密认证。");
  }
  const path = url.pathname.replace(/\/+$/, "");
  const suffix = profile.protocol === "anthropic-messages" ? "/messages" : profile.protocol === "openai-responses" ? "/responses" : "/chat/completions";
  const root = profile.protocol !== "chat-completions" && !path ? "/v1" : path;
  url.pathname = path.endsWith(suffix) ? path : root + suffix;
  return url.toString();
}

function parseProfile(value: unknown): Profile {
  if (!isObject(value) || typeof value.provider !== "string" ||
      !(Object.hasOwn(presets, value.provider) || value.provider === "custom") ||
      !protocols.some(protocol => protocol === value.protocol) || typeof value.model !== "string" ||
      !value.model.trim() || value.model !== value.model.trim() ||
      (value.baseUrl !== undefined && typeof value.baseUrl !== "string") ||
      (value.verified !== undefined && typeof value.verified !== "boolean") || !isObject(value.auth)) {
    throw new Error("模型配置格式无效。");
  }
  const source = value.auth;
  let auth: Auth;
  if (source.type === "env" && envNameValid(source.name)) auth = { type: "env", name: source.name };
  else if (source.type === "keychain" && typeof source.ref === "string" && /^[0-9a-f-]{36}$/.test(source.ref)) auth = { type: "keychain", ref: source.ref };
  else if (source.type === "prompt" || source.type === "none") auth = { type: source.type };
  else throw new Error("认证配置无效。");
  const profile: Profile = {
    provider: value.provider as Profile["provider"], protocol: value.protocol as Protocol,
    model: value.model, baseUrl: value.baseUrl, auth, verified: value.verified,
  };
  endpoint(profile);
  return profile;
}

export function readProfiles(path: string): { raw: string | null; data: Profiles } {
  let raw: string;
  try {
    const file = lstatSync(path);
    if (!file.isFile()) throw new Error("配置必须是普通文件。");
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: null, data: { schema: 1, defaultProfile: null, profiles: {} } };
    throw error;
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error("配置文件不是有效的 JSON。"); }
  if (!isObject(data) || data.schema !== 1 || !isObject(data.profiles) ||
      !(data.defaultProfile === null || profileNameValid(data.defaultProfile))) throw new Error("配置文件结构无效。");
  const profiles = Object.fromEntries(Object.entries(data.profiles).map(([name, value]) => {
    if (!profileNameValid(name)) throw new Error("模型配置名称无效。");
    return [name, parseProfile(value)];
  }));
  if (data.defaultProfile !== null && !Object.hasOwn(profiles, data.defaultProfile)) throw new Error("默认模型配置不存在。");
  return { raw, data: { schema: 1, defaultProfile: data.defaultProfile, profiles } };
}

export function saveProfiles(path: string, original: string | null, data: Profiles): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + ".lock";
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("配置正在保存。请检查是否有其他 axi setup 进程。");
    throw error;
  }
  try {
    if (readProfiles(path).raw !== original) throw new Error("配置已更新。请重新运行 axi setup。");
    const temp = join(lock, "config.json");
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx", flush: true });
    renameSync(temp, path);
  } finally {
    rmSync(lock, { recursive: true });
  }
}

export function assembleConfig(profile: Profile, name: string, key: string, env: Env): APIConfig {
  if (profile.auth.type !== "none" && (!key.trim() || /[\r\n]/.test(key))) throw new Error("需要可用的 API Key。请运行 axi setup。");
  if (profile.provider === "bailian" && !key.trim().startsWith("sk-sp-")) throw new Error("百炼 Coding Plan 需要专属 Key（sk-sp-）。");
  return {
    url: endpoint(profile), apiKey: key.trim(), model: profile.model,
    protocol: profile.protocol, provider: profile.provider, profile: name,
    secretEnv: profile.auth.type === "env" ? profile.auth.name : undefined,
    upstreamOAuth: false, ...requestPolicy(env),
  };
}

export async function loadProfile(name: string | undefined, readSecret: SecretReader, env: Env = process.env): Promise<APIConfig> {
  const { raw, data } = readProfiles(profilePath(env));
  if (raw === null && name === undefined) {
    if (!env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_API_KEY) throw new Error("请先运行 axi setup（或设置原网关环境变量）。");
    return { ...loadConfig(env), secretEnv: "ANTHROPIC_API_KEY" };
  }
  const selected = name ?? data.defaultProfile;
  if (selected === null || !Object.hasOwn(data.profiles, selected)) throw new Error("找不到所选模型配置。请运行 axi setup。");
  const profile = data.profiles[selected]!;
  let key = "";
  if (profile.auth.type === "env") {
    key = env[profile.auth.name] ?? "";
    if (!key.trim()) throw new Error(`请设置环境变量 ${profile.auth.name}，或运行 axi setup。`);
  } else if (profile.auth.type === "keychain") {
    try { key = await Bun.secrets.get(credentialOptions(profile.auth.ref)) ?? ""; }
    catch { throw new Error("无法读取系统凭据库。请运行 axi setup 选择其他认证方式。"); }
  } else if (profile.auth.type === "prompt") {
    key = await readSecret("API Key（不回显）：") ?? "";
  }
  return assembleConfig(profile, selected, key, env);
}

export function shellEnvironment(config: APIConfig, env: Env = process.env): Env {
  const privateNames = new Set([config.secretEnv, "DASHSCOPE_API_KEY", ...Object.values(presets).map(preset => preset.env)]);
  return Object.fromEntries(Object.entries(env).filter(([name, value]) =>
    !privateNames.has(name) && (!config.apiKey || value !== config.apiKey)));
}
