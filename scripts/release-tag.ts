/**
 * 基于 package.json `version` 字段打 annotated tag 并推送到远端。
 *
 * 用途：
 *   在 bump 完 package.json 版本 + 合并到 main 之后，一键创建 `v<version>` 的
 *   git tag 并 push。避免手工拼写 tag 名造成的大小写/前缀不一致。
 *
 * 用法：
 *   bun run release:tag                         # 推到默认远端 origin
 *   REMOTE=upstream bun run release:tag         # 换远端
 *   TAG_PREFIX= bun run release:tag             # 去掉 'v' 前缀（默认 'v'）
 *   ALLOW_DIRTY=1 bun run release:tag           # 允许在 worktree 有未提交改动时继续
 *   DRY_RUN=1 bun run release:tag               # 打印要执行的命令但不真的执行
 *
 * 约束：
 *   - 必须在 git 仓库根目录运行（脚本用 process.cwd()）。
 *   - 默认拒绝 dirty worktree，避免 tag 指向一个随时可能丢失的状态。
 *   - 同名 tag 已存在（本地或远端）时直接退出，不覆盖。
 *   - tag 对象是 annotated（`-a`）带消息 `release: v<version>`，便于 git log 审计。
 *
 * 退出码：
 *   0 成功；1 任何一项前置校验失败或 git 子命令非 0 退出。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface RunOptions {
  readonly allowFailure?: boolean;
}

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cmd: string, args: readonly string[], options: RunOptions = {}): RunResult {
  const display = `$ ${cmd} ${args.join(" ")}`.trim();
  console.log(display);
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  const status = result.status ?? 1;
  const stdout = (result.stdout ?? "").toString();
  const stderr = (result.stderr ?? "").toString();
  if (stdout.trim().length > 0) process.stdout.write(stdout);
  if (stderr.trim().length > 0) process.stderr.write(stderr);
  if (status !== 0 && options.allowFailure !== true) {
    throw new Error(`Command failed (exit ${status}): ${cmd} ${args.join(" ")}`);
  }
  return { status, stdout, stderr };
}

function readPackageVersion(cwd: string): string {
  const path = join(cwd, "package.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`无法读取 ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} 不是合法 JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path} 顶层不是对象`);
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`${path} 缺少合法的 version 字段`);
  }
  // 最小语义版本校验：major.minor.patch，允许 -prerelease / +build 后缀。
  const semverLike = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
  if (!semverLike.test(version)) {
    throw new Error(`version "${version}" 不符合 major.minor.patch 语义版本格式`);
  }
  return version;
}

function ensureInsideGitRepo(): void {
  const { status } = run("git", ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (status !== 0) {
    throw new Error("当前目录不在 git 仓库内");
  }
}

function ensureCleanWorkTree(allowDirty: boolean): void {
  if (allowDirty) {
    console.log("⚠️  ALLOW_DIRTY=1 已设置，跳过 worktree clean 校验");
    return;
  }
  const { stdout } = run("git", ["status", "--porcelain"]);
  if (stdout.trim().length > 0) {
    throw new Error(
      "worktree 有未提交改动；请先 commit/stash，或设 ALLOW_DIRTY=1 跳过此校验",
    );
  }
}

function tagExistsLocally(tag: string): boolean {
  const { status } = run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
    allowFailure: true,
  });
  return status === 0;
}

function tagExistsOnRemote(remote: string, tag: string): boolean {
  const { stdout } = run("git", ["ls-remote", "--tags", remote, tag]);
  return stdout.split("\n").some((line) => line.trim().endsWith(`refs/tags/${tag}`));
}

function main(): number {
  const cwd = process.cwd();
  const remote = process.env["REMOTE"] ?? "origin";
  const prefix = process.env["TAG_PREFIX"] ?? "v";
  const allowDirty = process.env["ALLOW_DIRTY"] === "1";
  const dryRun = process.env["DRY_RUN"] === "1";

  ensureInsideGitRepo();
  ensureCleanWorkTree(allowDirty);

  const version = readPackageVersion(cwd);
  const tag = `${prefix}${version}`;
  const message = `release: ${tag}`;

  console.log(`📦 package.json 版本: ${version}`);
  console.log(`🏷  即将创建 tag:     ${tag}`);
  console.log(`🚀 推送到远端:       ${remote}`);
  if (dryRun) console.log("🧪 DRY_RUN=1 已设置，以下命令只打印不执行");

  if (tagExistsLocally(tag)) {
    throw new Error(`本地已存在 tag ${tag}，请先 'git tag -d ${tag}' 再重试`);
  }
  if (tagExistsOnRemote(remote, tag)) {
    throw new Error(`远端 ${remote} 已存在 tag ${tag}，请先人工清理（避免误覆盖发布）`);
  }

  if (dryRun) {
    console.log(`$ git tag -a ${tag} -m "${message}"`);
    console.log(`$ git push ${remote} ${tag}`);
    console.log("✅ DRY_RUN 完成（未执行真实命令）");
    return 0;
  }

  run("git", ["tag", "-a", tag, "-m", message]);
  run("git", ["push", remote, tag]);

  console.log(`✅ tag ${tag} 已创建并推送到 ${remote}`);
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`❌ ${(error as Error).message}`);
  process.exit(1);
}
