/**
 * headlessPermissionProvider —— ask 命令（non-interactive）的 PermissionProvider。
 *
 * 背景：
 *   ask 是一次性 headless 执行，没有 TTY 可弹菜单；但 QueryEngine 在遇到 ask 档
 *   工具调用时仍会去调 provider。没 provider 时 QueryEngine 默认 deny —— 这里把
 *   这个默认行为显式化，同时带一行 stderr 提示，便于用户知道为什么某些调用被拒。
 *
 * 设计决策：
 *   - 永远返回 "deny"，不管什么工具、什么输入
 *   - 不抛错，不读 stdin：headless 环境下任何交互都会卡住
 *   - 把 stderr 注入化，方便单测
 *
 * 与 ChatCommand 的 replPermissionProvider 的对照：
 *   - repl: 5 档交互菜单，可持久化到 session/project/global
 *   - headless: 单一 deny，不写任何规则
 *
 * 用户若想允许某个工具，应当：
 *   1) 预先在 ~/.nova-code/permissions.json 里写 allow 规则；或
 *   2) 用 chat 命令进入 REPL 交互授权，规则一旦写入 project/global 即对 ask 生效
 */

import type { PermissionProvider } from "../../services/permissions/PermissionProvider.ts";
import type { UserChoice } from "../../types/permissions.ts";

/** headless provider 的依赖注入：只用 stderr 提示。 */
export interface HeadlessPermissionProviderDeps {
  /** 写 stderr 的函数（测试注入）。生产路径传 `(t) => process.stderr.write(t)`。 */
  readonly stderr: (text: string) => void;
}

/**
 * 构造 headless provider。所有 ask 档请求一律 deny。
 *
 * 返回的 Promise 立即 resolve，不做任何 I/O（避免把 headless 流程阻塞住）。
 */
export function createHeadlessPermissionProvider(
  deps: HeadlessPermissionProviderDeps,
): PermissionProvider {
  return {
    requestPermission: async (req): Promise<UserChoice> => {
      // 给一行可见提示，便于用户排查"为什么 LLM 说它没执行某个命令"
      // 注意：QueryEngine 自身也会发 permission_decision 事件，runAskWithLLM 已有兜底打印；
      // 这里再加一行是因为 reason 在事件里是解释性的文案，和"哪里被拒"是两回事。
      deps.stderr(`[permission] headless mode auto-deny: ${req.toolName} (${req.reason})\n`);
      return "deny";
    },
  };
}
