/**
 * CLAUDE.md 4 层加载 + @include 递归解析。
 *
 * 对齐 claude-code/src/utils/claudemd.ts 的加载顺序、@include 语义，以及
 * marked Lexer 处理流程：
 *   1. 用 marked Lexer 把 markdown 切成 tokens
 *   2. 块级 HTML 注释 stripHtmlCommentsFromTokens 剥掉（保留 inline 的 / code block 内的）
 *   3. extractIncludePathsFromTokens 递归遍历 token，跳过 code / codespan，
 *      只在 text / 含残留内容的 html-comment token 上扫 `(?:^|\s)@((?:[^\s\\]|\\ )+)`
 *   4. 路径形式校验：./ ~/ /abs（非 /） 或合法首字符（letter/digit/. _ -）
 *      取 fragment 之前的部分；unescape `\<space>` → ` `
 *   5. 加载子文件前先比对 TEXT_FILE_EXTENSIONS 白名单（不是文本文件直接跳）
 *
 * 优先级（由低到高）—— 越后加载，模型越关注
 *   1. managed: /etc/nova-code/CLAUDE.md           （Linux/macOS；Windows 跳过）
 *   2. user   : ~/.nova-code/CLAUDE.md
 *   3. project: 沿 [gitRoot, ..., cwd] 每层查 CLAUDE.md / .nova-code/CLAUDE.md
 *   4. local  : 沿同样目录链每层查 CLAUDE.local.md
 *
 * 与 claude-code 的差异（保留的简化）：
 *   - 不解析 frontmatter（claude-code 用于 `paths` glob 限制规则作用域；M9 Skills
 *     才会引入完整的 frontmatter 系统）
 *   - 不处理 MEMORY.md 截断 / claudeMdExcludes settings / 子目录 .claude/rules/ 扫描
 *   - 不挂 logEvent 给 EACCES 之外的失败（保留权限错误埋点对齐 claude-code）
 */

import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { Lexer } from "marked";
import { logEvent } from "../analytics/index.ts";
import { findGitRoot, getDirectoryChain } from "./pathDiscovery.ts";

/** Include 递归深度上限。超过即停止追加新的 include 内容。 */
export const MAX_INCLUDE_DEPTH = 5;

/**
 * @include 子文件的扩展名白名单。对齐 claude-code/src/utils/claudemd.ts:96
 * 的 TEXT_FILE_EXTENSIONS。防止把二进制文件（图片 / PDF）当成文本塞进 prompt。
 */
const TEXT_FILE_EXTENSIONS = new Set([
  // Markdown / 纯文本
  ".md",
  ".txt",
  ".text",
  // 数据
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  // Web
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  // JS / TS
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  // Python / Ruby / Go / Rust / JVM 系
  ".py",
  ".pyi",
  ".pyw",
  ".rb",
  ".erb",
  ".rake",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  // C 系
  ".c",
  ".cpp",
  ".cc",
  ".cxx",
  ".h",
  ".hpp",
  ".hxx",
  ".cs",
  ".swift",
  // Shell / 配置
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".env",
  ".ini",
  ".cfg",
  ".conf",
  ".config",
  ".properties",
  // 数据库 / 协议
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  // 框架 / 模板
  ".vue",
  ".svelte",
  ".astro",
  ".ejs",
  ".hbs",
  ".pug",
  ".jade",
  // 其它语言
  ".php",
  ".pl",
  ".pm",
  ".lua",
  ".r",
  ".R",
  ".dart",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".clj",
  ".cljs",
  ".cljc",
  ".edn",
  ".hs",
  ".lhs",
  ".elm",
  ".ml",
  ".mli",
  ".f",
  ".f90",
  ".f95",
  ".for",
  // 构建文件
  ".cmake",
  ".make",
  ".makefile",
  ".gradle",
  ".sbt",
  // 文档
  ".rst",
  ".adoc",
  ".asciidoc",
  ".org",
  ".tex",
  ".latex",
  // 锁文件 / 杂项
  ".lock",
  ".log",
  ".diff",
  ".patch",
]);

