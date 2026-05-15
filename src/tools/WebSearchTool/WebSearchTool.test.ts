/** WebSearchTool 单测：HTML 搜索结果解析、域名过滤与本地 endpoint 执行。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolExecutionError } from "../../errors/index.ts";
import { parseWebSearchResults, WebSearchTool } from "./WebSearchTool.ts";

const NOOP_SIGNAL = new AbortController().signal;
const ORIGINAL_ENDPOINT = process.env["NOVA_WEB_SEARCH_ENDPOINT"];
const ORIGINAL_ALLOW_PRIVATE_HOSTS = process.env["NOVA_WEB_ALLOW_PRIVATE_HOSTS"];
const ORIGINAL_WEB_PROXY = process.env["NOVA_WEB_PROXY"];
const ORIGINAL_WEB_PROXY_DOMAINS = process.env["NOVA_WEB_PROXY_DOMAINS"];

interface TestServer {
  readonly baseUrl: string;
  readonly stop: () => void;
}

function startServer(handler: (request: Request) => Response): TestServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

beforeEach(() => {
  process.env["NOVA_WEB_PROXY"] = "";
  process.env["NOVA_WEB_PROXY_DOMAINS"] = "";
});

afterEach(() => {
  if (ORIGINAL_ENDPOINT === undefined) {
    delete process.env["NOVA_WEB_SEARCH_ENDPOINT"];
  } else {
    process.env["NOVA_WEB_SEARCH_ENDPOINT"] = ORIGINAL_ENDPOINT;
  }
  if (ORIGINAL_ALLOW_PRIVATE_HOSTS === undefined) {
    delete process.env["NOVA_WEB_ALLOW_PRIVATE_HOSTS"];
  } else {
    process.env["NOVA_WEB_ALLOW_PRIVATE_HOSTS"] = ORIGINAL_ALLOW_PRIVATE_HOSTS;
  }
  if (ORIGINAL_WEB_PROXY === undefined) {
    delete process.env["NOVA_WEB_PROXY"];
  } else {
    process.env["NOVA_WEB_PROXY"] = ORIGINAL_WEB_PROXY;
  }
  if (ORIGINAL_WEB_PROXY_DOMAINS === undefined) {
    delete process.env["NOVA_WEB_PROXY_DOMAINS"];
  } else {
    process.env["NOVA_WEB_PROXY_DOMAINS"] = ORIGINAL_WEB_PROXY_DOMAINS;
  }
});

describe("WebSearchTool", () => {
  test("metadata 对齐 M7 工具命名与只读属性", () => {
    expect(WebSearchTool.name).toBe("WebSearch");
    expect(WebSearchTool.requiresApproval).toBe(false);
    expect(WebSearchTool.input_schema.required).toEqual(["query"]);
  });

  test("parseWebSearchResults 解析直接 URL 与 DuckDuckGo uddg 跳转", () => {
    const results = parseWebSearchResults(`
      <a class="result__a" href="https://example.com/a">Example &amp; A</a>
      <a href="/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fb">Docs <b>Result</b></a>
      <a href="javascript:void(0)">bad</a>
      <a href="https://example.com/a">duplicate</a>
    `);

    expect(results).toEqual([
      { title: "Example & A", url: "https://example.com/a" },
      { title: "Docs Result", url: "https://docs.example.com/b" },
    ]);
  });

  test("execute 使用 NOVA_WEB_SEARCH_ENDPOINT 并返回编号结果", async () => {
    const seenQueries: string[] = [];
    const server = startServer((request) => {
      const url = new URL(request.url);
      seenQueries.push(url.searchParams.get("q") ?? "");
      return new Response(
        `<a href="https://example.com/a">Example A</a>
         <a href="https://docs.example.com/b">Docs B</a>`,
        { headers: { "content-type": "text/html" } },
      );
    });
    try {
      process.env["NOVA_WEB_ALLOW_PRIVATE_HOSTS"] = "1";
      process.env["NOVA_WEB_SEARCH_ENDPOINT"] = `${server.baseUrl}/search`;
      const result = await WebSearchTool.execute({ query: "nova code" }, { signal: NOOP_SIGNAL });

      expect(seenQueries).toEqual(["nova code"]);
      expect(result).toContain('Search results for "nova code"');
      expect(result).toContain("1. Example A");
      expect(result).toContain("https://example.com/a");
      expect(result).toContain("2. Docs B");
    } finally {
      server.stop();
    }
  });

  test("allowed_domains 仅保留匹配域名与子域名", async () => {
    const server = startServer(
      () =>
        new Response(
          `<a href="https://example.com/a">Example</a>
         <a href="https://docs.example.com/b">Docs</a>`,
          { headers: { "content-type": "text/html" } },
        ),
    );
    try {
      process.env["NOVA_WEB_ALLOW_PRIVATE_HOSTS"] = "1";
      process.env["NOVA_WEB_SEARCH_ENDPOINT"] = `${server.baseUrl}/search`;
      const result = await WebSearchTool.execute(
        { query: "nova", allowed_domains: ["example.com"] },
        { signal: NOOP_SIGNAL },
      );

      expect(result).toContain("Example");
      expect(result).toContain("Docs");
    } finally {
      server.stop();
    }
  });

  test("blocked_domains 排除匹配域名与子域名", async () => {
    const server = startServer(
      () =>
        new Response(
          `<a href="https://example.com/a">Example</a>
         <a href="https://docs.example.com/b">Docs</a>
         <a href="https://other.test/c">Other</a>`,
          { headers: { "content-type": "text/html" } },
        ),
    );
    try {
      process.env["NOVA_WEB_ALLOW_PRIVATE_HOSTS"] = "1";
      process.env["NOVA_WEB_SEARCH_ENDPOINT"] = `${server.baseUrl}/search`;
      const result = await WebSearchTool.execute(
        { query: "nova", blocked_domains: ["example.com"] },
        { signal: NOOP_SIGNAL },
      );

      expect(result).not.toContain("Example");
      expect(result).not.toContain("Docs");
      expect(result).toContain("Other");
    } finally {
      server.stop();
    }
  });

  test("同时传 allowed_domains 与 blocked_domains 会拒绝", async () => {
    await expect(
      WebSearchTool.execute(
        { query: "nova", allowed_domains: ["example.com"], blocked_domains: ["other.test"] },
        { signal: NOOP_SIGNAL },
      ),
    ).rejects.toThrow(ToolExecutionError);
  });

  test("use_proxy=true 时搜索请求走配置代理", async () => {
    let proxyHits = 0;
    const proxy = startServer(() => {
      proxyHits += 1;
      return new Response('<a href="https://example.com/proxied">Proxied Result</a>', {
        headers: { "content-type": "text/html" },
      });
    });
    try {
      process.env["NOVA_WEB_PROXY"] = proxy.baseUrl;
      process.env["NOVA_WEB_SEARCH_ENDPOINT"] = "http://search.example.test/html/";
      const result = await WebSearchTool.execute(
        { query: "nova proxy", use_proxy: true },
        { signal: NOOP_SIGNAL },
      );

      expect(proxyHits).toBe(1);
      expect(result).toContain("Proxy: used (requested by tool input)");
      expect(result).toContain("Proxied Result");
    } finally {
      proxy.stop();
    }
  });
});
