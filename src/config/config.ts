/**
 * nova-code 全局配置加载与持久化。
 *
 * 配置文件路径：~/.nova-code/config.json
 *
 * 设计原则：
 * - 所有读取通过 loadConfig() 走纯函数，方便测试时注入临时目录
 * - 不做隐式 mutation：写配置必须显式调用 saveConfig()
 * - 校验失败立即抛 ConfigError，绝不返回半成品
 * - 环境变量（NOVA_API_KEY / NOVA_BASE_URL / NOVA_MODEL）优先级高于配置文件，
 *   因为 CI/容器场景下用户更常用环境变量
 * - 环境变量统一使用 NOVA_ 前缀，与 nova-code 品牌对齐，避免与
 *   Anthropic SDK 自身识别的 ANTHROPIC_API_KEY 冲突（用户可以同时使用两套
 *   配置：一套留给 nova-code，一套留给其他直接用 SDK 的工具）
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError } from "../errors/index.ts";
import { validateHooksConfig } from "../services/hooks/config.ts";
import type { HooksConfig } from "../services/hooks/types.ts";
import type {
  McpServerConfig,
  McpServersConfig,
  McpStdioServerConfig,
  McpStreamableHttpServerConfig,
} from "../services/mcp/types.ts";

/** 默认使用的模型。Anthropic 当前主推 claude-sonnet-4-5，可被配置覆盖。 */
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

/** 默认 max_tokens，Anthropic 推荐 8k 起步。 */
const DEFAULT_MAX_TOKENS = 8192;

/** 默认 agent loop 最大轮次，防止失控的工具循环烧 token。 */
const DEFAULT_MAX_TURNS = 25;

/** 配置文件相对 ~/.nova-code 的目录名。 */
const CONFIG_DIR_NAME = ".nova-code";

/** 配置文件名。 */
const CONFIG_FILE_NAME = "config.json";

/** 日志文件存放的子目录名（位于 ~/.nova-code 下）。 */
const LOGS_DIR_NAME = "logs";

/** 会话持久化（JSONL）存放的子目录名，M2 chat REPL 新增。 */
const SESSIONS_DIR_NAME = "sessions";

/** M5 cost ledger 文件名（位于 ~/.nova-code 下）。 */
const COST_LEDGER_FILE_NAME = "cost.jsonl";

/** 环境变量名。统一使用 NOVA_ 前缀。 */
const ENV_API_KEY = "NOVA_API_KEY";
const ENV_BASE_URL = "NOVA_BASE_URL";
const ENV_MODEL = "NOVA_MODEL";
const ENV_WEB_PROXY = "NOVA_WEB_PROXY";
const ENV_WEB_PROXY_DOMAINS = "NOVA_WEB_PROXY_DOMAINS";

/**
 * 用户可写入磁盘的配置 schema。
 * 所有字段都可选，缺省值在 resolveConfig 中应用。
 */
export interface PersistedConfig {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly maxTurns?: number;
  /** M7.1: optional HTTP(S) proxy used by WebFetch/WebSearch when routing rules match. */
  readonly webProxy?: string;
  /** M7.1: host suffixes that should use webProxy, e.g. ["example.com", "*.blocked.test"]. */
  readonly webProxyDomains?: readonly string[];
  /** M8: configured MCP servers, keyed by stable server name. */
  readonly mcpServers?: McpServersConfig;
  /** M10: tool lifecycle hooks, keyed by hook event name. */
  readonly hooks?: HooksConfig;
  /** M13: local plugin trust/enable state, keyed by plugin manifest name. */
  readonly plugins?: PluginStatesConfig;
  /**
   * M16: 是否启用 auto memory（默认 true）。设为 false 等同于 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1。
   * 详见 docs/manual/M16-usage-guide.md。
   */
  readonly autoMemoryEnabled?: boolean;
}

