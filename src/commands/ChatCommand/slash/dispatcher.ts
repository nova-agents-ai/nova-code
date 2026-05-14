/**
 * Slash dispatcher —— REPL 主循环每拿到一行输入就先过这里：
 * - 非 `/` 前缀：返回 null，调用方继续走 session.sendTurn
 * - `/` 前缀但未知命令：打印提示 + 返回 `continue`，REPL 回到等输入
 * - `/` + 已知命令：执行 handler，把其结果透传给 REPL
 *
 * 解析规则：按空白分割，首 token 去掉 `/` 是命令名，其余 token 是 args。
 * 参数引号转义 M2 不支持（/save "with spaces" 不做）——设计稿 §二非目标。
 */

import { logEvent } from "../../../services/analytics/index.ts";
import { findSlashCommand } from "./registry.ts";
import type { SlashContext, SlashResult } from "./types.ts";

/**
 * Dispatcher 的返回值。
 *
 * - handled=false：输入不是斜杠命令，调用方应交给 session.sendTurn
 * - handled=true：输入已被 dispatcher 或某条命令消化；exit/continue 语义
 *   通过嵌套的 `result` 再传给 REPL
 */
export type DispatchResult =
  | { readonly handled: false }
  | { readonly handled: true; readonly result: SlashResult };

/**
 * 从一整行 REPL 输入里识别并执行斜杠命令。
 *
 * ctx 里的 args 会被 dispatcher 覆盖，调用方传进来的 args 值无效——
 * 入参上仍要求补 args 字段是为了让类型签名与 SlashContext 对齐；
 * 实际使用时外层 REPL 会传一个空数组作 placeholder。
 */
export async function dispatchSlash(
  input: string,
  baseCtx: Omit<SlashContext, "args">,
): Promise<DispatchResult> {
  if (!input.startsWith("/")) {
    return { handled: false };
  }

  // 去掉前导 `/` 后按空白分割。空白包括 \t，符合 shell 直觉
  const tokens = input.slice(1).trim().split(/\s+/);
  const name = tokens[0] ?? "";

  if (name === "") {
    // 用户只输入了一个 `/`，当成未知命令处理：给个友善提示
    logEvent("tengu_input_slash_missing", {});
    baseCtx.io.print("空命令。输入 /help 查看可用斜杠命令。\n");
    return { handled: true, result: { action: "continue" } };
  }

  const command = findSlashCommand(name);
  if (command === undefined) {
    logEvent("tengu_input_slash_invalid", { name });
    baseCtx.io.print(`未知命令：/${name}。输入 /help 查看可用命令。\n`);
    return { handled: true, result: { action: "continue" } };
  }

  const result = await command.run({
    ...baseCtx,
    args: tokens.slice(1),
  });
  return { handled: true, result };
}
