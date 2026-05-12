/**
 * ask 命令的 flag 解析：目前只关心 --debug / --debug-pretty，手工解析。
 */

export interface AskFlags {
  readonly debug: boolean;
  readonly pretty: boolean;
  /**
   * --dangerously-skip-permissions：跳过权限询问，映射到 permissionMode="bypassPermissions"。
   * DENY_PATTERNS 仍然会拦截。
   */
  readonly dangerouslySkipPermissions: boolean;
  readonly rest: readonly string[];
}

/**
 * 解析 ask 命令支持的 flag。当前支持 --debug、--debug-pretty，均可出现在任意位置。
 * --debug-pretty 隐含开启 --debug：用户只关心"格式化"时不必再写 --debug。
 *
 * 故意不引入第三方解析器：flag 集合极小，手工解析更直观且无依赖；
 * 后续若 flag 增多，可整体替换为 parseArgs（Node 内置）或 commander。
 */
export function parseAskFlags(args: readonly string[]): AskFlags {
  let debug = false;
  let pretty = false;
  let dangerouslySkipPermissions = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--debug") {
      debug = true;
      continue;
    }
    if (arg === "--debug-pretty") {
      debug = true;
      pretty = true;
      continue;
    }
    if (arg === "--dangerously-skip-permissions") {
      dangerouslySkipPermissions = true;
      continue;
    }
    rest.push(arg);
  }
  return { debug, pretty, dangerouslySkipPermissions, rest };
}