export interface PluginStateConfig {
  readonly enabled?: boolean;
  readonly trusted?: boolean;
  readonly version?: string;
  readonly lastReloadedAt?: string;
  /**
   * Absolute plugin root recorded at trust time. When present, the loader will
   * invalidate trust if a plugin with the same name is later discovered at a
   * different path — preventing a globally-trusted name from auto-trusting
   * an unrelated plugin in a sibling project. Missing values fall back to
   * legacy lenient behavior so existing trust state still works.
   */
  readonly path?: string;
}

export type PluginStatesConfig = Readonly<Record<string, PluginStateConfig>>;

/**
 * 经过缺省值合并 + 环境变量覆盖后的最终生效配置。
 * 所有字段都已确定（apiKey 之外都有缺省值）。
 */
export interface ResolvedConfig {
  readonly apiKey: string;
  readonly baseURL: string | undefined;
  readonly model: string;
  readonly maxTokens: number;
  readonly maxTurns: number;
  readonly webProxy: string | undefined;
  readonly webProxyDomains: readonly string[];
  readonly mcpServers: McpServersConfig;
  readonly hooks: HooksConfig;
  /** M16: auto memory 启用状态。默认 true。 */
  readonly autoMemoryEnabled: boolean;
}

/**
 * 用于测试的依赖注入：覆盖 home 目录或环境变量来源。
 */
export interface ConfigSource {
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** 计算配置文件的绝对路径。 */
export function getConfigFilePath(source: ConfigSource = {}): string {
  const home = source.homeDir ?? homedir();
  return join(home, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * 计算日志目录的绝对路径（~/.nova-code/logs）。
 * 注意：只返回路径，不创建目录。调用方应在写入前自行 mkdir -p。
 */
export function getLogsDirPath(source: ConfigSource = {}): string {
  const home = source.homeDir ?? homedir();
  return join(home, CONFIG_DIR_NAME, LOGS_DIR_NAME);
}

/**
 * 计算会话持久化目录的绝对路径（~/.nova-code/sessions）。
 *
 * 与 `getLogsDirPath` 保持对称的套路：只返回路径、不 mkdir，
 * 让调用方（sessionStore）自行在写入前保证目录存在。
 *
 * M2 chat REPL 的 /save /load 用这个目录存放 `<sessionId>.jsonl`。
 */
export function getSessionsDirPath(source: ConfigSource = {}): string {
  const home = source.homeDir ?? homedir();
  return join(home, CONFIG_DIR_NAME, SESSIONS_DIR_NAME);
}

/** 计算 cost ledger 的绝对路径（~/.nova-code/cost.jsonl）。 */
export function getCostLedgerPath(source: ConfigSource = {}): string {
  const home = source.homeDir ?? homedir();
  return join(home, CONFIG_DIR_NAME, COST_LEDGER_FILE_NAME);
}

/**
 * 读取配置文件并解析；文件不存在时返回空对象（不视为错误）。
 * JSON 损坏或字段类型错误时抛 ConfigError。
 */
export async function loadPersistedConfig(source: ConfigSource = {}): Promise<PersistedConfig> {
  const path = getConfigFilePath(source);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }
    throw new ConfigError(`Failed to read config file at ${path}: ${describeError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Config file at ${path} is not valid JSON: ${describeError(error)}`);
  }

  return validatePersistedConfig(parsed, path);
}

/**
 * 将配置写入磁盘，自动创建父目录。
 * 写入失败抛 ConfigError。
 */
export async function savePersistedConfig(
  config: PersistedConfig,
  source: ConfigSource = {},
): Promise<void> {
  const validated = validatePersistedConfig(config, "<input>");
  const path = getConfigFilePath(source);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new ConfigError(`Failed to write config file at ${path}: ${describeError(error)}`);
  }
}

/**
 * 把磁盘配置 + 环境变量 + 缺省值合并成最终生效的 ResolvedConfig。
 * 优先级（高 → 低）：环境变量 > 配置文件 > 内置默认值。
 *
 * apiKey 必须存在，否则抛 ConfigError 并提示用户如何配置。
 */
