/**
 * Tests for lib/format-converter.mjs
 *
 * Covers: extractPrompt, normalizeText, stableStringify, hashString,
 *         buildCacheKey, splitSystemForCache, buildCacheContext,
 *         buildAnthropicSystemBlocks, buildUsage, contentCharLen,
 *         estimateAnthropicChars, trimAnthropicMessages
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPrompt,
  normalizeText,
  normalizeTextForKey,
  stableStringify,
  hashString,
  buildCacheKey,
  splitSystemForCache,
  buildCacheContext,
  buildAnthropicSystemBlocks,
  buildUsage,
  contentCharLen,
  estimateAnthropicChars,
  trimAnthropicMessages,
  injectCacheBreakpoints,
} from "../lib/format-converter.mjs";

describe("extractPrompt", () => {
  it("should return empty for no messages", () => {
    const result = extractPrompt([], 50000);
    assert.deepEqual(result, { prompt: "", systemPrompt: null });
  });

  it("should return empty for null/undefined", () => {
    assert.deepEqual(extractPrompt(null, 50000), { prompt: "", systemPrompt: null });
    assert.deepEqual(extractPrompt(undefined, 50000), { prompt: "", systemPrompt: null });
  });

  it("should extract system prompt from system role", () => {
    const msgs = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
    ];
    const result = extractPrompt(msgs, 50000);
    assert.equal(result.systemPrompt, "You are helpful");
    assert.equal(result.prompt, "Hello");
  });

  it("should extract system prompt from developer role", () => {
    const msgs = [
      { role: "developer", content: "Be concise" },
      { role: "user", content: "Hi" },
    ];
    const result = extractPrompt(msgs, 50000);
    assert.equal(result.systemPrompt, "Be concise");
  });

  it("should handle non-string system content", () => {
    const msgs = [
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "user", content: "hello" },
    ];
    const result = extractPrompt(msgs, 50000);
    assert.equal(result.systemPrompt, "sys");
  });

  it("should extract text from assistant content arrays", () => {
    const msgs = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: [{ type: "text", text: "A1" }] },
      { role: "user", content: "Q2" },
    ];
    const result = extractPrompt(msgs, 50000);
    assert.ok(result.prompt.includes("[Previous assistant]: A1"));
  });

  it("should prefix assistant messages", () => {
    const msgs = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ];
    const result = extractPrompt(msgs, 50000);
    assert.ok(result.prompt.includes("[Previous assistant]: A1"));
    assert.ok(result.prompt.includes("Q1"));
    assert.ok(result.prompt.includes("Q2"));
  });

  it("should truncate from front when exceeding maxPromptChars", () => {
    const msgs = [
      { role: "user", content: "A".repeat(100) },
      { role: "user", content: "B".repeat(100) },
      { role: "user", content: "C".repeat(100) },
    ];
    const result = extractPrompt(msgs, 250);
    assert.ok(result.prompt.includes("truncated"));
    assert.ok(result.prompt.includes("C".repeat(100)));
  });
});

describe("normalizeText", () => {
  it("should return raw text when normalizeSystemPrefix is false", () => {
    assert.equal(normalizeText("  hello  \r\n  world  "), "  hello  \r\n  world  ");
  });

  it("should normalize CRLF and trim", () => {
    assert.equal(normalizeText("hello\r\nworld", { normalizeSystemPrefix: true }), "hello\nworld");
  });

  it("should debounce whitespace", () => {
    const result = normalizeText("hello   world\n\n\n\ntest", {
      normalizeSystemPrefix: true,
      debounceWhitespace: true,
    });
    assert.equal(result, "hello world\n\ntest");
  });
});

describe("normalizeTextForKey", () => {
  it("should collapse all whitespace for key generation", () => {
    const result = normalizeTextForKey("hello   world\n\ntest", {
      normalizeSystemPrefix: true,
      debounceWhitespace: true,
    });
    assert.equal(result, "hello world test");
  });
});

describe("stableStringify", () => {
  it("should sort object keys for stable output", () => {
    assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
  });

  it("should handle arrays", () => {
    assert.equal(stableStringify([1, 2, 3]), "[1,2,3]");
  });

  it("should handle nested objects", () => {
    const result = stableStringify({ b: { d: 4, c: 3 }, a: 1 });
    assert.equal(result, '{"a":1,"b":{"c":3,"d":4}}');
  });

  it("should handle null and primitives", () => {
    assert.equal(stableStringify(null), "null");
    assert.equal(stableStringify("hello"), '"hello"');
    assert.equal(stableStringify(42), "42");
  });
});

describe("hashString", () => {
  it("should return 16-char hex hash", () => {
    const h = hashString("test");
    assert.equal(h.length, 16);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it("should be deterministic", () => {
    assert.equal(hashString("abc"), hashString("abc"));
  });

  it("should differ for different inputs", () => {
    assert.notEqual(hashString("a"), hashString("b"));
  });
});

describe("buildCacheKey", () => {
  it("should build structured cache key", () => {
    const key = buildCacheKey({
      tenant: "t1",
      sessionId: "s1",
      model: "sonnet",
      systemPrefixHash: "abc",
      toolsHash: "def",
    });
    assert.equal(key, "t:t1|s:s1|m:sonnet|sp:abc|th:def");
  });

  it("should default empty sessionId to 'none'", () => {
    const key = buildCacheKey({
      tenant: "t1",
      sessionId: "",
      model: "opus",
      systemPrefixHash: "x",
      toolsHash: "y",
    });
    assert.equal(key, "t:t1|s:none|m:opus|sp:x|th:y");
  });
});

describe("splitSystemForCache", () => {
  it("should return cacheable=false for empty text", () => {
    const result = splitSystemForCache("", {});
    assert.equal(result.cacheable, false);
  });

  it("should return cacheable=false when prefix too short", () => {
    const result = splitSystemForCache("short", { minSystemPrefixChars: 200 });
    assert.equal(result.cacheable, false);
  });

  it("should split long system text into prefix + suffix", () => {
    const text = "A".repeat(500) + "B".repeat(500);
    const result = splitSystemForCache(text, {
      systemPrefixChars: 500,
      minSystemPrefixChars: 100,
    });
    assert.equal(result.cacheable, true);
    assert.equal(result.prefix.length, 500);
    assert.equal(result.suffix.length, 500);
  });
});

describe("buildCacheContext", () => {
  it("should build complete cache context", () => {
    const ctx = buildCacheContext({
      body: {
        messages: [
          { role: "system", content: "X".repeat(1500) },
          { role: "user", content: "hello" },
        ],
      },
      model: "sonnet",
      source: "test",
      req: { headers: {} },
      applyCacheControl: true,
      cacheConfig: {
        enabled: true,
        systemPrefixChars: 1200,
        minSystemPrefixChars: 200,
        normalizeSystemPrefix: true,
        debounceWhitespace: true,
        sessionScope: "x-session-id",
      },
    });
    assert.equal(ctx.tenant, "test");
    assert.ok(ctx.cacheKey.includes("t:test"));
    assert.equal(ctx.cacheableSystem, true);
    assert.equal(ctx.appliedCount, 1);
    assert.equal(ctx.reason, "ok");
  });

  it("should handle disabled cache control", () => {
    const ctx = buildCacheContext({
      body: { messages: [{ role: "system", content: "X".repeat(1500) }] },
      model: "sonnet",
      source: "test",
      req: { headers: {} },
      applyCacheControl: true,
      cacheConfig: { enabled: false },
    });
    assert.equal(ctx.appliedCount, 0);
    assert.ok(ctx.reason.includes("cache_control_disabled"));
  });
});

describe("buildAnthropicSystemBlocks", () => {
  it("should return null for empty system text", () => {
    assert.equal(buildAnthropicSystemBlocks("", {}, {}), null);
  });

  it("should add cache_control for cacheable text", () => {
    const cacheCtx = { appliedCount: 1 };
    const cacheConfig = {
      enabled: true,
      systemPrefixChars: 500,
      minSystemPrefixChars: 100,
    };
    const blocks = buildAnthropicSystemBlocks("A".repeat(1000), cacheCtx, cacheConfig);
    assert.ok(blocks.length >= 1);
    assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });
  });

  it("should return plain text block when not cacheable", () => {
    const cacheCtx = { appliedCount: 0 };
    const cacheConfig = { enabled: false };
    const blocks = buildAnthropicSystemBlocks("Hello world", cacheCtx, cacheConfig);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.equal(blocks[0].cache_control, undefined);
  });
});

describe("buildUsage", () => {
  it("should compute correct usage totals", () => {
    const usage = buildUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreation: 10,
      cacheRead: 20,
    });
    assert.equal(usage.input_tokens, 100);
    assert.equal(usage.output_tokens, 50);
    assert.equal(usage.prompt_tokens, 130); // 100 + 10 + 20
    assert.equal(usage.completion_tokens, 50);
    assert.equal(usage.total_tokens, 180); // 130 + 50
  });

  it("should handle defaults", () => {
    const usage = buildUsage();
    assert.equal(usage.total_tokens, 0);
  });
});

describe("contentCharLen", () => {
  it("should measure text block length", () => {
    assert.equal(contentCharLen({ type: "text", text: "hello" }), 5);
  });

  it("should measure tool_result length", () => {
    assert.equal(contentCharLen({ type: "tool_result", content: "result" }), 6);
  });

  it("should return 0 for null", () => {
    assert.equal(contentCharLen(null), 0);
  });
});

describe("estimateAnthropicChars", () => {
  it("should sum system + message content", () => {
    const chars = estimateAnthropicChars("system text", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
    assert.equal(chars, 11 + 5 + 5);
  });

  it("should handle array content blocks", () => {
    const chars = estimateAnthropicChars(null, [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    assert.equal(chars, 5);
  });
});

describe("trimAnthropicMessages", () => {
  it("should not trim when within budget", () => {
    const result = trimAnthropicMessages("sys", [
      { role: "user", content: "hi" },
    ], 100);
    assert.equal(result.truncated, false);
    assert.equal(result.messages.length, 1);
  });

  it("should drop older messages first", () => {
    const msgs = [
      { role: "user", content: "A".repeat(100) },
      { role: "assistant", content: "B".repeat(100) },
      { role: "user", content: "C".repeat(100) },
    ];
    const result = trimAnthropicMessages(null, msgs, 80, 3); // ~240 chars budget
    assert.equal(result.truncated, true);
    assert.ok(result.messages.length < 3);
  });

  it("should truncate content within last message if needed", () => {
    const msgs = [{ role: "user", content: "A".repeat(1000) }];
    const result = trimAnthropicMessages(null, msgs, 50, 3); // 150 chars budget
    assert.equal(result.truncated, true);
    assert.ok(result.afterChars <= 150);
  });
});

describe("injectCacheBreakpoints", () => {
  it("should inject cache_control on last tool", () => {
    const body = {
      tools: [
        { name: "tool1", input_schema: {} },
        { name: "tool2", input_schema: {} },
      ],
      messages: [{ role: "user", content: "hello" }],
    };
    const count = injectCacheBreakpoints(body);
    assert.ok(count >= 1);
    assert.deepEqual(body.tools[1].cache_control, { type: "ephemeral" });
    assert.equal(body.tools[0].cache_control, undefined);
  });

  it("should inject cache_control on second-to-last message (array content)", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
    };
    const count = injectCacheBreakpoints(body);
    assert.ok(count >= 1);
    assert.deepEqual(body.messages[1].content[0].cache_control, { type: "ephemeral" });
    assert.equal(body.messages[2].content[0].cache_control, undefined);
  });

  it("should inject cache_control on second-to-last message (string content)", () => {
    const body = {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
    };
    injectCacheBreakpoints(body);
    assert.ok(Array.isArray(body.messages[1].content));
    assert.deepEqual(body.messages[1].content[0].cache_control, { type: "ephemeral" });
  });

  it("should not inject on tools if already has cache_control", () => {
    const body = {
      tools: [
        { name: "t1", input_schema: {}, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    injectCacheBreakpoints(body);
    // Should not duplicate
    assert.deepEqual(body.tools[0].cache_control, { type: "ephemeral" });
  });

  it("should not inject on messages if only one message", () => {
    const body = {
      messages: [{ role: "user", content: "hello" }],
    };
    const count = injectCacheBreakpoints(body);
    assert.equal(count, 0);
  });

  it("should skip tools injection when injectTools is false", () => {
    const body = {
      tools: [{ name: "t1", input_schema: {} }],
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    };
    injectCacheBreakpoints(body, { injectTools: false });
    assert.equal(body.tools[0].cache_control, undefined);
  });

  it("should not mutate original tool objects", () => {
    const original = { name: "t1", input_schema: {} };
    const body = { tools: [original], messages: [{ role: "user", content: "hi" }] };
    injectCacheBreakpoints(body);
    assert.equal(original.cache_control, undefined); // original not mutated
    assert.deepEqual(body.tools[0].cache_control, { type: "ephemeral" }); // new object has it
  });
});
