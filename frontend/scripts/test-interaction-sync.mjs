import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const require = createRequire(import.meta.url);
const babel = require("@babel/core");
const presetEnv = require("@babel/preset-env");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, "..");
const sourceDir = resolve(frontendDir, "src");
const originalJsLoader = require.extensions[".js"];

// Load the real ES-module services in Node without introducing a browser test
// runner into main CI. This exercises queue ownership and retry behavior.
require.extensions[".js"] = (module, filename) => {
  if (!filename.startsWith(sourceDir)) {
    originalJsLoader(module, filename);
    return;
  }
  const source = readFileSync(filename, "utf8");
  const transformed = babel.transformSync(source, {
    filename,
    presets: [[presetEnv, { targets: { node: "current" }, modules: "commonjs" }]]
  });
  module._compile(transformed.code, filename);
};

const { appConfig } = require(resolve(sourceDir, "config/appConfig.js"));
const {
  clearInteractionState,
  getInteractionOwner,
  hasPendingInteractions,
  interactionSessionStore,
  mergeInteractionState,
  nextInteractionEventSequence,
  queuePendingSignal,
  queuePendingSearch,
  readPendingInteractions,
  setInteractionOwner
} = require(resolve(sourceDir, "services/interactionStore.js"));
const { syncPendingInteractions } = require(resolve(sourceDir, "services/interactionService.js"));

function response(status, payload = {}, headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return normalizedHeaders[String(name).toLowerCase()] ?? null; } },
    async text() { return JSON.stringify(payload); }
  };
}

function queueSearches(owner, count) {
  setInteractionOwner(owner);
  clearInteractionState({ resetOwner: false });
  const baseNow = Date.now();
  for (let index = 0; index < count; index += 1) {
    queuePendingSearch(
      { query: `queued-${index}`, resultCount: index, filters: {} },
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      new Date(baseNow - ((count - index) * 1000)).toISOString()
    );
  }
}

function installFetch(responses, onCall = null) {
  const calls = [];
  const script = [...responses];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    onCall?.(calls.length, String(url));
    const next = script.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    return typeof next === "function" ? next() : next;
  };
  return calls;
}

function searchCallCount(calls) {
  return calls.filter(({ url }) => url.endsWith("/search-events")).length;
}

const originalSyncConfig = {
  batchSize: appConfig.interaction.pendingSyncBatchSize,
  pacingMs: appConfig.interaction.pendingSyncPacingMs,
  backoffMs: appConfig.interaction.pendingSyncBackoffMs,
  maxBackoffMs: appConfig.interaction.pendingSyncMaxBackoffMs
};
const sessionPayload = {
  session_id: "00000000-0000-4000-8000-000000000099",
  session_token: "test-session-token-0123456789"
};

test("replay is bounded and makes progress across batches", { concurrency: false }, async () => {
  appConfig.interaction.pendingSyncBatchSize = 2;
  appConfig.interaction.pendingSyncPacingMs = 0;
  queueSearches("sync-test-batch", 3);
  const calls = installFetch([
    response(201, sessionPayload),
    response(201, { accepted: true }),
    response(201, { accepted: true }),
    response(201, { accepted: true })
  ]);

  const firstBatch = await syncPendingInteractions([]);
  assert.equal(firstBatch.length, 2);
  assert.equal(searchCallCount(calls), 2);
  assert.equal(Object.keys(readPendingInteractions().searches).length, 1);

  const secondBatch = await syncPendingInteractions([]);
  assert.equal(secondBatch.length, 1);
  assert.equal(searchCallCount(calls), 3);
  assert.equal(hasPendingInteractions(), false);
});

test("429 stops replay, preserves the rest, and honors Retry-After", { concurrency: false }, async () => {
  appConfig.interaction.pendingSyncBatchSize = 10;
  appConfig.interaction.pendingSyncPacingMs = 0;
  appConfig.interaction.pendingSyncBackoffMs = 1000;
  appConfig.interaction.pendingSyncMaxBackoffMs = 5000;
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    queueSearches("sync-test-rate-limit", 3);
    const calls = installFetch([
      response(201, sessionPayload),
      response(201, { accepted: true }),
      response(429, { detail: "rate limited" }, { "Retry-After": "3" }),
      response(201, { accepted: true }),
      response(201, { accepted: true })
    ]);

    const rateLimited = await syncPendingInteractions([]);
    assert.equal(rateLimited.length, 2);
    assert.equal(rateLimited[1].status, "rejected");
    assert.equal(rateLimited[1].reason.status, 429);
    assert.equal(rateLimited[1].reason.retryAfterMs, 3000);
    assert.equal(searchCallCount(calls), 2);
    assert.equal(Object.keys(readPendingInteractions().searches).length, 2);

    const duringBackoff = await syncPendingInteractions([]);
    assert.deepEqual(duringBackoff, []);
    assert.equal(searchCallCount(calls), 2);

    now += 3000;
    const retried = await syncPendingInteractions([]);
    assert.equal(retried.length, 2);
    assert.equal(searchCallCount(calls), 4);
    assert.equal(hasPendingInteractions(), false);
  } finally {
    Date.now = originalNow;
  }
});