export function resolveConfig(
  persisted: PersistedConfig,
  source: ConfigSource = {},
): ResolvedConfig {
  const env = source.env ?? process.env;

  const apiKey = env[ENV_API_KEY] ?? persisted.apiKey;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new ConfigError(
      `LLM API key not configured. Set the ${ENV_API_KEY} environment variable, ` +
        `or write { "apiKey": "sk-ant-..." } to ${getConfigFilePath(source)}.`,
    );
  }

  return {
    apiKey,
    baseURL: env[ENV_BASE_URL] ?? persisted.baseURL,
    model: env[ENV_MODEL] ?? persisted.model ?? DEFAULT_MODEL,
    maxTokens: persisted.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxTurns: persisted.maxTurns ?? DEFAULT_MAX_TURNS,
    webProxy: env[ENV_WEB_PROXY] ?? persisted.webProxy,
    webProxyDomains:
      env[ENV_WEB_PROXY_DOMAINS] !== undefined
        ? parseEnvList(env[ENV_WEB_PROXY_DOMAINS])
        : (persisted.webProxyDomains ?? []),
    mcpServers: persisted.mcpServers ?? {},
    hooks: persisted.hooks ?? {},
    autoMemoryEnabled: persisted.autoMemoryEnabled ?? true,
  };
}

/**
 * 一站式：从磁盘读 + env 覆盖 + 缺省值，得到最终配置。
 * 这是 commands/llm 调用方应该使用的唯一入口。
 */
export async function loadConfig(source: ConfigSource = {}): Promise<ResolvedConfig> {
  const persisted = await loadPersistedConfig(source);
  return resolveConfig(persisted, source);
}

// ────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ────────────────────────────────────────────────────────────────────────────

/**
 * 运行时校验：确认未知 JSON 结构能匹配 PersistedConfig。
 * 替代 Zod，避免引入额外依赖；schema 简单时手写够用。
 */
function validatePersistedConfig(value: unknown, path: string): PersistedConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`Config at ${path} must be a JSON object, got ${typeName(value)}.`);
  }

  // 用 Partial<Record<keyof X, unknown>>：
  // - 字段是已知 union（不是 index signature），所以 obj.apiKey 不会触发 TS4111
  //   也不会被 biome 的 useLiteralKeys 投诉
  // - 值是 unknown，保留运行时类型校验的必要性
  const obj = value as Partial<Record<keyof PersistedConfig, unknown>>;
  const result: { -readonly [K in keyof PersistedConfig]: PersistedConfig[K] } = {};

  if (obj.apiKey !== undefined) {
    if (typeof obj.apiKey !== "string") {
      throw new ConfigError(
        `Config at ${path}: 'apiKey' must be a string, got ${typeName(obj.apiKey)}.`,
      );
    }
    result.apiKey = obj.apiKey;
  }

  if (obj.baseURL !== undefined) {
    if (typeof obj.baseURL !== "string") {
      throw new ConfigError(
        `Config at ${path}: 'baseURL' must be a string, got ${typeName(obj.baseURL)}.`,
      );
    }
    result.baseURL = obj.baseURL;
  }

  if (obj.model !== undefined) {
    if (typeof obj.model !== "string") {
      throw new ConfigError(
        `Config at ${path}: 'model' must be a string, got ${typeName(obj.model)}.`,
      );
    }
    result.model = obj.model;
  }

  if (obj.maxTokens !== undefined) {
    if (
      typeof obj.maxTokens !== "number" ||
      !Number.isInteger(obj.maxTokens) ||
      obj.maxTokens <= 0
    ) {
      throw new ConfigError(
        `Config at ${path}: 'maxTokens' must be a positive integer, got ${String(obj.maxTokens)}.`,
      );
    }
    result.maxTokens = obj.maxTokens;
  }

  if (obj.maxTurns !== undefined) {
    if (typeof obj.maxTurns !== "number" || !Number.isInteger(obj.maxTurns) || obj.maxTurns <= 0) {
      throw new ConfigError(
        `Config at ${path}: 'maxTurns' must be a positive integer, got ${String(obj.maxTurns)}.`,
      );
    }
    result.maxTurns = obj.maxTurns;
  }

  if (obj.webProxy !== undefined) {
    if (typeof obj.webProxy !== "string" || obj.webProxy.trim() === "") {
      throw new ConfigError(
        `Config at ${path}: 'webProxy' must be a non-empty string, got ${typeName(obj.webProxy)}.`,
      );
    }
    assertHttpProxyUrl(obj.webProxy, path);
    result.webProxy = obj.webProxy;
  }

  if (obj.webProxyDomains !== undefined) {
    if (!Array.isArray(obj.webProxyDomains)) {
      throw new ConfigError(
        `Config at ${path}: 'webProxyDomains' must be an array, got ${typeName(obj.webProxyDomains)}.`,
      );
    }
    result.webProxyDomains = obj.webProxyDomains.map((item, index) =>
      validateDomainPattern(item, `Config at ${path}: 'webProxyDomains[${index}]'`),
    );
  }

  if (obj.mcpServers !== undefined) {
    result.mcpServers = validateMcpServersConfig(obj.mcpServers, path);
  }

  if (obj.hooks !== undefined) {
    result.hooks = validateHooksConfig(obj.hooks, `Config at ${path}`);
  }

  if (obj.plugins !== undefined) {
    result.plugins = validatePluginStatesConfig(obj.plugins, path);
  }

  if (obj.autoMemoryEnabled !== undefined) {
    if (typeof obj.autoMemoryEnabled !== "boolean") {
      throw new ConfigError(
        `Config at ${path}: 'autoMemoryEnabled' must be a boolean, got ${typeName(obj.autoMemoryEnabled)}.`,
      );
    }
    result.autoMemoryEnabled = obj.autoMemoryEnabled;
  }

  return result;
}

