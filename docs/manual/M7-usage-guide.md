# M7 — Web 工具使用手册

> 适用版本：v0.8.x（M7 上线之后）
>
> 面向：终端用户 / 新人上手 / 接入 nova-code 的二次开发者

---

## 1. 前置与安装

M7 不新增 npm 依赖。升级后执行：

```bash
bun install
bun run typecheck
bun test
bun run check
```

---

## 2. 新增能力总览

| 能力 | 说明 |
|---|---|
| `WebFetch` | 抓取公开 HTTP(S) URL，并抽取可读正文 |
| `WebSearch` | 搜索公开 Web，返回结果标题与 URL |
| 网页正文抽取 | 去掉 script/style/svg/noscript，解码常用 HTML entity，规整空白 |
| SSRF 防护 | 默认拒绝 localhost / 私网 / link-local 地址 |
| 代理路由 | 可配置 HTTP(S) proxy 和需代理域名；模型也可在工具调用里设置 `use_proxy=true` |
| mock e2e 场景 | `NOVA_MOCK_SCENARIO=web-loop` 可离线验证 |

你不需要手动输入工具 JSON；正常使用时由模型决定何时调用 `WebFetch` / `WebSearch`。

---

## 3. 典型使用

### 3.1 ask 模式读取公开页面

```bash
NOVA_API_KEY="sk-ant-..." \
  bun run bin/nova-code.ts ask "读取 https://example.com 并总结页面内容"
```

stderr 会出现类似工具调用提示：

```text
[tool] WebFetch {"url":"https://example.com","prompt":"总结页面内容"}
```

成功的普通 tool result 默认不直接刷屏；模型会拿到正文并继续回答。

### 3.2 ask 模式搜索公开 Web

```bash
NOVA_API_KEY="sk-ant-..." \
  bun run bin/nova-code.ts ask "搜索 nova-code WebFetch WebSearch 的相关资料"
```

模型可调用：

```text
[tool] WebSearch {"query":"nova-code WebFetch WebSearch"}
```

### 3.3 域名过滤

模型可传 `allowed_domains` 或 `blocked_domains`：

```json
{
  "query": "typescript AbortSignal fetch timeout",
  "allowed_domains": ["developer.mozilla.org"]
}
```

两个字段互斥。`example.com` 会匹配 `docs.example.com`。

---

## 4. 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `NOVA_WEB_SEARCH_ENDPOINT` | `https://duckduckgo.com/html/` | 覆盖 WebSearch 的 HTML endpoint，工具会自动追加 `q=<query>` |
| `NOVA_WEB_PROXY` | 未设置 | WebFetch / WebSearch 命中代理路由时使用的 HTTP(S) proxy URL |
| `NOVA_WEB_PROXY_DOMAINS` | 未设置 | 逗号分隔的需代理域名，例如 `example.com,*.blocked.test` |
| `NOVA_WEB_ALLOW_PRIVATE_HOSTS` | 未设置 | 设为 `1` 时允许抓取 localhost / 私网地址；仅用于本地测试 |
| `NOVA_MOCK_SCENARIO` | `chat` | 设为 `web-loop` 可让 mock LLM 主动调用 WebFetch / WebSearch |
| `MOCK_WEB_URL` | `http://127.0.0.1:9/missing` | `web-loop` 第一轮 WebFetch 的目标 URL |

不要在真实 agent 会话中长期打开 `NOVA_WEB_ALLOW_PRIVATE_HOSTS=1`，否则模型可能读取本机或内网 HTTP 服务。

---

## 5. 代理配置与模型推理

通过 config 文件配置代理：

```bash
bun run bin/nova-code.ts config set webProxy "http://127.0.0.1:7890"
bun run bin/nova-code.ts config set webProxyDomains "example.com,*.blocked.test"
```

也可以用环境变量临时覆盖：

```bash
NOVA_WEB_PROXY="http://127.0.0.1:7890" \
NOVA_WEB_PROXY_DOMAINS="example.com,*.blocked.test" \
bun run bin/nova-code.ts ask "读取 example.com 的公开页面"
```

路由规则：

