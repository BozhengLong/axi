import { abortError } from "./api/types.ts";
import { probeConnection } from "./api/wire.ts";
import {
  assembleConfig, credentialOptions, endpoint, envNameValid, presets, profileNameValid, profilePath,
  protocols, readProfiles, saveProfiles, type Auth, type Env, type Preset, type Profile,
} from "./profiles.ts";

interface SetupIO {
  write(text: string): void;
  read(prompt: string, signal?: AbortSignal): Promise<string | null>;
  readSecret(prompt: string, signal?: AbortSignal): Promise<string | null>;
}

export async function runSetup(io: SetupIO, selected: string | undefined, signal: AbortSignal, env: Env = process.env): Promise<void> {
  const path = profilePath(env);
  const { raw, data } = readProfiles(path);
  async function ask(prompt: string, initial?: string, hidden = false): Promise<string> {
    signal.throwIfAborted();
    const answer = await (hidden ? io.readSecret : io.read)(`${prompt}${initial !== undefined ? ` [${initial}]` : ""}: `, signal);
    if (answer === null) throw abortError();
    return answer.trim() || initial || "";
  }
  const name = selected ?? await ask("配置名称", data.defaultProfile ?? "default");
  if (!profileNameValid(name)) throw new Error("配置名须为 1 至 48 个字母、数字、下划线或连字符，并以字母或数字开头。");
  const previous = Object.hasOwn(data.profiles, name) ? data.profiles[name] : undefined;
  // 已保存的预览配置仍可编辑。新建配置时隐藏 Ollama 预设。
  const providers = [...(Object.keys(presets) as Preset[]).filter(key => key !== "ollama" || previous?.provider === key),
    "custom" as const];
  io.write(`提供商：\n${providers.map((key, index) => `  ${index + 1}. ${key === "custom" ? "自定义端点" : presets[key].label}`).join("\n")}\n`);
  const provider = providers[Number(await ask("选择提供商序号", String(previous ? providers.indexOf(previous.provider) + 1 : 1))) - 1];
  if (!provider) throw new Error("提供商选择无效。");
  const preset = provider === "custom" ? undefined : presets[provider];
  const protocol = preset?.protocol ?? protocols[Number(await ask(`选择协议（${protocols.map((p, i) => `${i + 1} ${p}`).join(" / ")}）`,
    previous?.provider === provider ? String(protocols.indexOf(previous.protocol) + 1) : "1")) - 1];
  if (!protocol) throw new Error("协议选择无效。");
  const baseUrl = provider === "custom" || provider === "ollama"
    ? await ask("模型地址", previous?.provider === provider ? previous.baseUrl ?? preset?.url : preset?.url) : undefined;
  const model = await ask("模型 ID", previous?.provider === provider ? previous.model : preset?.model);
  if (!model) throw new Error("模型 ID 不能为空。");
  const connection: Omit<Profile, "auth"> = { provider, protocol, model, baseUrl };
  let auth: Auth, key = "";
  if (provider === "ollama") {
    auth = { type: "none" };
  } else {
    const mode = await ask("认证方式（1 系统凭据库 / 2 环境变量 / 3 每次输入" + (provider === "custom" ? " / 4 本机免密）" : "）"), "1");
    if (mode === "1" || mode === "3") {
      auth = mode === "1" ? { type: "keychain", ref: crypto.randomUUID() } : { type: "prompt" };
      key = await ask("API Key（不回显）", undefined, true);
    } else if (mode === "2") {
      const name = await ask("密钥所在的环境变量名", previous?.auth.type === "env" && previous.provider === provider ? previous.auth.name : preset?.env);
      if (!envNameValid(name)) throw new Error("环境变量名无效。");
      auth = { type: "env", name };
      key = env[name] ?? "";
    } else if (mode === "4" && provider === "custom") auth = { type: "none" };
    else throw new Error("认证方式无效。");
  }
  const profile: Profile = { ...connection, auth, verified: false };
  const url = endpoint(profile);
  io.write(`配置：${name}\n提供商：${provider}\n模型：${model}\n端点：${url}\n`);
  if (await ask("发送一条短文本测试请求（可能产生用量）？输入 y 测试", "n") === "y") {
    await probeConnection(assembleConfig(profile, name, key, env), signal);
    profile.verified = true;
    io.write("文本连通测试通过。\n");
  }
  const defaultProfile = await ask("设为默认配置？输入 y 确认", data.defaultProfile === null || data.defaultProfile === name ? "y" : "n") === "y" ? name : data.defaultProfile;
  if (await ask("保存配置？输入 y 确认", "n") !== "y") return;
  let savedRef: string | undefined;
  try {
    if (auth.type === "keychain") {
      assembleConfig(profile, name, key, env);
      try { await Bun.secrets.set({ ...credentialOptions(auth.ref), value: key }); }
      catch { throw new Error("系统凭据库不可用。请重新运行 axi setup，选择环境变量或每次输入。"); }
      savedRef = auth.ref;
    }
    signal.throwIfAborted();
    saveProfiles(path, raw, { schema: 1, defaultProfile, profiles: { ...data.profiles, [name]: profile } });
  } catch (error) {
    if (savedRef) await Bun.secrets.delete(credentialOptions(savedRef)).catch(() => {});
    throw error;
  }
  io.write(`已保存 ${name}（${profile.verified ? "文本连通已验证" : "连通待验证"}）。从项目目录运行 axi --profile ${name}。\n`);
}
