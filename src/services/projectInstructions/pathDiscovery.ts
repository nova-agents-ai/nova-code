/**
 * 目录发现：从 cwd 向上找 git root，并产出 [gitRoot, ..., cwd] 的目录链。
 *
 * 用途：CLAUDE.md / CLAUDE.local.md 的 project / local 两层都需要"从 git root
 * 一路下来到 cwd"的目录列表，越靠近 cwd 优先级越高（后加载、后覆盖）。
 *
 * 没有 git 时退化为 [cwd]。约束：路径必须用 POSIX/Windows 兼容的 path.join；
 * 对齐 nova-code 的 §3 Bun 优先原则，文件存在性用 Bun.file().exists()。
 */

import { dirname, isAbsolute, resolve } from "node:path";

/**
 * 从 startDir 向上查找 git root。
 *
 * - 命中：返回该目录绝对路径
 * - 未找到：返回 undefined（非异常）
 * - 触顶（dirname(x) === x）即停
 */
export async function findGitRoot(startDir: string): Promise<string | undefined> {
  let current = isAbsolute(startDir) ? startDir : resolve(startDir);
  // 最多向上 64 层，足以覆盖任何真实代码仓库；防 symlink 死循环
  for (let i = 0; i < 64; i += 1) {
    if (await isGitDirOrFile(`${current}/.git`)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * 给定 cwd 与可选 gitRoot，返回从 root 一路下到 cwd 的目录链（含两端）。
 *
 * - gitRoot === undefined → 仅返回 [cwd]
 * - gitRoot === cwd       → 返回 [cwd]
 * - gitRoot 在 cwd 之外    → 返回 [gitRoot]（防御性，理论不会发生）
 */
export function getDirectoryChain(cwd: string, gitRoot: string | undefined): readonly string[] {
  const cwdAbs = isAbsolute(cwd) ? cwd : resolve(cwd);
  if (gitRoot === undefined) return [cwdAbs];

  const rootAbs = isAbsolute(gitRoot) ? gitRoot : resolve(gitRoot);
  if (cwdAbs === rootAbs) return [rootAbs];
  if (!cwdAbs.startsWith(`${rootAbs}/`) && !cwdAbs.startsWith(`${rootAbs}\\`)) {
    return [rootAbs];
  }

  const result: string[] = [rootAbs];
  let current = cwdAbs;
  const stack: string[] = [];
  while (current !== rootAbs) {
    stack.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // stack 从 cwd 推到 root 的下一层；逆序追加得到 root → cwd
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const dir = stack[i];
    if (dir !== undefined) result.push(dir);
  }
  return result;
}

/**
 * 判断 .git 是否存在 —— 标准 git 仓库下是目录，worktree 下是文本文件。
 * 两者都视为 git root 命中。
 */
async function isGitDirOrFile(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}
