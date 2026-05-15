/** M7 e2e：ask + mock LLM 主动调用 WebFetch / WebSearch，两者走真实本地 HTTP endpoint。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_PATH = fileURLToPath(new URL("../bin/nova-code.ts", import.meta.url));

interface RunAskResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface WebFixture {
  readonly baseUrl: string;
  readonly stop: () => void;
  readonly pageHits: () => number;
  readonly searchHits: () => number;
}

function startWebFixture(): WebFixture {
  let pageHits = 0;
  let searchHits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/page") {
        pageHits += 1;
        return new Response(
          `<!doctype html><html><head><title>M7 Web Tools</title></head>
           <body><h1>M7 Web Tools</h1><p>WebFetch can read public pages.</p></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname === "/search") {
        searchHits += 1;
        return new Response(
          `<a href="https://example.com/m7">M7 WebFetch Result</a>
           <a href="https://docs.example.com/websearch">M7 WebSearch Result</a>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    pageHits: () => pageHits,
    searchHits: () => searchHits,
  };
}

async function runAskChild(params: {
  readonly home: string;
  readonly fixture: WebFixture;
}): Promise<RunAskResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", BIN_PATH, "ask", "fetch and search current public web info"],
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: params.home,
      USERPROFILE: params.home,
      NOVA_API_KEY: "sk-mock",
      NOVA_TRANSPORT: "mock",
      NOVA_MOCK_SCENARIO: "web-loop",
      NOVA_WEB_ALLOW_PRIVATE_HOSTS: "1",
      NOVA_WEB_PROXY: "",
      NOVA_WEB_PROXY_DOMAINS: "",
      MOCK_WEB_URL: `${params.fixture.baseUrl}/page`,
      NOVA_WEB_SEARCH_ENDPOINT: `${params.fixture.baseUrl}/search`,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutHandle = setTimeout(() => proc.kill(), 15_000);
  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

let home: string;
let fixture: WebFixture;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "nova-m7-home-"));
  fixture = startWebFixture();
});

afterEach(async () => {
  fixture.stop();
  if (home) await rm(home, { recursive: true, force: true });
});

describe("m7-e2e-web", () => {
  test("模型可在同一 ask 循环内依次调用 WebFetch 与 WebSearch", async () => {
    const result = await runAskChild({ home, fixture });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Fetching the target page");
    expect(result.stdout).toContain("Searching the web");
    expect(result.stdout).toContain("Done. Web tools completed.");
    expect(result.stderr).toContain("[tool] WebFetch");
    expect(result.stderr).toContain("[tool] WebSearch");
    expect(fixture.pageHits()).toBe(1);
    expect(fixture.searchHits()).toBe(1);
  }, 20_000);
});
