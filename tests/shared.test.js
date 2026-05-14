import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCurlCommand,
  filterCaptures,
  normalizeCapture,
  serializeForExport,
} from "../src/shared.js";

test("normalizeCapture clamps long bodies and preserves request response shape", () => {
  const capture = normalizeCapture({
    id: "abc",
    method: "post",
    url: "https://example.test/api/login",
    requestHeaders: [{ name: "content-type", value: "application/json" }],
    requestBody: "x".repeat(80_000),
    responseHeaders: [{ name: "x-trace", value: "123" }],
    responseBody: '{"ok":true}',
    status: 201,
    durationMs: 42.6,
    startedAt: 1_715_000_000_000,
    pageUrl: "https://example.test/",
  });

  assert.equal(capture.method, "POST");
  assert.equal(capture.status, 201);
  assert.equal(capture.durationMs, 43);
  assert.equal(capture.requestBody.length, 65_566);
  assert.match(capture.requestBody, /\[truncated 14464 characters\]$/);
  assert.deepEqual(capture.requestHeaders, [
    { name: "content-type", value: "application/json" },
  ]);
  assert.equal(capture.responseBody, '{"ok":true}');
});

test("filterCaptures matches method status and text query", () => {
  const captures = [
    normalizeCapture({ method: "GET", url: "https://app.test/users", status: 200 }),
    normalizeCapture({ method: "POST", url: "https://app.test/login", status: 401 }),
    normalizeCapture({ method: "DELETE", url: "https://api.test/users/7", status: 204 }),
  ];

  assert.deepEqual(
    filterCaptures(captures, { method: "POST", statusGroup: "4xx", query: "login" }).map(
      (capture) => capture.url,
    ),
    ["https://app.test/login"],
  );
  assert.equal(filterCaptures(captures, { query: "users" }).length, 2);
});

test("buildCurlCommand emits headers body and escaped values", () => {
  const curl = buildCurlCommand(
    normalizeCapture({
      method: "POST",
      url: "https://api.test/search?q=codex",
      requestHeaders: [
        { name: "content-type", value: "application/json" },
        { name: "x-note", value: "it's fine" },
      ],
      requestBody: '{"term":"burp"}',
    }),
  );

  assert.match(curl, /^curl -i -X POST/);
  assert.match(curl, /'https:\/\/api\.test\/search\?q=codex'/);
  assert.match(curl, /-H 'content-type: application\/json'/);
  assert.match(curl, /-H 'x-note: it'\\''s fine'/);
  assert.match(curl, /--data-raw '\{"term":"burp"\}'/);
});

test("serializeForExport writes a stable JSON envelope", () => {
  const json = serializeForExport([
    normalizeCapture({ id: "one", method: "GET", url: "https://example.test" }),
  ]);
  const parsed = JSON.parse(json);

  assert.equal(parsed.tool, "Request Lens");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.captures[0].id, "one");
  assert.ok(parsed.exportedAt);
});
