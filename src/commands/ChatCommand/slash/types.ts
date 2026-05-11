/**
 * Slash 命令相关的公共类型。
 *
 * 对齐设计稿 §3（独立 SlashCommand 注册表）。刻意不复用顶层
 * CommandDefinition：两者上下文差异巨大（CommandDefinition 在子进程启动时
 * 跑一次，SlashCommand 在 REPL 里每轮可能多次触发，且必须拿到 session 句柄）。
 *
 * SlashIO 抽象 print/confirm：
 * - 生产路径由 runChatRepl 注入真实 stdout + readline 实现
 * - 单测直接 mock 两个同步方法，完全不依赖 readline/TTY
 */

import type { ConfigSource } from "../../../config/config.ts";
import type { ChatSession } from "../ChatSession.ts";

/** REPL 与斜杠命令之间的 I/O 通道。 */
export interface SlashIO {
  /** 打印一段用户可见的文本（带不带换行由调用方自己决定）。 */
  print(text: string): void;
  /**
   * 询问用户 y/n，返回 true 表示用户确认；用于 /load 前的"当前会话将被替换"提示。
   * 取消或超时视为 false。
   */
  confirm(prompt: string): Promise<boolean>;
}

/**
 * 斜杠命令执行后给 dispatcher 的结论。
 *
 * - continue：继续 REPL 主循环
 * - exit：退出 REPL（可选 exitCode，默认 0）
 *
 * M2 阶段仅此两种。未来如需 /resume、/model 等可能要 "reload" action 再扩。
 */
export type SlashResult =
  | { readonly action: "continue" }
  | { readonly action: "exit"; readonly exitCode?: number };

/** 调用具体 SlashCommand.run 时的上下文。 */
export interface SlashContext {
  readonly session: ChatSession;
  readonly io: SlashIO;
  /** 参数数组。`/save alias-a extra` → ["alias-a", "extra"]。命令自行决定接受多少。 */
  readonly args: readonly string[];
  /** 注入 home 目录等，主要给单测用；生产路径通常省略。 */
  readonly configSource?: ConfigSource;
}

/** 一条斜杠命令的定义。 */
export interface SlashCommand {
  /** 命令名，不带前导 `/`。 */
  readonly name: string;
  /** 一行简短描述，出现在 /help 的命令列表里。 */
  readonly description: string;
  /** 使用说明（可多行），/help <cmd> 或命令自身出错时展示。 */
  readonly usage: string;
  /** 执行逻辑。保证不抛；用户可感知的失败走 io.print + 返回 continue。 */
  run(ctx: SlashContext): Promise<SlashResult>;
}
