/**
 * Memory 目录解析与启用门控。
 *
 * 对齐 claude-code/src/memdir/paths.ts 的设计，但简化了多层 settings 覆盖与
 * Cowork 远端 override，保留对 nova-code 当前规模真正需要的能力：
 *
 *   getMemoryBaseDir()       —— 基础目录（默认 ~/.nova-code/memory，可被 env 覆盖）
 *   getAutoMemPath()         —— 完整记忆目录（base + projects + sanitize(git-root|cwd)）
 *   getAutoMemEntrypoint()   —— MEMORY.md 路径
 *   isAutoMemoryEnabled()    —— 启用门控（env > config > 默认开）
 *   isAutoMemPath()          —— 权限 carve-out 用：判断绝对路径是否在 memory dir 下
 *   ensureMemoryDirExists()  —— 启动时一次 mkdir，吞 EEXIST
 *
 * 目录策略：findGitRoot 优先 → cwd 回退。同 repo 不同 worktree 共享一份记忆，
 * 非 git 目录（scratch / demo）每个 cwd 一份。
 */

import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

/** memoryBase 的子目录名（位于 ~/.nova-code 下）。 */
const MEMORY_DIR_NAME = "memory";

/** 项目分桶子目录名（位于 memoryBase 下）。 */
const PROJECTS_DIR_NAME = "projects";

/** memory 索引文件名。 */
export const ENTRYPOINT_NAME = "MEMORY.md";

/** 显式禁用环境变量，名称与 claude-code 完全一致，便于用户迁移。 */
const ENV_DISABLE_AUTO_MEMORY = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

/** 自定义 memory base 目录的环境变量（M16 新增；claude-code 用 CLAUDE_CODE_REMOTE_MEMORY_DIR）。 */
const ENV_MEMORY_BASE = "NOVA_MEMORY_DIR";

/** memoryBase 默认目录：~/.nova-code/memory。env override 优先。 */
export function getMemoryBaseDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env[ENV_MEMORY_BASE];
  if (override !== undefined && override.trim() !== "") {
    return override;
  }
  return join(homedir(), ".nova-code", MEMORY_DIR_NAME);
}

/**
 * getAutoMemPathOptions —— 给单测注入 cwd / env / autoMemoryEnabled 用。
 *
 * 生产环境通常用 getAutoMemPath() 无参版本，从 process.cwd() / process.env /
 * 当前 config 推断；单测则显式传以避免 monkey-patch process。
 */
export interface GetAutoMemPathOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 用于 base 目录的 home 注入；不传时用 homedir()。 */
  readonly homeDir?: string;
}

/**
 * 计算 auto-memory 目录的绝对路径，带尾部 sep（与 claude-code 一致，便于
 * isAutoMemPath 的 prefix 匹配避免误命中 `/foo/memory-evil` 与 `/foo/memory`）。
 *
 * 解析顺序：
 *   1. env NOVA_MEMORY_DIR 覆盖 base
 *   2. cwd 的 git canonical root（findGitRoot 上溯 .git 文件或目录）
 *   3. git root 找不到 → 用 cwd
 *
 * 最终路径形如：
 *   ~/.nova-code/memory/projects/<sanitize(/abs/path/to/repo)>/
 *
 * sanitize 把绝对路径转成单层目录名（替换 `/` 与 `\` 为 `-`，去掉冒号），
 * 与 nova-code 现有 sessionId / mcp server-name sanitize 风格一致。
 */
export async function getAutoMemPath(options: GetAutoMemPathOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const home = options.homeDir;
  const base =
    home !== undefined ? join(home, ".nova-code", MEMORY_DIR_NAME) : getMemoryBaseDir(env);
  const projectBase = (await findGitRootForMemory(cwd)) ?? cwd;
  const sanitized = sanitizeProjectKey(projectBase);
  return join(base, PROJECTS_DIR_NAME, sanitized) + sep;
}

