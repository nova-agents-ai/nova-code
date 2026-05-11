/**
 * GlobTool（name: "Glob"）—— 文件名通配匹配。
 *
 * 设计要点（详见 docs/design/M1-tools.md §4.5）：
 *
 * 1. **使用 `Bun.Glob`**（Bun 1.3+ 内置）：0 依赖，AsyncIterable 便于早期截断
 * 2. **黑名单过滤**：手动过滤 SEARCH_IGNORE_DIRS（Bun.Glob 不支持 ignore 选项）
 *    使用 `isIgnoredPath` helper，与 GrepTool 共用同一语义（任一段精确匹配）
 * 3. **mtime 倒序**：返回最近修改的文件优先，便于模型聚焦活跃文件
 * 4. **结果上限**：> GLOB_MAX_RESULTS 提前 break 迭代省 IO
 * 5. **cwd 校验**：复用 `validateCwd`，与 BashTool 共享 5 个分支处理
 */

import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { AbortError, ToolExecutionError } from "../../errors/index.ts";
import type { Tool } from "../../Tool.ts";
import {
  describeError,
  GLOB_MAX_RESULTS,
  isIgnoredPath,
  requireStringField,
  validateCwd,
} from "../utils.ts";

const TOOL_NAME = "Glob";

export const GlobTool: Tool = {
  name: TOOL_NAME,
  description:
    "Find files by glob pattern (e.g. 'src/**/*.ts', '*.md'). Uses Bun.Glob syntax. " +
    "Automatically skips common ignored directories (.git, node_modules, dist, build, " +
    `.venv, .next, .nova-code). Returns at most ${GLOB_MAX_RESULTS} matches sorted by ` +
    "modification time (most recent first).",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "Glob pattern relative to cwd. Examples: 'src/**/*.ts', '**/*.test.ts', '*.md'.",
      },
      cwd: {
        type: "string",
        description: "Base directory for the glob match. Defaults to process cwd.",
      },
    },
    required: ["pattern"],
  },
  execute: async (input, context) => {
    const pattern = requireStringField(input, "pattern", TOOL_NAME);
    const baseCwd = await validateCwd(input["cwd"], TOOL_NAME);

    if (context.signal.aborted) {
      throw new AbortError(`${TOOL_NAME} aborted before scan`);
    }

    // 注意：`new Bun.Glob(pattern)` 不会因非法语法抛错（实测 Bun 1.3：`[unclosed`、
    // `{unclosed` 都静默接受，scan 时返回 0 结果），故无需 try/catch。
    const glob = new Bun.Glob(pattern);

    // 1. 收集候选：onlyFiles 跳过目录；absolute=false 拿相对 baseCwd 的路径
    //    iterate 时遇到黑名单段直接跳过，达到 GLOB_MAX_RESULTS 即 break
    const candidates: string[] = [];
    try {
      for await (const rel of glob.scan({
        cwd: baseCwd,
        absolute: false,
        onlyFiles: true,
        followSymlinks: false,
        // 隐藏文件默认会被 Bun.Glob 的 dot=false 跳过；这里为了让 `.github/**`
        // 等显式 dot 模式仍能命中，开启 dot=true，再交给 isIgnoredPath 统一过滤
        dot: true,
      })) {
        if (context.signal.aborted) break;
        if (candidates.length >= GLOB_MAX_RESULTS) break;
        // Bun.Glob 在 darwin / linux 用 posix `/`；用 split(sep)+join('/') 跨平台兜底
        const relPosix = rel.split(sep).join("/");
        if (isIgnoredPath(relPosix)) continue;
        candidates.push(relPosix);
      }
    } catch (error) {
      // scan 实测不抛，但保留 catch 以防底层 IO 异常（如 cwd 在迭代中被删）
      throw new ToolExecutionError(TOOL_NAME, `Glob scan failed: ${describeError(error)}`, {
        cause: error,
      });
    }

    if (context.signal.aborted) {
      throw new AbortError(`${TOOL_NAME} aborted during scan`);
    }

    // 2. 拿 mtime（并行 stat），失败的项跳过
    const withMtime = await Promise.all(
      candidates.map(async (relPath) => {
        try {
          const info = await stat(resolve(baseCwd, relPath));
          return { relPath, mtimeMs: info.mtimeMs };
        } catch {
          return null;
        }
      }),
    );

    if (context.signal.aborted) {
      throw new AbortError(`${TOOL_NAME} aborted during stat`);
    }

    const valid = withMtime.filter((x): x is { relPath: string; mtimeMs: number } => x !== null);
    // 3. mtime 倒序
    valid.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return formatOutput(valid, candidates.length >= GLOB_MAX_RESULTS);
  },
};

function formatOutput(
  results: ReadonlyArray<{ relPath: string; mtimeMs: number }>,
  truncated: boolean,
): string {
  if (results.length === 0) return "No files match.";
  const lines = results.map((r) => r.relPath);
  const summary = truncated
    ? `[truncated, showing first ${results.length} matches]`
    : `[${results.length} match${results.length === 1 ? "" : "es"}]`;
  return `${lines.join("\n")}\n${summary}`;
}
