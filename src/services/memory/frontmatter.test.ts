import { describe, expect, test } from "bun:test";
import { parseMemoryDocument } from "./frontmatter.ts";

describe("parseMemoryDocument", () => {
  test("基本三段：frontmatter + body", () => {
    const doc = parseMemoryDocument(
      "---\nname: foo\ndescription: hello\ntype: user\n---\n\nbody line 1\nbody line 2",
    );
    expect(doc.frontmatter).toEqual({
      name: "foo",
      description: "hello",
      type: "user",
    });
    expect(doc.body.trim()).toBe("body line 1\nbody line 2");
  });

  test("缺 frontmatter 起始 → frontmatter 为空，body 原样", () => {
    const doc = parseMemoryDocument("hello world");
    expect(doc.frontmatter).toEqual({});
    expect(doc.body).toBe("hello world");
  });

  test("frontmatter 缺闭合 → frontmatter 为空", () => {
    const doc = parseMemoryDocument("---\nname: foo\n\nbody");
    expect(doc.frontmatter).toEqual({});
    expect(doc.body).toContain("body");
  });

  test("跳过注释行与空行", () => {
    const doc = parseMemoryDocument("---\n# comment\nname: foo\n\ntype: user\n---\n");
    expect(doc.frontmatter).toEqual({ name: "foo", type: "user" });
  });

  test("单/双引号被脱掉", () => {
    const doc = parseMemoryDocument(
      "---\nname: \"quoted name\"\ndescription: 'single quoted'\n---\nbody",
    );
    expect(doc.frontmatter["name"]).toBe("quoted name");
    expect(doc.frontmatter["description"]).toBe("single quoted");
  });

  test("中文 description 透传", () => {
    const doc = parseMemoryDocument("---\nname: zh\ndescription: 中文描述\n---\n正文");
    expect(doc.frontmatter["description"]).toBe("中文描述");
    expect(doc.body.trim()).toBe("正文");
  });

  test("CRLF 自动归一化", () => {
    const doc = parseMemoryDocument("---\r\nname: foo\r\n---\r\nbody\r\n");
    expect(doc.frontmatter["name"]).toBe("foo");
    expect(doc.body.trim()).toBe("body");
  });
});