1. 如果目标 host 命中 `webProxyDomains` / `NOVA_WEB_PROXY_DOMAINS`，自动走代理；
2. 如果模型判断该网站通常需要代理，可以在工具入参中设置 `use_proxy: true`；
3. `use_proxy=true` 但没有配置 `webProxy` / `NOVA_WEB_PROXY` 时，工具会返回清晰错误；
4. 输出只显示 `Proxy: used (...)`，不会打印代理 URL 或认证凭证。

工具入参示例：

```json
{
  "url": "https://example.com/page",
  "prompt": "总结页面内容",
  "use_proxy": true
}
```

---

## 6. 离线端到端验证脚本

最短验证：

```bash
bun test src/m7-e2e-web.test.ts
```

可复制的手工 e2e 脚本如下；它启动一个本地 Bun HTTP server，再让 mock LLM 依次调用 `WebFetch` 和 `WebSearch`：

```bash
set -euo pipefail
TMP_HOME="$(mktemp -d)"
SERVER_LOG="$TMP_HOME/server.log"

bun --eval '
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/page") {
      return new Response("<title>M7</title><h1>M7 Web Tools</h1><p>Fetch ok.</p>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === "/search") {
      return new Response("<a href=\"https://example.com/m7\">M7 Result</a>", {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(server.port);
await new Promise(() => {});
' >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$TMP_HOME"' EXIT

for _ in 1 2 3 4 5; do
  if [ -s "$SERVER_LOG" ]; then break; fi
  sleep 0.2
done
PORT="$(head -n 1 "$SERVER_LOG")"

HOME="$TMP_HOME" \
USERPROFILE="$TMP_HOME" \
NOVA_API_KEY="sk-mock" \
NOVA_TRANSPORT="mock" \
NOVA_MOCK_SCENARIO="web-loop" \
NOVA_WEB_ALLOW_PRIVATE_HOSTS="1" \
NOVA_WEB_PROXY="" \
NOVA_WEB_PROXY_DOMAINS="" \
MOCK_WEB_URL="http://127.0.0.1:$PORT/page" \
NOVA_WEB_SEARCH_ENDPOINT="http://127.0.0.1:$PORT/search" \
bun run bin/nova-code.ts ask "fetch and search public web info" \
  >"$TMP_HOME/stdout.txt" \
  2>"$TMP_HOME/stderr.txt"

grep -q "Done. Web tools completed." "$TMP_HOME/stdout.txt"
grep -q "\[tool\] WebFetch" "$TMP_HOME/stderr.txt"
grep -q "\[tool\] WebSearch" "$TMP_HOME/stderr.txt"

echo "M7 web tools e2e ok"
```

---

## 7. 提交前校验矩阵

| 命令 | 期望 |
|---|---|
| `bun run typecheck` | TypeScript 严格模式通过 |
| `bun test` | 全量单测 / 集成 / e2e 通过 |
| `bun run check` | Biome lint + format 通过 |

M7.1 完成时全量为 663 tests。

---

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `Refusing to fetch private/local host` | URL 指向 localhost / 私网 | 真实会话换公开 URL；本地测试才临时设 `NOVA_WEB_ALLOW_PRIVATE_HOSTS=1` |
| `Unsupported content-type` | 目标返回图片、PDF、二进制下载 | 换 HTML / text 页面；PDF 读取不属于 M7 |
| WebSearch 没结果 | 默认 HTML endpoint 被网络或搜索服务限制 | 设置 `NOVA_WEB_SEARCH_ENDPOINT` 到可用搜索代理 / MCP 前置服务，或配置 `NOVA_WEB_PROXY` + `NOVA_WEB_PROXY_DOMAINS` |
| `Web proxy was requested...` | 模型设置了 `use_proxy=true` 或域名命中规则，但未配置代理 URL | 设置 `webProxy` / `NOVA_WEB_PROXY` |
| 页面内容缺失 | 页面依赖 JS hydration 或登录态 | M7 不运行浏览器、不带 cookie；后续浏览器工具处理 |
| 工具调用后屏幕没显示正文 | 成功 tool result 默认静默 | 查看最终模型回答；必要时开 `--debug` 看事件流 |

---

## 9. 交叉引用

- [M7 设计文档](../design/M7-web-tools.md)
- [M7 架构文档](../architecture/M7-architecture.md)
- [Roadmap](../roadmap.md)