function validatePluginStatesConfig(value: unknown, path: string): PluginStatesConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      `Config at ${path}: 'plugins' must be an object, got ${typeName(value)}.`,
    );
  }

  const states: Record<string, PluginStateConfig> = {};
  for (const [name, rawState] of Object.entries(value as Record<string, unknown>)) {
    validatePluginName(name, `Config at ${path}: plugins`);
    states[name] = validatePluginStateConfig(rawState, `Config at ${path}: plugins.${name}`);
  }
  return states;
}

function validatePluginStateConfig(value: unknown, field: string): PluginStateConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${field} must be an object, got ${typeName(value)}.`);
  }
  const obj = value as Readonly<Record<string, unknown>>;
  const result: { -readonly [K in keyof PluginStateConfig]: PluginStateConfig[K] } = {};
  if (obj["enabled"] !== undefined) {
    result.enabled = validateBoolean(obj["enabled"], `${field}.enabled`);
  }
  if (obj["trusted"] !== undefined) {
    result.trusted = validateBoolean(obj["trusted"], `${field}.trusted`);
  }
  if (obj["version"] !== undefined) {
    result.version = validateNonEmptyString(obj["version"], `${field}.version`);
  }
  if (obj["lastReloadedAt"] !== undefined) {
    result.lastReloadedAt = validateNonEmptyString(
      obj["lastReloadedAt"],
      `${field}.lastReloadedAt`,
    );
  }
  if (obj["path"] !== undefined) {
    result.path = validateNonEmptyString(obj["path"], `${field}.path`);
  }
  return result;
}

function validatePluginName(value: string, field = "plugin name"): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ConfigError(`${field} '${value}' must match /^[A-Za-z0-9_-]+$/.`);
  }
}

export function validateMcpServersConfig(value: unknown, path: string): McpServersConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(
      `Config at ${path}: 'mcpServers' must be an object, got ${typeName(value)}.`,
    );
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, rawServer] of Object.entries(value as Record<string, unknown>)) {
    validateMcpServerName(name, `Config at ${path}: mcpServers`);
    servers[name] = validateMcpServerConfig(rawServer, `Config at ${path}: mcpServers.${name}`);
  }
  return servers;
}

function validateMcpServerConfig(value: unknown, field: string): McpServerConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${field} must be an object, got ${typeName(value)}.`);
  }
  const obj = value as Readonly<Record<string, unknown>>;
  const rawType = obj["type"];
  if (rawType === undefined || rawType === "stdio") {
    return validateMcpStdioServerConfig(obj, field);
  }
  if (rawType === "http") return validateMcpHttpServerConfig(obj, field);
  throw new ConfigError(`${field}.type must be "stdio" or "http", got ${String(rawType)}.`);
}

