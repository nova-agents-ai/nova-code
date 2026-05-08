/**
 * hello 示例命令：无任何依赖，作为 CLI 最小骨架的烟雾测试目标。
 */

import type { CommandDefinition } from "../types.ts";

export const helloCommand: CommandDefinition = {
  name: "hello",
  description: "向指定的人打招呼，默认对象是 world",
  usage: "nova-code hello [name]",
  run: (args) => {
    const target = args[0] ?? "world";
    console.log(`Hello, ${target}!`);
    return 0;
  },
};