test("unavailable catalog entries do not starve available replay", { concurrency: false }, async () => {
  appConfig.interaction.pendingSyncBatchSize = 1;
  appConfig.interaction.pendingSyncPacingMs = 0;
  setInteractionOwner("sync-test-unavailable");
  clearInteractionState({ resetOwner: false });
  queuePendingSignal(
    "missing-title",
    { rating: 7, watchMinutes: 10 },
    "00000000-0000-4000-8000-000000000301",
    new Date(Date.now() - 2000).toISOString()
  );
  queuePendingSignal(
    "available-title",
    { rating: 8, watchMinutes: 20 },
    "00000000-0000-4000-8000-000000000302",
    new Date(Date.now() - 1000).toISOString()
  );
  const calls = installFetch([
    response(201, sessionPayload),
    response(201, { accepted: true })
  ]);

  const results = await syncPendingInteractions([{ id: "available-title" }]);

  assert.equal(searchCallCount(calls), 0);
  assert.equal(calls.filter(({ url }) => url.endsWith("/signals")).length, 1);
  assert.equal(results.some((result) => result.reason?.code === "CATALOG_RECORD_UNAVAILABLE"), true);
  assert.equal(Object.keys(readPendingInteractions().signals).length, 1);
  assert.equal(readPendingInteractions().signals["00000000-0000-4000-8000-000000000301"].showId, "missing-title");
});

test("pending same-title state follows device sequence rather than a moved clock", { concurrency: false }, () => {
  setInteractionOwner("sync-test-sequence");
  clearInteractionState({ resetOwner: false });
  const first = "00000000-0000-4000-8000-000000000311";
  const second = "00000000-0000-4000-8000-000000000312";
  queuePendingSignal("same-title", { rating: 2, watchMinutes: 1 }, first, new Date(Date.now() - 5000).toISOString());
  queuePendingSignal("same-title", { rating: 9, watchMinutes: 2 }, second, new Date(Date.now() - 6000).toISOString());
  // The queue assigns one device id and increasing sequences. The second
  // event has an earlier queued timestamp to reproduce a clock moving back.
  const merged = mergeInteractionState({ ratings: [] });
  assert.equal(merged.ratings["same-title"].rating, 9);
});

test("event sequence allocations remain distinct in one millisecond", { concurrency: false }, () => {
  setInteractionOwner("sync-test-sequence-allocations");
  clearInteractionState({ resetOwner: false });
  const originalNow = Date.now;
  Date.now = () => 2_000_000;
  try {
    const first = nextInteractionEventSequence();
    const second = nextInteractionEventSequence();
    assert.notEqual(first, second);
    assert.ok(second > first);
  } finally {
    Date.now = originalNow;
  }
});

test("owner changes stop a captured replay before the next event", { concurrency: false }, async () => {
  appConfig.interaction.pendingSyncBatchSize = 10;
  appConfig.interaction.pendingSyncPacingMs = 0;
  queueSearches("sync-test-owner-a", 2);
  let resolveFirst;
  const firstRequest = new Promise((resolve) => { resolveFirst = resolve; });
  const calls = installFetch([
    response(201, sessionPayload),
    () => firstRequest
  ], (callNumber, url) => {
    if (callNumber === 2 && url.endsWith("/search-events")) {
      setInteractionOwner("sync-test-owner-b");
    }
  });
  const pending = syncPendingInteractions([]);
  // Let the first request reach the mocked network, then change owner before
  // it resolves. The stale snapshot must not send its second event.
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolveFirst(response(201, { accepted: true }));
  const results = await pending;
  assert.equal(searchCallCount(calls), 1);
  assert.equal(results.at(-1).reason?.code, "INTERACTION_OWNER_CHANGED");
  assert.equal(hasPendingInteractions("sync-test-owner-b"), false);
  // The in-flight first event is also kept because its response belonged to
  // the stale owner generation; a later retry can safely replay both under A.
  assert.equal(Object.keys(readPendingInteractions("sync-test-owner-a").searches).length, 2);
});

