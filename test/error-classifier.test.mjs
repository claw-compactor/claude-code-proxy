/**
 * Tests for lib/error-classifier.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyApiError } from "../lib/error-classifier.mjs";

describe("error-classifier", () => {
  it("should classify 401 as auth_error with refresh_retry", () => {
    const r = classifyApiError(401, "authentication_error");
    assert.equal(r.category, "auth_error");
    assert.equal(r.strategy, "refresh_retry");
    assert.equal(r.healable, true);
    assert.equal(r.retryable, true);
  });

  it("should classify 403 as auth_error", () => {
    const r = classifyApiError(403, "permission_error");
    assert.equal(r.category, "auth_error");
    assert.equal(r.strategy, "refresh_retry");
  });

  it("should classify 429 as rate_limited with cooldown_reroute", () => {
    const r = classifyApiError(429, "rate_limit_error");
    assert.equal(r.category, "rate_limited");
    assert.equal(r.strategy, "cooldown_reroute");
    assert.equal(r.healable, false);
    assert.equal(r.retryable, false);
  });

  it("should classify 500 as server_error with backoff_retry", () => {
    const r = classifyApiError(500, "api_error");
    assert.equal(r.category, "server_error");
    assert.equal(r.strategy, "backoff_retry");
    assert.equal(r.healable, true);
    assert.equal(r.retryable, true);
  });

  it("should classify 529 as server_error", () => {
    const r = classifyApiError(529, "overloaded_error");
    assert.equal(r.category, "server_error");
    assert.equal(r.strategy, "backoff_retry");
  });

  for (const code of [400, 404, 413, 200]) {
    it(`should classify ${code} as pass_through`, () => {
      const r = classifyApiError(code);
      assert.equal(r.category, "pass_through");
      assert.equal(r.strategy, "pass_through");
      assert.equal(r.healable, false);
      assert.equal(r.retryable, false);
    });
  }

  it("should return frozen objects", () => {
    assert.ok(Object.isFrozen(classifyApiError(500)));
    assert.ok(Object.isFrozen(classifyApiError(429)));
  });
});
