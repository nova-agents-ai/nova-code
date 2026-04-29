#!/usr/bin/env bun
/**
 * nova-code CLI 可执行入口。
 *
 * 职责：
 * 1. 从同仓库的 package.json 读取真实元信息（名字、版本号、描述）；
 * 2. 注入给 runCli，避免 cli.ts 在编译为 lib 后丢失对 package.json 的相对路径依赖；
 * 3. 把退出码反馈给 OS。
 *
 * 真正的命令分发逻辑都在 src/cli.ts 中，方便单元测试与作为库被复用。
 */

import packageJson from "../package.json" with { type: "json" };
import { runCli } from "../src/cli.ts";

const exitCode = await runCli({
  name: packageJson.name,
  version: packageJson.version,
  description: packageJson.description,
});
process.exit(exitCode);