function validateMcpStdioServerConfig(
  obj: Readonly<Record<string, unknown>>,
  field: string,
): McpStdioServerConfig {
  const result: { -readonly [K in keyof McpStdioServerConfig]: McpStdioServerConfig[K] } = {
    command: validateNonEmptyString(obj["command"], `${field}.command`),
  };

  if (obj["type"] !== undefined) result.type = "stdio";
  if (obj["args"] !== undefined) result.args = validateStringArray(obj["args"], `${field}.args`);
  if (obj["env"] !== undefined) result.env = validateStringRecord(obj["env"], `${field}.env`);
  if (obj["cwd"] !== undefined) result.cwd = validateNonEmptyString(obj["cwd"], `${field}.cwd`);
  applyMcpCommonServerConfig(result, obj, field);
  return result;
}

function validateMcpHttpServerConfig(
  obj: Readonly<Record<string, unknown>>,
  field: string,
): McpStreamableHttpServerConfig {
  const url = validateNonEmptyString(obj["url"], `${field}.url`);
  assertHttpUrl(url, `${field}.url`);
  const result: {
    -readonly [K in keyof McpStreamableHttpServerConfig]: McpStreamableHttpServerConfig[K];
  } = {
    type: "http",
    url,
  };
  if (obj["headers"] !== undefined) {
    result.headers = validateStringRecord(obj["headers"], `${field}.headers`);
  }
  applyMcpCommonServerConfig(result, obj, field);
  return result;
}

function applyMcpCommonServerConfig(
  result: { disabled?: boolean; autoApprove?: boolean; timeoutMs?: number },
  obj: Readonly<Record<string, unknown>>,
  field: string,
): void {
  if (obj["disabled"] !== undefined) {
    result.disabled = validateBoolean(obj["disabled"], `${field}.disabled`);
  }
  if (obj["autoApprove"] !== undefined) {
    result.autoApprove = validateBoolean(obj["autoApprove"], `${field}.autoApprove`);
  }
  if (obj["timeoutMs"] !== undefined) {
    if (
      typeof obj["timeoutMs"] !== "number" ||
      !Number.isInteger(obj["timeoutMs"]) ||
      obj["timeoutMs"] <= 0
    ) {
      throw new ConfigError(`${field}.timeoutMs must be a positive integer.`);
    }
    result.timeoutMs = obj["timeoutMs"];
  }
}

export function validateMcpServerName(value: string, field = "mcp server name"): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ConfigError(`${field} '${value}' must match /^[A-Za-z0-9_-]+$/.`);
  }
}

function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${field} must be a non-empty string, got ${typeName(value)}.`);
  }
  return value;
}

function validateStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be an array, got ${typeName(value)}.`);
  }
  return value.map((item, index) => validateNonEmptyString(item, `${field}[${index}]`));
}

function validateStringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${field} must be an object, got ${typeName(value)}.`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim() === "") throw new ConfigError(`${field} has an empty key.`);
    result[key] = validateNonEmptyString(item, `${field}.${key}`);
  }
  return result;
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${field} must be a boolean, got ${typeName(value)}.`);
  }
  return value;
}

function parseEnvList(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function assertHttpUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ConfigError(`${field} must be a valid URL: ${describeError(error)}.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${field} must use http or https, got ${url.protocol}.`);
  }
}

function assertHttpProxyUrl(value: string, path: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ConfigError(
      `Config at ${path}: 'webProxy' must be a valid URL: ${describeError(error)}.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `Config at ${path}: 'webProxy' must use http or https, got ${url.protocol}.`,
    );
  }
}

function validateDomainPattern(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${field} must be a non-empty string, got ${typeName(value)}.`);
  }
  return value.trim();
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