/** 给上层（QueryEngine）拼到 system prompt 末尾时使用的固定 header。 */
const PROJECT_INSTRUCTIONS_HEADER =
  "Codebase and user instructions are shown below. " +
  "Be sure to adhere to these instructions. " +
  "IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

export interface GetProjectInstructionsParams {
  readonly cwd: string;
  /** 测试注入：覆盖 home 目录。 */
  readonly homeDir?: string;
  /** 测试注入：覆盖 /etc 目录（managed 层）；不传 = 平台默认。 */
  readonly managedDir?: string;
  /** 平台。仅用于决定是否扫 managed 层（Windows 跳过 /etc）。 */
  readonly platform?: NodeJS.Platform;
}

/**
 * 主入口：返回拼好的 instructions 字符串。无任何文件命中时返回 undefined。
 *
 * 不抛错：任何 IO 异常都视为该层缺失，静默跳过 —— 启动 chat 不应被一份
 * 损坏的 CLAUDE.md 阻断。
 */
export async function getProjectInstructions(
  params: GetProjectInstructionsParams,
): Promise<string | undefined> {
  const { cwd } = params;
  const home = params.homeDir ?? homedir();
  const managedDir = params.managedDir ?? "/etc/nova-code";
  const platform = params.platform ?? process.platform;

  const loaded: LoadedFile[] = [];
  const visited = new Set<string>();

  // Layer 1: managed (Linux/macOS only)
  if (platform !== "win32") {
    await loadFileWithIncludes(join(managedDir, "CLAUDE.md"), loaded, visited, 0);
  }

  // Layer 2: user
  await loadFileWithIncludes(join(home, ".nova-code", "CLAUDE.md"), loaded, visited, 0);

  // Layer 3: project chain (CLAUDE.md / .nova-code/CLAUDE.md per dir)
  const gitRoot = await findGitRoot(cwd);
  const dirChain = getDirectoryChain(cwd, gitRoot);
  for (const dir of dirChain) {
    await loadFileWithIncludes(join(dir, "CLAUDE.md"), loaded, visited, 0);
    await loadFileWithIncludes(join(dir, ".nova-code", "CLAUDE.md"), loaded, visited, 0);
  }

  // Layer 4: local chain (CLAUDE.local.md per dir)
  for (const dir of dirChain) {
    await loadFileWithIncludes(join(dir, "CLAUDE.local.md"), loaded, visited, 0);
  }

  if (loaded.length === 0) return undefined;
  return formatLoaded(loaded);
}

interface LoadedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * 尝试加载一个文件 + 它通过 @include 引用的子文件；递归。
 *
 * - 文件不存在/不可读 → 静默 noop（EACCES 触发 logEvent 埋点）
 * - 文件已加载（在 visited 集里）→ 跳过（防循环）
 * - 深度 ≥ MAX_INCLUDE_DEPTH → 停止递归
 *
 * 加载顺序：claude-code 文件头注释规定"included files 加在 including file 之前"，
 * 因为后加载者优先级更高；此处实现把 include 的子文件先 push 入 loaded 数组，
 * 再 push 当前文件。
 */
async function loadFileWithIncludes(
  filePath: string,
  loaded: LoadedFile[],
  visited: Set<string>,
  depth: number,
): Promise<void> {
  const abs = resolve(filePath);
  if (visited.has(abs)) return;
  visited.add(abs);

  // @include 子文件：扩展名白名单（对齐 claude-code）
  const ext = extname(abs).toLowerCase();
  if (depth > 0 && ext !== "" && !TEXT_FILE_EXTENSIONS.has(ext)) {
    logEvent("tengu_claude_md_include_skipped_extension", { ext });
    return;
  }

  let rawContent: string;
  try {
    const file = Bun.file(abs);
    if (!(await file.exists())) return;
    rawContent = await file.text();
  } catch (error) {
    handleMemoryFileReadError(error, abs);
    return;
  }

  // 用 marked Lexer 切出 tokens：strip + extract 共享同一份 lex 结果
  const tokens = new Lexer({ gfm: false }).lex(rawContent);

  // strip 块级 HTML 注释（保留 inline / code block 内的）
  const { content: strippedContent } = stripHtmlCommentsFromTokens(tokens);

  if (depth < MAX_INCLUDE_DEPTH) {
    const includes = extractIncludePathsFromTokens(tokens, abs);
    for (const includePath of includes) {
      await loadFileWithIncludes(includePath, loaded, visited, depth + 1);
    }
  }

  loaded.push({ path: abs, content: strippedContent });
}