/**
 * Memory 模块自带的 git root 检测。
 *
 * 故意不复用 services/projectInstructions/pathDiscovery.findGitRoot：那里用
 * Bun.file().exists() 判断 .git 存在性，对"`.git` 是目录"的情况（标准仓库）
 * 会误判为 false（M12 latent bug，未对 M12 行为造成可见影响，所以 M16 不
 * 顺手改）。本地实现用 fs.stat 同时识别目录与文件（worktree 是 .git 文件
 * 包含 gitdir 指向）。
 *
 * 触顶 / symlink 死循环防护：最多上溯 64 层。
 */
async function findGitRootForMemory(startDir: string): Promise<string | undefined> {
  let current = isAbsolute(startDir) ? startDir : resolve(startDir);
  for (let i = 0; i < 64; i += 1) {
    if (await dotGitExists(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

async function dotGitExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** MEMORY.md 绝对路径（依赖 getAutoMemPath）。 */
export async function getAutoMemEntrypoint(options: GetAutoMemPathOptions = {}): Promise<string> {
  const dir = await getAutoMemPath(options);
  return join(dir, ENTRYPOINT_NAME);
}

/**
 * isAutoMemoryEnabled —— 门控优先级：
 *
 *   1. env CLAUDE_CODE_DISABLE_AUTO_MEMORY 真值 → 关
 *   2. options.configAutoMemoryEnabled === false → 关
 *   3. 默认 → 开
 *
 * 把 config 决定权放在 options 入参里，让 paths 模块本身不直接 import config
 * 模块（避免循环依赖）；调用方传入 ResolvedConfig.autoMemoryEnabled 即可。
 */
export interface IsAutoMemoryEnabledOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly configAutoMemoryEnabled?: boolean;
}

export function isAutoMemoryEnabled(options: IsAutoMemoryEnabledOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (isEnvTruthy(env[ENV_DISABLE_AUTO_MEMORY])) return false;
  if (options.configAutoMemoryEnabled === false) return false;
  return true;
}

/**
 * 判断一个绝对路径是否落在某个 auto memory 目录之下。
 *
 * 用于权限引擎的 carve-out 判定：FileWrite/FileEdit 写到 memoryDir 内时
 * 直接放行。
 *
 * 安全：用 normalize() 消除 `..` 段后做严格前缀匹配；调用方应传入 memoryDir
 * 是 getAutoMemPath() 的返回值（含尾部 sep）。
 */
export function isAutoMemPath(filePath: string, memoryDir: string): boolean {
  if (filePath.includes("\0")) return false;
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  const normalized = normalize(abs);
  const base = memoryDir.endsWith(sep) ? memoryDir : memoryDir + sep;
  return normalized === normalize(base.slice(0, -1)) || normalized.startsWith(base);
}

/**
 * 创建 memory 目录（含父目录）。EEXIST 等于成功；其它错误吞掉只打日志，
 * 不阻断 prompt 装配——后续 FileWrite 会再 mkdir 一次并暴露真正的权限错误。
 *
 * 调用方：命令入口（AskCommand / ChatCommand）在 createMemoryRuntime 之后
 * fire-and-forget 调一次。模型直接 Write 时 prompt 中已声明"目录已存在"，
 * 避免模型再去 `ls` / `mkdir -p` 浪费 turn。
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  try {
    await mkdir(memoryDir, { recursive: true });
  } catch {
    // mkdir recursive 已经吞 EEXIST；走到这里通常是权限问题，
    // 不在 prompt 装配阶段炸；模型后续真写时再触发真实错误。
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ────────────────────────────────────────────────────────────────────────────

function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * 把绝对路径转成单层目录名：替换路径分隔符为 `-`，去掉 Windows 驱动冒号。
 *
 * 例：
 *   /path/to/project/nova-code
 *   → -path-to-project-nova-code
 *
 * 选用 leading `-` 风格（与 claude-code projects 子目录的 leading `-` 一致），
 * 避免与 `~/.nova-code` 其它子目录（如 logs / sessions）产生命名歧义。
 */
function sanitizeProjectKey(absPath: string): string {
  return absPath.replaceAll(/[\\/:]+/g, "-");
}
