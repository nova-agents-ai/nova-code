/** Web proxy routing config tests. */

import { describe, expect, test } from "bun:test";
import { ConfigError, ToolExecutionError } from "../../errors/index.ts";
import {
  decideWebProxyFromConfig,
  normalizeProxyUrl,
  resolveWebProxyConfig,
} from "./webProxyConfig.ts";

describe("webProxyConfig", () => {
  test("env web proxy overrides persisted config and parses domain CSV", () => {
    const config = resolveWebProxyConfig({
      persisted: {
        webProxy: "http://file-proxy.example:8080",
        webProxyDomains: ["file.example.com"],
      },
      env: {
        NOVA_WEB_PROXY: "https://env-proxy.example:8443",
        NOVA_WEB_PROXY_DOMAINS: "example.com, *.blocked.test",
      },
    });

    expect(config).toEqual({
      proxyUrl: "https://env-proxy.example:8443",
      proxyDomains: ["example.com", "blocked.test"],
    });
  });

  test("domain rule matches exact host and subdomain", () => {
    const config = {
      proxyUrl: "http://proxy.example:8080",
      proxyDomains: ["blocked.test"],
    };

    expect(
      decideWebProxyFromConfig({
        url: new URL("https://blocked.test/a"),
        forceProxy: false,
        toolName: "WebFetch",
        config,
      }),
    ).toEqual({
      proxyUrl: "http://proxy.example:8080",
      source: "domain",
      matchedDomain: "blocked.test",
    });

    expect(
      decideWebProxyFromConfig({
        url: new URL("https://docs.blocked.test/a"),
        forceProxy: false,
        toolName: "WebFetch",
        config,
      }).proxyUrl,
    ).toBe("http://proxy.example:8080");
  });

  test("forceProxy=true lets LLM request proxy even without a domain rule", () => {
    const decision = decideWebProxyFromConfig({
      url: new URL("https://example.com/a"),
      forceProxy: true,
      toolName: "WebFetch",
      config: { proxyUrl: "http://proxy.example:8080", proxyDomains: [] },
    });

    expect(decision.source).toBe("llm");
    expect(decision.proxyUrl).toBe("http://proxy.example:8080");
  });

  test("proxy requested but proxyUrl missing throws clear ToolExecutionError", () => {
    expect(() =>
      decideWebProxyFromConfig({
        url: new URL("https://example.com/a"),
        forceProxy: true,
        toolName: "WebFetch",
        config: { proxyUrl: undefined, proxyDomains: [] },
      }),
    ).toThrow(ToolExecutionError);
  });

  test("normalizeProxyUrl only accepts http/https proxy URLs", () => {
    expect(normalizeProxyUrl("http://proxy.example:8080")).toBe("http://proxy.example:8080");
    expect(() => normalizeProxyUrl("socks5://proxy.example:1080")).toThrow(ConfigError);
  });
});