/**
 * 从 markdown tokens 中提取 @include 路径（绝对路径形态）。
 *
 * 对齐 claude-code/src/utils/claudemd.ts:451 extractIncludePathsFromTokens：
 *   - 跳过 code / codespan token（fenced 与 inline code 内的 @path 不算）
 *   - text token 上扫 `(?:^|\s)@((?:[^\s\\]|\\ )+)`
 *   - html token：仅当含块级注释残留时（如 `<!-- note --> @./x.md`）扫残留段
 *   - 递归 element.tokens / element.items（list 的 nested 结构）
 *
 * 路径校验沿用 claude-code 的写法：
 *   - 取 `#` 之前的部分（剥 fragment）
 *   - `\ ` → ` `（unescape escaped space）
 *   - 必须以 `./` / `~/` / `/`（非纯 `/`） 开头，或首字符是 letter/digit/. _ -
 */
export function extractIncludePathsFromTokens(
  // biome-ignore lint/suspicious/noExplicitAny: marked tokens 是开放联合，最简
  tokens: any,
  basePath: string,
): readonly string[] {
  const absolutePaths = new Set<string>();
  processElements(tokens, basePath, absolutePaths);
  return [...absolutePaths];
}

/** 顶层封装：让外部能直接传 markdown 文本调用，方便单测。 */
export function extractIncludePaths(content: string, basePath: string): readonly string[] {
  const tokens = new Lexer({ gfm: false }).lex(content);
  return extractIncludePathsFromTokens(tokens, basePath);
}

/**
 * 块级 HTML 注释剥离 —— 对齐 claude-code/src/utils/claudemd.ts:303
 * stripHtmlCommentsFromTokens。仅剥块级（type='html'），inline 和 code 内
 * 的注释保持原样。
 */
export function stripHtmlComments(content: string): { content: string; stripped: boolean } {
  if (!content.includes("<!--")) {
    return { content, stripped: false };
  }
  const tokens = new Lexer({ gfm: false }).lex(content);
  return stripHtmlCommentsFromTokens(tokens);
}

function stripHtmlCommentsFromTokens(
  // biome-ignore lint/suspicious/noExplicitAny: marked tokens 是开放联合
  tokens: any,
): { content: string; stripped: boolean } {
  let result = "";
  let stripped = false;
  const commentSpan = /<!--[\s\S]*?-->/g;

  for (const token of tokens as Array<{ type: string; raw: string }>) {
    if (token.type === "html") {
      const trimmed = token.raw.trimStart();
      if (trimmed.startsWith("<!--") && trimmed.includes("-->")) {
        const residue = token.raw.replace(commentSpan, "");
        stripped = true;
        if (residue.trim().length > 0) {
          result += residue;
        }
        continue;
      }
    }
    result += token.raw;
  }

  return { content: result, stripped };
}

// ────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ────────────────────────────────────────────────────────────────────────────

interface MarkdownToken {
  type: string;
  text?: string;
  raw?: string;
  // biome-ignore lint/suspicious/noExplicitAny: 递归结构
  tokens?: any;
  // biome-ignore lint/suspicious/noExplicitAny: list 的 items 结构
  items?: any;
}