test("owner switch stays memory-consistent when localStorage rejects the write", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const ownerKey = appConfig.interaction.ownerStorageKey;
  const values = new Map([[ownerKey, JSON.stringify("anonymous")]]);
  globalThis.window = {
    localStorage: {
      get length() { return values.size; },
      key(index) { return [...values.keys()][index] ?? null; },
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) {
        if (key === ownerKey) throw new Error("quota exceeded");
        values.set(key, String(value));
      },
      removeItem(key) { values.delete(key); }
    },
    location: { pathname: "/" }
  };
  try {
    const transition = setInteractionOwner("storage-failure-user");
    assert.equal(transition.changed, true);
    assert.equal(transition.persisted, false);
    assert.equal(getInteractionOwner(), "storage-failure-user");
    assert.equal(JSON.parse(values.get(ownerKey)), "anonymous");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("memory-only outbox entries remain visible and replayable after quota failure", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const outboxPrefix = `${appConfig.interaction.outboxStorageKey}:entry:`;
  const values = new Map();
  globalThis.window = {
    localStorage: {
      get length() { return values.size; },
      key(index) { return [...values.keys()][index] ?? null; },
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) {
        if (key.startsWith(outboxPrefix)) throw new Error("quota exceeded");
        values.set(key, String(value));
      },
      removeItem(key) { values.delete(key); }
    },
    location: { pathname: "/" }
  };
  try {
    setInteractionOwner("memory-outbox-owner");
    queuePendingSearch({ query: "memory queue", resultCount: 1, filters: {} });
    assert.equal(Object.keys(readPendingInteractions().searches).length, 1);
    const calls = installFetch([
      response(201, sessionPayload),
      response(201, { accepted: true })
    ]);
    const results = await syncPendingInteractions([]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(searchCallCount(calls), 1);
    assert.equal(hasPendingInteractions(), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a session id without its token is treated as unusable", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const sessionKey = appConfig.interaction.sessionStorageKey;
  const values = new Map([[sessionKey, JSON.stringify("00000000-0000-4000-8000-000000000099")]]);
  globalThis.window = {
    localStorage: {
      get length() { return values.size; },
      key(index) { return [...values.keys()][index] ?? null; },
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); }
    },
    location: { pathname: "/" }
  };
  try {
    setInteractionOwner("session-pair-owner");
    assert.equal(interactionSessionStore.read(), null);
    assert.equal(values.has(sessionKey), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("session id and proof stay atomic when the pair write is rejected", { concurrency: false }, () => {
  const originalWindow = globalThis.window;
  const sessionKey = `${appConfig.interaction.sessionStorageKey}:pair`;
  const ownerKey = appConfig.interaction.ownerStorageKey;
  const owner = "atomic-session-owner";
  const firstSession = "00000000-0000-4000-8000-000000000101";
  const nextSession = "00000000-0000-4000-8000-000000000102";
  const firstToken = "first-session-token-0123456789";
  const nextToken = "next-session-token-0123456789";
  const values = new Map([
    [ownerKey, JSON.stringify("anonymous")],
    [sessionKey, JSON.stringify({ version: 2, owners: { [owner]: { sessionId: firstSession, sessionToken: firstToken } } })]
  ]);
  globalThis.window = {
    localStorage: {
      get length() { return values.size; },
      key(index) { return [...values.keys()][index] ?? null; },
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) {
        if (key === sessionKey) throw new Error("quota exceeded");
        values.set(key, String(value));
      },
      removeItem(key) { values.delete(key); }
    },
    location: { pathname: "/" }
  };
  try {
    clearInteractionState({ resetOwner: true });
    values.set(ownerKey, JSON.stringify("anonymous"));
    values.set(sessionKey, JSON.stringify({ version: 2, owners: { [owner]: { sessionId: firstSession, sessionToken: firstToken } } }));
    setInteractionOwner(owner);
    interactionSessionStore.write(nextSession, nextToken, owner);
    assert.equal(interactionSessionStore.read(owner), nextSession);
    assert.equal(interactionSessionStore.readToken(owner), nextToken);
    assert.deepEqual(JSON.parse(values.get(sessionKey)).owners[owner], {
      sessionId: firstSession,
      sessionToken: firstToken
    });
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

after(() => {
  appConfig.interaction.pendingSyncBatchSize = originalSyncConfig.batchSize;
  appConfig.interaction.pendingSyncPacingMs = originalSyncConfig.pacingMs;
  appConfig.interaction.pendingSyncBackoffMs = originalSyncConfig.backoffMs;
  appConfig.interaction.pendingSyncMaxBackoffMs = originalSyncConfig.maxBackoffMs;
  clearInteractionState({ resetOwner: true });
});
