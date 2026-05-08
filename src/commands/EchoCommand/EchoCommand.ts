/**
 * echo 示例命令：把参数原样回显，空参数时以非 0 退出码报错。
 */

import type { CommandDefinition } from "../types.ts";

export const echoCommand: CommandDefinition = {
  name: "echo",
  description: "原样回显传入的参数",
  usage: "nova-code echo <text...>",
  run: (args) => {
    if (args.length === 0) {
      console.error("echo: 至少需要一个参数");
      return 1;
    }
    console.log(args.join(" "));
    return 0;
  },
};