function processElements(
  // biome-ignore lint/suspicious/noExplicitAny: marked tokens 是开放联合
  elements: any,
  basePath: string,
  absolutePaths: Set<string>,
): void {
  for (const element of elements as MarkdownToken[]) {
    if (element.type === "code" || element.type === "codespan") {
      continue;
    }

    if (element.type === "html") {
      const raw = element.raw ?? "";
      const trimmed = raw.trimStart();
      if (trimmed.startsWith("<!--") && trimmed.includes("-->")) {
        const commentSpan = /<!--[\s\S]*?-->/g;
        const residue = raw.replace(commentSpan, "");
        if (residue.trim().length > 0) {
          extractPathsFromText(residue, basePath, absolutePaths);
        }
      }
      continue;
    }

    if (element.type === "text" && element.text !== undefined) {
      extractPathsFromText(element.text, basePath, absolutePaths);
    }

    if (element.tokens !== undefined) {
      processElements(element.tokens, basePath, absolutePaths);
    }
    if (element.items !== undefined) {
      processElements(element.items, basePath, absolutePaths);
    }
  }
}

/**
 * 从纯文本里抽 @path 引用。允许:
 *   ^@/abs  /  ^@./rel  /  ^@~/home  /  inline  "see @./x.md"
 *
 * 对齐 claude-code 的 includeRegex 与 isValidPath 规则。
 */
function extractPathsFromText(
  textContent: string,
  basePath: string,
  absolutePaths: Set<string>,
): void {
  const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
  let match: RegExpExecArray | null = includeRegex.exec(textContent);
  while (match !== null) {
    extractOnePathMatch(match, basePath, absolutePaths);
    match = includeRegex.exec(textContent);
  }
}

/** 处理 includeRegex 单次匹配；提到独立函数避免 noAssignInExpressions / continue 的复杂控制流。 */
function extractOnePathMatch(
  match: RegExpExecArray,
  basePath: string,
  absolutePaths: Set<string>,
): void {
  let path = match[1];
  if (path === undefined || path === "") return;
  const hashIndex = path.indexOf("#");
  if (hashIndex !== -1) path = path.substring(0, hashIndex);
  if (path === "") return;
  path = path.replace(/\\ /g, " ");
  if (!isValidIncludePath(path)) return;
  const resolved = resolveIncludePath(path, dirname(basePath));
  absolutePaths.add(resolved);
}

/**
 * 路径形态检测：复刻 claude-code 的 isValidPath 写法。
 *
 * 接受：./x  /  ~/x  /  /abs（非纯 "/"）  /  首字符为 [a-zA-Z0-9._-] 的相对路径
 * 拒绝：纯 "/"  /  以 @ 起始（防 @-mention）  /  以 [#%^&*()] 起始
 */
function isValidIncludePath(path: string): boolean {
  if (path.startsWith("./") || path.startsWith("~/")) return true;
  if (path.startsWith("/")) return path !== "/";
  if (path.startsWith("@")) return false;
  if (/^[#%^&*()]+/.test(path)) return false;
  return /^[a-zA-Z0-9._-]/.test(path);
}

/** 把 @include 字符串解析成绝对路径。 */
function resolveIncludePath(raw: string, baseDir: string): string {
  if (raw.startsWith("/")) return raw;
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  if (raw.startsWith("./") || raw.startsWith("../")) return resolve(baseDir, raw);
  if (isAbsolute(raw)) return raw;
  return resolve(baseDir, raw);
}

/**
 * 给 IO 失败按 errno 决定是否埋点。复刻 claude-code 的 handleMemoryFileReadError。
 */
function handleMemoryFileReadError(error: unknown, filePath: string): void {
  const code = errnoCode(error);
  if (code === "ENOENT" || code === "EISDIR") return;
  if (code === "EACCES") {
    logEvent("tengu_claude_md_permission_error", {
      is_access_error: 1,
      // 不打全路径以避免 PII；仅打"是否在 home 目录"做粗粒度归因
      has_home_dir: filePath.includes(homedir()) ? 1 : 0,
    });
  }
}

function errnoCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * 把多份 LoadedFile 拼成最终给 system prompt 的字符串。
 */
function formatLoaded(loaded: readonly LoadedFile[]): string {
  const parts: string[] = [PROJECT_INSTRUCTIONS_HEADER];
  for (const f of loaded) {
    parts.push(`=== file: ${f.path} ===\n${f.content.trimEnd()}`);
  }
  return parts.join("\n\n");
}
