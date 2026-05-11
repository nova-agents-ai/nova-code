/**
 * chat 命令的 flag 解析：--debug / --debug-pretty / --resume <id|alias>。
 *
 * 手工解析而非 commander：flag 集合极小，保留与 parseAskFlags 同样的风格。
 * 未来 flag 数量上来再换成 Node 内置 parseArgs。
 */

/** chat 命令解析后的 flag 结构。 */
export interface ChatFlags {
  readonly debug: boolean;
  readonly pretty: boolean;
  /** --resume <id|alias> 指定要恢复的会话；未提供则开新会话。 */
  readonly resumeId: string | undefined;
  /** 未能消费的剩余位置参数；当前 chat 不接受位置参数，非空即属异常。 */
  readonly rest: readonly string[];
}

/** 解析错误（rest 非空 / --resume 缺参数等）。调用方据此退出码 1。 */
export class ChatFlagsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatFlagsError";
  }
}

/**
 * 解析 chat 命令的 flag。
 *
 * - `--debug`、`--debug-pretty`：与 ask 语义一致；后者隐含前者
 * - `--resume <id|alias>`：必须紧跟一个值；缺值抛 ChatFlagsError
 * - chat 暂不接受位置参数；出现则抛 ChatFlagsError（让用户清楚哪些输入被忽略）
 */
export function parseChatFlags(args: readonly string[]): ChatFlags {
  let debug = false;
  let pretty = false;
  let resumeId: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--debug") {
      debug = true;
      continue;
    }
    if (arg === "--debug-pretty") {
      debug = true;
      pretty = true;
      continue;
    }
    if (arg === "--resume") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new ChatFlagsError("--resume 需要一个参数：/load 时用的 sessionId 或 alias。");
      }
      resumeId = next;
      i += 1;
      continue;
    }
    // 支持 --resume=<value> 简写
    if (arg?.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length);
      if (value === "") {
        throw new ChatFlagsError("--resume= 后必须跟 sessionId 或 alias。");
      }
      resumeId = value;
      continue;
    }
    // 其余未识别的 arg 进 rest；chat 当前不接受位置参数
    if (arg !== undefined) {
      rest.push(arg);
    }
  }

  if (rest.length > 0) {
    throw new ChatFlagsError(`chat 不接受位置参数：${rest.join(" ")}`);
  }

  return { debug, pretty, resumeId, rest };
}
