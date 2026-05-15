/** WebFetchTool 单测：公共 URL 抓取、正文抽取与入参/响应错误。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolExecutionError } from "../../errors/index.ts";
import { decodeHtmlEntities, extractReadableText, stripHtmlTags } from "./extractReadableText.ts";
import { WebFetchTool } from "./WebFetchTool.ts";

const NOOP_SIGNAL = new AbortController().signal;
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

describe("WebFetchTool", () => {
  test("metadata 对齐 M7 工具命名与只读属性", () => {
    expect(WebFetchTool.name).toBe("WebFetch");
    expect(WebFetchTool.requiresApproval).toBe(false);
    expect(WebFetchTool.input_schema.required).toEqual(["url"]);
  });

  test("抓取 HTML 并抽取可读正文，去掉 script/style 噪声", async () => {
    process.env["NOVA_WEB_ALLOW_PRIVATE_HOSTS"] = "1";
    const server = startServer(
      () =>
        new Response(
          `<!doctype html>
        <html>
          <head>
            <title>Hello &amp; Nova</title>
            <style>.hidden { display: none; }</style>
            <script>window.secret = "do-not-show";</script>
          </head>
          <body>
            <main><h1>Hello &amp; Nova</h1><p>Readable content&nbsp;here.</p></main>
          </body>
        </html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    );
    try {
      const result = await WebFetchTool.execute(
        { url: `${server.baseUrl}/page`, prompt: "summarize the page" },
        { signal: NOOP_SIGNAL },
      );

      expect(result).toContain(`Fetched: ${server.baseUrl}/page`);
      expect(result).toContain("Status: 200 OK");
      expect(result).toContain("Prompt: summarize the page");
      expect(result).toContain("Hello & Nova");
      expect(result).toContain("Readable content here.");
      expect(result).not.toContain("do-not-show");
      expect(result).not.toContain("display: none");
    } finally {
      server.stop();
    }
  });

  test("抓取 text/plain 时只做空白归一化", async () => {
    process.env["NOVA_WEB_ALLOW_PRIVATE_HOSTS"] = "1";
    const server = startServer(
      () =>
        new Response("hello\n\n  nova   code\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    );
    try {
      const result = await WebFetchTool.execute(
        { url: `${server.baseUrl}/plain` },
        { signal: NOOP_SIGNAL },
      );
      expect(result).toContain("hello\nnova code");
    } finally {
      server.stop();
    }
  });

  test("拒绝非 HTTP(S) URL", async () => {
    await expect(
      WebFetchTool.execute({ url: "ftp://example.com/file" }, { signal: NOOP_SIGNAL }),
    ).rejects.toThrow(ToolExecutionError);
  });

  test("默认拒绝 localhost/private host，避免 SSRF 到本机服务", async () => {
    delete process.env["NOVA_WEB_ALLOW_PRIVATE_HOSTS"];
    await expect(
      WebFetchTool.execute({ url: "http://127.0.0.1:1/private" }, { signal: NOOP_SIGNAL }),
    ).rejects.toThrow(/private\/local host/);
  });

  test("拒绝非文本响应", async () => {
    process.env["NOVA_WEB_ALLOW_PRIVATE_HOSTS"] = "1";
    const server = startServer(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    try {
      await expect(
        WebFetchTool.execute({ url: `${server.baseUrl}/bin` }, { signal: NOOP_SIGNAL }),
      ).rejects.toThrow(/Unsupported content-type/);
    } finally {
      server.stop();
    }
  });

  test("use_proxy=true 时通过配置的 Bun fetch proxy 访问", async () => {
    let proxyHits = 0;
    const proxy = startServer(() => {
      proxyHits += 1;
      return new Response("<title>Proxy OK</title><p>proxied content</p>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    try {
      process.env["NOVA_WEB_PROXY"] = proxy.baseUrl;
      const result = await WebFetchTool.execute(
        { url: "http://example.com/proxied", use_proxy: true },
        { signal: NOOP_SIGNAL },
      );

      expect(proxyHits).toBe(1);
      expect(result).toContain("Proxy: used (requested by tool input)");
      expect(result).toContain("proxied content");
    } finally {
      proxy.stop();
    }
  });
});

describe("WebFetchTool extraction helpers", () => {
  test("decodeHtmlEntities 支持常用 named / decimal / hex entity", () => {
    expect(decodeHtmlEntities("A&amp;B &#65; &#x42; &unknown;")).toBe("A&B A B &unknown;");
  });

  test("stripHtmlTags 去标签并规整空白", () => {
    expect(stripHtmlTags("<p>Hello&nbsp;<strong>Nova</strong></p>")).toBe("Hello Nova");
  });

  test("extractReadableText 能识别无 content-type 的 HTML", () => {
    expect(extractReadableText("<title>T</title><p>Body</p>", "")).toContain("Body");
  });
});
