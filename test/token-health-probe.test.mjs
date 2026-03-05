/**
 * Tests for lib/token-health-probe.mjs
 *
 * Covers: createTokenHealthProbe — probeToken logic, result tracking,
 *         start/destroy lifecycle, getResults
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createTokenHealthProbe } from "../lib/token-health-probe.mjs";

function makeTestServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("token-health-probe", () => {
  let testServer = null;

  afterEach(async () => {
    if (testServer) {
      await new Promise(r => testServer.server.close(r));
      testServer = null;
    }
  });

  it("should probe and return verified on 200", async () => {
    testServer = await makeTestServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "p" }] }));
    });

    const tokenPool = [{ name: "t1", token: "test-token", type: "api_key_billed" }];
    const probe = createTokenHealthProbe({
      tokenPool,
      apiBase: testServer.url,
      apiVersion: "2023-06-01",
      modelIds: { haiku: "claude-haiku-4-5-20251001" },
      log: () => {},
    });

    const result = await probe.probeToken(tokenPool[0]);
    assert.equal(result.status, "verified");
    assert.equal(result.statusCode, 200);
    assert.ok(result.latencyMs >= 0);
  });

  it("should detect 401 auth error", async () => {
    testServer = await makeTestServer((req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "authentication_error" } }));
    });

    const refreshCalled = [];
    const tokenPool = [{ name: "t1", token: "bad-token", type: "api_key_billed" }];
    const probe = createTokenHealthProbe({
      tokenPool,
      apiBase: testServer.url,
      apiVersion: "2023-06-01",
      modelIds: {},
      tokenRefresher: {
        handleAuthError: async (entry) => {
          refreshCalled.push(entry.name);
          return { refreshed: true };
        },
        getActiveToken: () => null,
      },
      log: () => {},
    });

    const result = await probe.probeToken(tokenPool[0]);
    assert.equal(result.status, "auth_error");
    assert.equal(result.statusCode, 401);
    // Wait a tick for the async refresh call
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(refreshCalled, ["t1"]);
  });

  it("should detect 429 rate limit and set cooldown", async () => {
    testServer = await makeTestServer((req, res) => {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "45",
      });
      res.end(JSON.stringify({ error: { type: "rate_limit_error" } }));
    });

    let cooldownSet = null;
    const tokenPool = [{ name: "t1", token: "tok", type: "oauth_flat" }];
    const probe = createTokenHealthProbe({
      tokenPool,
      apiBase: testServer.url,
      apiVersion: "2023-06-01",
      modelIds: {},
      setTokenCooldown: (entry, ms, reason) => {
        cooldownSet = { name: entry.name, ms, reason };
      },
      log: () => {},
    });

    const result = await probe.probeToken(tokenPool[0]);
    assert.equal(result.status, "rate_limited");
    assert.equal(result.statusCode, 429);
    assert.ok(result.retryMs >= 30_000);
    assert.ok(cooldownSet);
    assert.equal(cooldownSet.name, "t1");
    assert.equal(cooldownSet.reason, "probe_429");
  });

  it("should handle non-standard status codes", async () => {
    testServer = await makeTestServer((req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    });

    const tokenPool = [{ name: "t1", token: "tok", type: "api_key_billed" }];
    const probe = createTokenHealthProbe({
      tokenPool,
      apiBase: testServer.url,
      apiVersion: "2023-06-01",
      modelIds: {},
      log: () => {},
    });

    const result = await probe.probeToken(tokenPool[0]);
    assert.equal(result.status, "error");
    assert.equal(result.statusCode, 500);
  });

  it("should send correct auth headers for oauth_flat", async () => {
    let capturedHeaders = {};
    testServer = await makeTestServer((req, res) => {
      capturedHeaders = { ...req.headers };
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    const tokenPool = [{ name: "t1", token: "my-oauth-token", type: "oauth_flat" }];
    const probe = createTokenHealthProbe({
      tokenPool,
      apiBase: testServer.url,
      apiVersion: "2023-06-01",
      modelIds: {},
      log: () => {},
    });

    await probe.probeToken(tokenPool[0]);
    assert.equal(capturedHeaders.authorization, "Bearer my-oauth-token");
    assert.ok(capturedHeaders["anthropic-beta"]?.includes("oauth"));
  });

  it("should send correct auth headers for api_key_billed", async () => {
    let capturedHeaders = {};
    testServer = await makeTestServer((req, res) => {
      capturedHeaders = { ...req.headers };
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    const tokenPool = [{ name: "t1", token: "sk-my-key", type: "api_key_billed" }];
    const probe = createTokenHealthProbe({
      tokenPool,
      apiBase: testServer.url,
      apiVersion: "2023-06-01",
      modelIds: {},
      log: () => {},
    });

    await probe.probeToken(tokenPool[0]);
    assert.equal(capturedHeaders["x-api-key"], "sk-my-key");
    assert.equal(capturedHeaders.authorization, undefined);
  });

  it("should probeAll and track results", async () => {
    testServer = await makeTestServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    const tokenPool = [
      { name: "t1", token: "tok1", type: "api_key_billed" },
      { name: "t2", token: "tok2", type: "api_key_billed" },
    ];
    const probe = createTokenHealthProbe({
      tokenPool,
      apiBase: testServer.url,
      apiVersion: "2023-06-01",
      modelIds: {},
      log: () => {},
    });

    await probe.probeAll();
    const results = probe.getResults();
    assert.ok(results.t1);
    assert.ok(results.t2);
    assert.equal(results.t1.status, "verified");
    assert.equal(results.t2.status, "verified");
    assert.ok(results.t1.lastProbeAt > 0);
  });

  it("should use tokenRefresher.getActiveToken for live token", async () => {
    let usedToken = null;
    testServer = await makeTestServer((req, res) => {
      usedToken = req.headers["x-api-key"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    const tokenPool = [{ name: "t1", token: "old-token", type: "api_key_billed" }];
    const probe = createTokenHealthProbe({
      tokenPool,
      apiBase: testServer.url,
      apiVersion: "2023-06-01",
      modelIds: {},
      tokenRefresher: {
        getActiveToken: (name) => name === "t1" ? "fresh-token" : null,
      },
      log: () => {},
    });

    await probe.probeToken(tokenPool[0]);
    assert.equal(usedToken, "fresh-token");
  });

  it("should start and destroy cleanly", async () => {
    const tokenPool = [{ name: "t1", token: "tok", type: "api_key_billed" }];
    const probe = createTokenHealthProbe({
      tokenPool,
      apiBase: "http://127.0.0.1:1", // won't connect
      apiVersion: "2023-06-01",
      modelIds: {},
      intervalMs: 60_000,
      log: () => {},
    });

    probe.start();
    // Should not throw
    probe.destroy();
    // Calling destroy again should be safe
    probe.destroy();
  });
});
