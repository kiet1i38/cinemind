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
const { createJsonStore } = require(resolve(sourceDir, "services/browserStore.js"));
const { fetchWithTimeout } = require(resolve(sourceDir, "services/fetchWithTimeout.js"));
const {
  clearInteractionState,
  beginAuthenticatedInteractionPromotion,
  clearPendingAuthenticatedInteractionPromotion,
  deleteOwnerScopedSignal,
  getInteractionDeviceId,
  getInteractionOwner,
  hasPendingInteractions,
  acknowledgePendingSignal,
  acknowledgePendingSearch,
  interactionSessionStore,
  mergeInteractionState,
  nextInteractionEventSequence,
  pendingInteractionsPersisted,
  readPendingOwnerTransfer,
  queuePendingSignal,
  queuePendingSearch,
  readOwnerScopedSignalState,
  readPendingInteractions,
  replaceOwnerScopedSignalState,
  setInteractionOwner,
  signalWithServerReceipt,
  writeOwnerScopedSignalState,
  withInteractionSessionCreationLock
} = require(resolve(sourceDir, "services/interactionStore.js"));
const { signalStore } = require(resolve(sourceDir, "services/signalStore.js"));
const {
  getInteractionState,
  hasFulfilledSignal,
  submitSignal,
  syncPendingInteractions
} = require(resolve(sourceDir, "services/interactionService.js"));
const { getCurrentUser, login } = require(resolve(sourceDir, "services/authService.js"));

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

function mapStorage(values) {
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

test("a response body that stalls after headers still reaches the timeout", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    text() {
      return new Promise(() => {});
    }
  });
  try {
    const response = await fetchWithTimeout("/body-stalls", {}, 15);
    await assert.rejects(
      response.text(),
      (error) => error?.code === "REQUEST_TIMEOUT",
    );
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

test("a headers-only timeout removes its external abort listener", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const originalAbortController = globalThis.AbortController;
  let removeCount = 0;
  const externalSignal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() { removeCount += 1; }
  };
  class TestAbortController {
    signal = { aborted: false };

    abort() {
      this.signal.aborted = true;
    }
  }
  globalThis.AbortController = TestAbortController;
  globalThis.fetch = async () => ({
    text() {
      return new Promise(() => {});
    }
  });
  try {
    await fetchWithTimeout("/headers-only", { signal: externalSignal }, 15);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(removeCount, 1);
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    if (originalAbortController === undefined) delete globalThis.AbortController;
    else globalThis.AbortController = originalAbortController;
  }
});

test("a stale state 404 cannot clear a session rotated by another tab", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const owner = "stale-session-state-race";
  const staleSessionId = "00000000-0000-4000-8000-000000000901";
  const currentSessionId = "00000000-0000-4000-8000-000000000902";
  const calls = [];
  globalThis.window = { localStorage: mapStorage(new Map()), location: { pathname: "/" } };
  try {
    setInteractionOwner(owner);
    interactionSessionStore.write(staleSessionId, "stale-session-token-0123456789", owner);
    globalThis.fetch = async (url, options) => {
      const parsedBody = options?.body ? JSON.parse(options.body) : null;
      calls.push({ url: String(url), body: parsedBody });
      if (String(url).endsWith(`/state/${staleSessionId}`)) {
        // The other tab rotated the shared session before this old 404 arrived.
        interactionSessionStore.write(currentSessionId, "current-session-token-0123456789", owner);
        return response(404, { detail: { code: "SESSION_NOT_FOUND", message: "expired" } });
      }
      if (String(url).endsWith(`/state/${currentSessionId}`)) return response(200, { ratings: [], snapshot_at: "2026-09-16T12:00:00.000Z" });
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(parsedBody)}`);
    };

    await getInteractionState({ locale: "en", platform: "test" });

    assert.deepEqual(calls.map(({ url }) => url), [
      `/api/interaction/state/${staleSessionId}`,
      `/api/interaction/state/${currentSessionId}`
    ]);
    assert.equal(interactionSessionStore.read(owner), currentSessionId);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    clearInteractionState({ resetOwner: true });
  }
});

test("session recovery does not clear a session written after its compare read", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const owner = "stale-session-clear-race";
  const staleSessionId = "00000000-0000-4000-8000-000000000905";
  const currentSessionId = "00000000-0000-4000-8000-000000000906";
  const replacementSessionId = "00000000-0000-4000-8000-000000000907";
  const calls = [];
  const values = new Map();
  const baseStorage = mapStorage(values);
  const pairKey = `${appConfig.interaction.sessionStorageKey}:pair:owner:${encodeURIComponent(owner)}`;
  let injectRotation = false;
  let injected = false;
  const storage = {
    get length() { return baseStorage.length; },
    key(index) { return baseStorage.key(index); },
    getItem(key) {
      const value = baseStorage.getItem(key);
      if (injectRotation && !injected && key === pairKey) {
        injected = true;
        baseStorage.setItem(key, JSON.stringify({
          version: 1,
          value: {
            sessionId: currentSessionId,
            sessionToken: "current-session-token-0123456789"
          }
        }));
      }
      return value;
    },
    setItem(key, value) { baseStorage.setItem(key, value); },
    removeItem(key) { baseStorage.removeItem(key); }
  };
  globalThis.window = { localStorage: storage, location: { pathname: "/" } };
  try {
    setInteractionOwner(owner);
    interactionSessionStore.write(staleSessionId, "stale-session-token-0123456789", owner);
    globalThis.fetch = async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).endsWith(`/state/${staleSessionId}`)) {
        // The next pair read happens inside recovery after the stale 404.
        injectRotation = true;
        return response(404, { detail: { code: "SESSION_NOT_FOUND", message: "expired" } });
      }
      if (String(url).endsWith(`/state/${currentSessionId}`)) {
        return response(200, { ratings: [], snapshot_at: "2026-09-16T12:00:00.000Z" });
      }
      if (String(url).endsWith(`/state/${replacementSessionId}`)) {
        return response(200, { ratings: [], snapshot_at: "2026-09-16T12:00:00.000Z" });
      }
      if (String(url).endsWith("/sessions")) {
        return response(201, {
          session_id: replacementSessionId,
          session_token: "replacement-session-token-0123456789"
        });
      }
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(body)}`);
    };

    await getInteractionState({ locale: "en", platform: "test" });

    assert.equal(injected, true);
    assert.deepEqual(calls.map(({ url }) => url), [
      `/api/interaction/state/${staleSessionId}`,
      `/api/interaction/state/${currentSessionId}`
    ]);
    assert.equal(interactionSessionStore.read(owner), currentSessionId);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    clearInteractionState({ resetOwner: true });
  }
});

test("session recovery can clear an explicitly owned legacy aggregate pair", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const owner = "legacy-session-recovery";
  const staleSessionId = "00000000-0000-4000-8000-000000000908";
  const replacementSessionId = "00000000-0000-4000-8000-000000000909";
  const calls = [];
  const values = new Map();
  const aggregateKey = `${appConfig.interaction.sessionStorageKey}:pair`;
  values.set(aggregateKey, JSON.stringify({
    version: 2,
    owners: {
      [owner]: {
        sessionId: staleSessionId,
        sessionToken: "legacy-session-token-0123456789"
      }
    }
  }));
  globalThis.window = { localStorage: mapStorage(values), location: { pathname: "/" } };
  try {
    setInteractionOwner(owner);
    globalThis.fetch = async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).endsWith(`/state/${staleSessionId}`)) {
        return response(404, { detail: { code: "SESSION_NOT_FOUND", message: "expired" } });
      }
      if (String(url).endsWith("/sessions")) {
        return response(201, {
          session_id: replacementSessionId,
          session_token: "replacement-session-token-0123456789"
        });
      }
      if (String(url).endsWith(`/state/${replacementSessionId}`)) {
        return response(200, { ratings: [], snapshot_at: "2026-09-16T12:00:00.000Z" });
      }
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(body)}`);
    };

    await getInteractionState({ locale: "en", platform: "test" });

    assert.deepEqual(calls.map(({ url }) => url), [
      `/api/interaction/state/${staleSessionId}`,
      "/api/interaction/sessions",
      `/api/interaction/state/${replacementSessionId}`
    ]);
    assert.equal(interactionSessionStore.read(owner), replacementSessionId);
    assert.equal(values.has(aggregateKey), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    clearInteractionState({ resetOwner: true });
  }
});

test("a stale signal 404 retries the session currently owned by another tab", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const owner = "stale-session-signal-race";
  const staleSessionId = "00000000-0000-4000-8000-000000000903";
  const currentSessionId = "00000000-0000-4000-8000-000000000904";
  const record = { id: "stale-session-signal-title" };
  const calls = [];
  globalThis.window = { localStorage: mapStorage(new Map()), location: { pathname: "/" } };
  try {
    setInteractionOwner(owner);
    interactionSessionStore.write(staleSessionId, "stale-signal-token-0123456789", owner);
    globalThis.fetch = async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/signals") && body?.session_id === staleSessionId) {
        interactionSessionStore.write(currentSessionId, "current-signal-token-0123456789", owner);
        return response(404, { detail: { code: "SESSION_NOT_FOUND", message: "expired" } });
      }
      if (String(url).endsWith("/signals") && body?.session_id === currentSessionId) return response(201, { accepted: true });
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(body)}`);
    };

    await submitSignal({ record, rating: 8, watchMinutes: 5 });

    assert.deepEqual(calls.filter(({ url }) => url.endsWith("/signals")).map(({ body }) => body.session_id), [
      staleSessionId,
      currentSessionId
    ]);
    assert.equal(calls.some(({ url }) => url.endsWith("/sessions")), false);
    assert.equal(interactionSessionStore.read(owner), currentSessionId);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    clearInteractionState({ resetOwner: true });
  }
});

test("a failed storage removal cannot delete a newer value from another tab", { concurrency: false }, () => {
  const originalWindow = globalThis.window;
  const key = "browser-store-remove-race-20260916";
  const values = new Map([[key, JSON.stringify({ owner: "old" })]]);
  let failRemove = true;
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(storageKey) { return values.get(storageKey) ?? null; },
    setItem(storageKey, value) { values.set(storageKey, String(value)); },
    removeItem(storageKey) {
      if (failRemove) throw new Error("storage temporarily unavailable");
      values.delete(storageKey);
    }
  };
  globalThis.window = { localStorage: storage, location: { pathname: "/" } };
  try {
    const store = createJsonStore(key, { owner: "fallback" });
    assert.deepEqual(store.read(), { owner: "old" });
    assert.equal(store.remove(), false);

    // A second tab writes while the first tab's removal tombstone is pending.
    values.set(key, JSON.stringify({ owner: "new" }));
    failRemove = false;

    assert.deepEqual(store.read(), { owner: "new" });
    assert.deepEqual(JSON.parse(values.get(key)), { owner: "new" });
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("a recovered durable value wins when a memory fallback had no readable baseline", { concurrency: false }, () => {
  const originalWindow = globalThis.window;
  const key = "browser-store-unreadable-baseline-20260916";
  const values = new Map();
  let storageReadable = false;
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(name) {
      if (!storageReadable && name === key) throw new Error("storage read blocked");
      return values.get(name) ?? null;
    },
    setItem(name, value) {
      if (!storageReadable && name === key) throw new Error("storage write blocked");
      values.set(name, String(value));
    },
    removeItem(name) { values.delete(name); }
  };
  globalThis.window = { localStorage: storage, location: { pathname: "/" } };
  try {
    const store = createJsonStore(key, null);
    assert.equal(store.write({ source: "stale-tab" }), false);
    values.set(key, JSON.stringify({ source: "newer-tab" }));
    storageReadable = true;
    assert.deepEqual(store.read(), { source: "newer-tab" });
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("silent storage writes stay memory-only until a durable value can be verified", { concurrency: false }, () => {
  const originalWindow = globalThis.window;
  const key = "browser-store-silent-write-20260916";
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(name) { return values.get(name) ?? null; },
    setItem() {
      // Simulate a privacy/storage adapter that silently drops the write.
    },
    removeItem(name) { values.delete(name); }
  };
  globalThis.window = { localStorage: storage, location: { pathname: "/" } };
  try {
    const store = createJsonStore(key, null);
    assert.equal(store.write({ source: "memory-only" }), false);
    assert.deepEqual(store.read(), { source: "memory-only" });

    values.set(key, JSON.stringify({ source: "durable-tab" }));
    assert.deepEqual(store.read(), { source: "durable-tab" });
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("silent storage removals remain pending until the key is actually gone", { concurrency: false }, () => {
  const originalWindow = globalThis.window;
  const key = "browser-store-silent-remove-20260916";
  const values = new Map([[key, JSON.stringify({ owner: "old" })]]);
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(name) { return values.get(name) ?? null; },
    setItem(name, value) { values.set(name, String(value)); },
    removeItem() {
      // Simulate a silent no-op instead of throwing.
    }
  };
  globalThis.window = { localStorage: storage, location: { pathname: "/" } };
  try {
    const store = createJsonStore(key, { owner: "fallback" });
    assert.deepEqual(store.read(), { owner: "old" });
    assert.equal(store.remove(), false);
    assert.equal(values.has(key), true);

    values.delete(key);
    assert.deepEqual(store.read(), { owner: "fallback" });
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

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

test("offline replay keeps device event order when queued timestamps tie", { concurrency: false }, async () => {
  appConfig.interaction.pendingSyncBatchSize = 10;
  appConfig.interaction.pendingSyncPacingMs = 0;
  setInteractionOwner("sync-test-replay-sequence");
  clearInteractionState({ resetOwner: false });
  const originalNow = Date.now;
  Date.now = () => 3_000_000;
  try {
    const firstMutation = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const secondMutation = "00000000-0000-4000-8000-000000000401";
    const queuedAt = new Date(Date.now()).toISOString();
    queuePendingSignal("same-title", { rating: 3, watchMinutes: 1 }, firstMutation, queuedAt);
    queuePendingSignal("same-title", { rating: 9, watchMinutes: 2 }, secondMutation, queuedAt);
    assert.deepEqual(Object.values(readPendingInteractions().signals).map((entry) => entry.rating), [3, 9]);
    const calls = installFetch([
      response(201, sessionPayload),
      response(201, { accepted: true }),
      response(201, { accepted: true })
    ]);

    await syncPendingInteractions([{ id: "same-title" }]);
    const ratings = calls
      .filter(({ url }) => url.endsWith("/signals"))
      .map(({ body }) => body.rating);
    assert.deepEqual(ratings, [3, 9]);
  } finally {
    Date.now = originalNow;
  }
});

test("device and sequence state are isolated per browser tab", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const localValues = new Map();
  const firstTabValues = new Map();
  const secondTabValues = new Map();
  const firstTabStorage = mapStorage(firstTabValues);
  const deviceKey = appConfig.interaction.deviceStorageKey;
  const sequenceKey = appConfig.interaction.sequenceStorageKey;
  globalThis.window = {
    localStorage: mapStorage(localValues),
    sessionStorage: firstTabStorage,
    location: { pathname: "/" }
  };
  try {
    const firstDevice = getInteractionDeviceId();
    const firstSequence = nextInteractionEventSequence();
    const secondSequence = nextInteractionEventSequence();

    assert.match(firstDevice, /^[0-9a-f-]{36}$/iu);
    assert.equal(secondSequence, firstSequence + 1);
    assert.equal(localValues.has(deviceKey), false);
    assert.equal(localValues.has(sequenceKey), false);
    assert.equal(JSON.parse(firstTabValues.get(sequenceKey)), secondSequence);

    // A tab opened with an opener starts from a clone of the opener's
    // sessionStorage. It must fork the stream before allocating a new event.
    secondTabValues.clear();
    for (const [key, value] of firstTabValues) secondTabValues.set(key, value);
    globalThis.window.sessionStorage = mapStorage(secondTabValues);
    globalThis.window.opener = { sessionStorage: firstTabStorage };
    const secondDevice = getInteractionDeviceId();
    const secondTabSequence = nextInteractionEventSequence();
    assert.notEqual(secondDevice, firstDevice);
    assert.equal(secondTabSequence, 1);

    // A reload creates a new JS module context but retains the same
    // sessionStorage and opener. The fork parent marker must keep this
    // already-forked stream stable.
    globalThis.window.sessionStorage = mapStorage(secondTabValues);
    const reloadedDevice = getInteractionDeviceId();
    const reloadedSequence = nextInteractionEventSequence();
    assert.equal(reloadedDevice, secondDevice);
    assert.equal(reloadedSequence, secondTabSequence + 1);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a duplicate browsing context without an opener forks a live stream lease", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  const sessionValues = new Map();
  const deviceKey = appConfig.interaction.deviceStorageKey;
  const deviceId = "00000000-0000-4000-8000-000000000271";
  values.set(
    `${deviceKey}:active:${encodeURIComponent(deviceId)}`,
    JSON.stringify({ claimId: "another-live-document", touchedAt: Date.now() }),
  );
  sessionValues.set(deviceKey, JSON.stringify(deviceId));
  globalThis.window = {
    localStorage: mapStorage(values),
    sessionStorage: mapStorage(sessionValues),
    location: { pathname: "/" }
  };
  try {
    const forkedDevice = getInteractionDeviceId();
    assert.notEqual(forkedDevice, deviceId);
    assert.equal(nextInteractionEventSequence(), 1);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a failed device-stream claim forks instead of reusing a cloned stream", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const deviceKey = appConfig.interaction.deviceStorageKey;
  const sequenceKey = appConfig.interaction.sequenceStorageKey;
  const clonedDevice = "00000000-0000-4000-8000-000000000272";
  const sessionValues = new Map([
    [deviceKey, JSON.stringify(clonedDevice)],
    [sequenceKey, JSON.stringify(7)]
  ]);
  const unavailableStorage = {
    get length() { throw new Error("storage unavailable"); },
    getItem() { throw new Error("storage unavailable"); },
    setItem() { throw new Error("storage unavailable"); },
    removeItem() { throw new Error("storage unavailable"); }
  };
  globalThis.window = {
    localStorage: unavailableStorage,
    sessionStorage: mapStorage(sessionValues),
    navigator: {},
    location: { pathname: "/" }
  };
  try {
    const forkedDevice = getInteractionDeviceId();
    assert.notEqual(forkedDevice, clonedDevice);
    assert.equal(nextInteractionEventSequence(), 1);
    assert.equal(getInteractionDeviceId(), forkedDevice);
    assert.equal(nextInteractionEventSequence(), 2);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a silent device-stream claim stays stable after the initial fork", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const deviceKey = appConfig.interaction.deviceStorageKey;
  const sequenceKey = appConfig.interaction.sequenceStorageKey;
  const clonedDevice = "00000000-0000-4000-8000-000000000273";
  const sessionValues = new Map([
    [deviceKey, JSON.stringify(clonedDevice)],
    [sequenceKey, JSON.stringify(4)]
  ]);
  const silentStorage = {
    get length() { return 0; },
    key() { return null; },
    getItem() { return null; },
    setItem() {
      // The adapter silently ignores the active-stream claim.
    },
    removeItem() {}
  };
  globalThis.window = {
    localStorage: silentStorage,
    sessionStorage: mapStorage(sessionValues),
    navigator: {},
    location: { pathname: "/" }
  };
  try {
    const forkedDevice = getInteractionDeviceId();
    assert.notEqual(forkedDevice, clonedDevice);
    assert.equal(nextInteractionEventSequence(), 1);
    assert.equal(getInteractionDeviceId(), forkedDevice);
    assert.equal(nextInteractionEventSequence(), 2);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("browser device stream survives reload through session storage", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const localValues = new Map();
  const sessionValues = new Map();
  const deviceKey = appConfig.interaction.deviceStorageKey;
  const sequenceKey = appConfig.interaction.sequenceStorageKey;
  globalThis.window = {
    localStorage: mapStorage(localValues),
    sessionStorage: mapStorage(sessionValues),
    navigator: {},
    location: { pathname: "/" }
  };
  try {
    const deviceId = getInteractionDeviceId();
    const firstSequence = nextInteractionEventSequence();
    assert.equal(JSON.parse(sessionValues.get(deviceKey)), deviceId);
    assert.equal(JSON.parse(sessionValues.get(sequenceKey)), firstSequence);

    // A later page load in the same tab reads the persisted stream instead of
    // silently starting a new device sequence for the same offline outbox.
    assert.equal(getInteractionDeviceId(), deviceId);
    assert.equal(nextInteractionEventSequence(), firstSequence + 1);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("storage failure never publishes a non-durable event sequence", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "sync-test-sequence-storage-failure";
  const localValues = new Map();
  const sessionValues = new Map();
  const sequenceKey = appConfig.interaction.sequenceStorageKey;
  const deviceKey = appConfig.interaction.deviceStorageKey;
  let rejectSequenceWrites = true;
  const sessionStorage = {
    get length() { return sessionValues.size; },
    key(index) { return [...sessionValues.keys()][index] ?? null; },
    getItem(key) { return sessionValues.get(key) ?? null; },
    setItem(key, value) {
      if (rejectSequenceWrites && key === sequenceKey) throw new Error("quota exceeded");
      sessionValues.set(key, String(value));
    },
    removeItem(key) { sessionValues.delete(key); }
  };
  globalThis.window = {
    localStorage: mapStorage(localValues),
    sessionStorage,
    location: { pathname: "/" }
  };
  try {
    setInteractionOwner(owner);
    const mutationId = "00000000-0000-4000-8000-000000000718";
    queuePendingSignal("storage-failure-title", { rating: 8, watchMinutes: 4 }, mutationId);
    const pending = readPendingInteractions(owner).signals[mutationId];
    assert.equal(pending.clientDeviceId, null);
    assert.equal(pending.clientEventSequence, null);
    assert.equal(sessionValues.has(sequenceKey), false);
    assert.equal(sessionValues.has(deviceKey), false);

    // Re-queueing the same mutation after storage recovers must not assign a
    // different event identity to an already-created server intent.
    rejectSequenceWrites = false;
    queuePendingSignal("storage-failure-title", { rating: 9, watchMinutes: 5 }, mutationId);
    const retried = readPendingInteractions(owner).signals[mutationId];
    assert.equal(retried.clientDeviceId, null);
    assert.equal(retried.clientEventSequence, null);
    assert.equal(sessionValues.has(sequenceKey), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a recovered signal storage fallback cannot overwrite a newer durable tab value", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "signal-storage-recovery-race";
  const showId = "signal-storage-recovery-title";
  const values = new Map();
  const signalPrefix = `${appConfig.signals.storageKey}:entry:`;
  let rejectSignalWrites = true;
  const localStorage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      if (rejectSignalWrites && key.startsWith(signalPrefix)) throw new Error("storage temporarily unavailable");
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); }
  };
  const sessionStorage = mapStorage(new Map());
  globalThis.window = {
    localStorage,
    sessionStorage,
    location: { pathname: "/" }
  };
  try {
    setInteractionOwner(owner);
    const localOnly = { rating: 4, watchMinutes: 2, savedAt: "2026-09-16T10:00:00.000Z" };
    assert.equal(writeOwnerScopedSignalState({ [showId]: localOnly }), false);

    rejectSignalWrites = false;
    const key = `${signalPrefix}${encodeURIComponent(owner)}:${encodeURIComponent(showId)}`;
    const durableOtherTab = { rating: 9, watchMinutes: 8, savedAt: "2026-09-16T10:01:00.000Z" };
    localStorage.setItem(key, JSON.stringify(durableOtherTab));

    const recovered = readOwnerScopedSignalState(owner);
    assert.equal(recovered[showId].rating, 9);
    assert.equal(recovered[showId].watchMinutes, 8);
  } finally {
    globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a recovered signal storage fallback cannot resurrect a value removed by another tab", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "signal-storage-removal-race";
  const showId = "signal-storage-removal-title";
  const values = new Map();
  const signalPrefix = `${appConfig.signals.storageKey}:entry:`;
  let rejectSignalWrites = false;
  const localStorage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      if (rejectSignalWrites && key.startsWith(signalPrefix)) throw new Error("storage temporarily unavailable");
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); }
  };
  const sessionStorage = mapStorage(new Map());
  globalThis.window = {
    localStorage,
    sessionStorage,
    location: { pathname: "/" }
  };
  try {
    setInteractionOwner(owner);
    const key = `${signalPrefix}${encodeURIComponent(owner)}:${encodeURIComponent(showId)}`;
    const durableValue = { rating: 6, watchMinutes: 3, savedAt: "2026-09-16T10:00:00.000Z" };
    assert.equal(writeOwnerScopedSignalState({ [showId]: durableValue }), true);

    rejectSignalWrites = true;
    const staleFallback = { rating: 2, watchMinutes: 1, savedAt: "2026-09-16T10:01:00.000Z" };
    assert.equal(writeOwnerScopedSignalState({ [showId]: staleFallback }), false);

    // Simulate another tab removing the durable entry before this tab's
    // storage access recovers.
    localStorage.removeItem(key);
    rejectSignalWrites = false;
    const recovered = readOwnerScopedSignalState(owner);
    assert.equal(recovered[showId], undefined);
    assert.equal(localStorage.getItem(key), null);
  } finally {
    globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("acknowledged outbox entries do not accumulate sidecar tombstones", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const originalMaxItems = appConfig.interaction.pendingMutationMaxItems;
  appConfig.interaction.pendingMutationMaxItems = 2;
  const values = new Map();
  globalThis.window = {
    localStorage: mapStorage(values),
    sessionStorage: mapStorage(new Map()),
    location: { pathname: "/" }
  };
  const owner = "sync-test-tombstone-retention";
  try {
    setInteractionOwner(owner);
    clearInteractionState({ resetOwner: false });
    for (let index = 0; index < 8; index += 1) {
      const mutationId = `00000000-0000-4000-8000-${String(index + 801).padStart(12, "0")}`;
      queuePendingSearch(
        { query: `completed-${index}`, resultCount: index, filters: {} },
        mutationId,
      );
      const pending = readPendingInteractions(owner).searches[mutationId];
      acknowledgePendingSearch(mutationId, owner, pending);
    }

    const ownerPrefix = encodeURIComponent(owner);
    const rawEntries = [...values.keys()].filter((key) => key.includes(`:entry:${ownerPrefix}:searches:`));
    const sidecarTombstones = [...values.keys()].filter((key) => key.includes(`:tombstone:${ownerPrefix}:searches:`));
    assert.equal(rawEntries.length, 0);
    assert.ok(sidecarTombstones.length <= 2);
    assert.equal(Object.keys(readPendingInteractions(owner).searches).length, 0);
  } finally {
    appConfig.interaction.pendingMutationMaxItems = originalMaxItems;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("clearing after a non-durable acknowledgement removes the raw fallback entry", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "sync-test-nondurable-ack-clear";
  const values = new Map();
  const baseStorage = mapStorage(values);
  globalThis.window = {
    localStorage: {
      get length() { return baseStorage.length; },
      key(index) { return baseStorage.key(index); },
      getItem(key) { return baseStorage.getItem(key); },
      setItem(key, value) {
        if (key.includes(":tombstone:")) throw new Error("quota exceeded");
        baseStorage.setItem(key, value);
      },
      removeItem(key) { baseStorage.removeItem(key); }
    },
    sessionStorage: mapStorage(new Map()),
    location: { pathname: "/" }
  };
  const mutationId = "00000000-0000-4000-8000-000000000803";
  try {
    queuePendingSearch({ query: "ack-clear", resultCount: 1, filters: {} }, mutationId, null, owner);
    const pending = readPendingInteractions(owner).searches[mutationId];
    acknowledgePendingSearch(mutationId, owner, pending);

    assert.equal(readPendingInteractions(owner).searches[mutationId], undefined);
    assert.ok([...values.keys()].some((key) => key.includes(":entry:") && key.includes(mutationId)));

    clearInteractionState({ ownerId: owner, resetOwner: false });

    assert.equal(readPendingInteractions(owner).searches[mutationId], undefined);
    assert.equal([...values.keys()].some((key) => key.includes(":entry:") && key.includes(mutationId)), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("signalStore overlays pending per-entry signals on its aggregate snapshot", { concurrency: false }, () => {
  setInteractionOwner("sync-test-signal-store");
  clearInteractionState({ resetOwner: false });
  signalStore.write({
    "aggregate-title": { rating: 3, watchMinutes: 4 }
  });
  queuePendingSignal(
    "pending-title",
    { rating: 9, watchMinutes: 22 },
    "00000000-0000-4000-8000-000000000321"
  );

  const initialState = signalStore.read();
  assert.equal(initialState["aggregate-title"].rating, 3);
  assert.equal(initialState["pending-title"].rating, 9);
  assert.equal(readOwnerScopedSignalState()["pending-title"].watchMinutes, 22);
});

test("acknowledged signal cache keeps entries from a stale tab snapshot", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: mapStorage(values),
    location: { pathname: "/" }
  };
  try {
    setInteractionOwner("sync-test-signal-cache");
    clearInteractionState({ resetOwner: false });
    signalStore.write({
      "show-from-tab-a": { rating: 8, watchMinutes: 10, savedAt: "2026-09-15T10:00:00.000Z" }
    });
    signalStore.write({
      "show-from-tab-b": { rating: 4, watchMinutes: 5, savedAt: "2026-09-15T10:01:00.000Z" }
    });
    // Tab A writes its stale whole-snapshot view again. Per-show keys must
    // not delete the acknowledged entry written by tab B.
    signalStore.write({
      "show-from-tab-a": { rating: 8, watchMinutes: 10, savedAt: "2026-09-15T10:00:00.000Z" }
    });

    const merged = signalStore.read();
    assert.equal(merged["show-from-tab-a"].rating, 8);
    assert.equal(merged["show-from-tab-b"].rating, 4);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("signal tombstones prevent rejected titles and stale legacy values from returning", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: mapStorage(values),
    location: { pathname: "/" }
  };
  try {
    setInteractionOwner("sync-test-signal-tombstone");
    clearInteractionState({ resetOwner: false });
    const legacyKey = appConfig.signals.storageKey;
    values.set(legacyKey, JSON.stringify({
      owners: {
        "sync-test-signal-tombstone": {
          "rejected-title": { rating: 2, watchMinutes: 1, savedAt: "2026-09-15T10:00:00.000Z" }
        }
      },
      version: 2
    }));
    assert.equal(signalStore.read()["rejected-title"].rating, 2);

    deleteOwnerScopedSignal("rejected-title");
    // A stale whole-object effect must not resurrect the rejected entry.
    signalStore.write({
      "rejected-title": { rating: 2, watchMinutes: 1, savedAt: "2026-09-15T10:00:00.000Z" }
    });
    assert.equal(signalStore.read()["rejected-title"], undefined);

    replaceOwnerScopedSignalState({
      "authoritative-title": {
        rating: 9,
        watchMinutes: 20,
        savedAt: "2026-09-15T10:02:00.000Z",
        serverSavedAt: "2026-09-15T10:02:00.000Z"
      }
    });
    const replaced = signalStore.read();
    assert.equal(replaced["rejected-title"], undefined);
    assert.equal(replaced["authoritative-title"].rating, 9);

    // A delayed server snapshot may replace a stale optimistic value because
    // the optimistic value has no server receipt yet.
    signalStore.write({
      "authoritative-title": {
        rating: 2,
        watchMinutes: 3,
        savedAt: "2026-09-15T11:00:00.000Z"
      }
    });
    replaceOwnerScopedSignalState({
      "authoritative-title": {
        rating: 6,
        watchMinutes: 12,
        savedAt: "2026-09-15T10:30:00.000Z",
        serverSavedAt: "2026-09-15T10:30:00.000Z"
      }
    });
    assert.equal(signalStore.read()["authoritative-title"].rating, 6);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("owner transfer journal retries after reload and logout preserve the source", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  const storage = mapStorage(values);
  const outboxEntryPrefix = `${appConfig.interaction.outboxStorageKey}:entry:`;
  let rejectOutboxWrites = true;
  const originalSetItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (rejectOutboxWrites && key.startsWith(outboxEntryPrefix)) throw new Error("quota exceeded");
    originalSetItem(key, value);
  };
  globalThis.window = {
    localStorage: storage,
    location: { pathname: "/" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000501";
  const mutationId = "00000000-0000-4000-8000-000000000502";
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789");
    queuePendingSearch(
      { query: "journal-safe", resultCount: 1, filters: {} },
      mutationId
    );

    const firstAttempt = setInteractionOwner(
      "journal-account",
      { acceptedAnonymousSessionId: anonymousSessionId }
    );
    assert.equal(firstAttempt.transferPersisted, false);
    assert.equal(readPendingOwnerTransfer().targetOwner, "journal-account");
    assert.equal(readPendingInteractions("anonymous").searches[mutationId].query, "journal-safe");

    // This is the /me path after reload: the owner is already the account,
    // so recovery must not return from the same-owner fast path.
    const retryWhileFull = setInteractionOwner("journal-account");
    assert.equal(retryWhileFull.transferPersisted, false);
    assert.equal(readPendingOwnerTransfer().targetOwner, "journal-account");

    rejectOutboxWrites = false;
    const recoveredInPlace = setInteractionOwner("journal-account");
    assert.equal(recoveredInPlace.transferPersisted, true);
    assert.equal(readPendingOwnerTransfer(), null);
    assert.equal(readPendingInteractions("anonymous").searches[mutationId], undefined);
    assert.equal(readPendingInteractions("journal-account").searches[mutationId].query, "journal-safe");

    // Recreate the failure journal so the logout branch below exercises its
    // source-preservation contract independently of the in-place recovery.
    clearInteractionState({ resetOwner: true });
    rejectOutboxWrites = true;
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789");
    queuePendingSearch(
      { query: "journal-safe-after-reload", resultCount: 1, filters: {} },
      "00000000-0000-4000-8000-000000000503"
    );
    setInteractionOwner("journal-account", { acceptedAnonymousSessionId: anonymousSessionId });
    assert.equal(readPendingOwnerTransfer().targetOwner, "journal-account");

    // A later login can receive a new anonymous session after logout. It must
    // supersede the stale S1 journal before attempting the transfer.
    const rotatedAnonymousSessionId = "00000000-0000-4000-8000-000000000504";
    interactionSessionStore.write(rotatedAnonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    const superseded = setInteractionOwner(
      "journal-account",
      { acceptedAnonymousSessionId: rotatedAnonymousSessionId }
    );
    assert.equal(superseded.transferPersisted, false);
    assert.equal(readPendingOwnerTransfer().acceptedAnonymousSessionId, rotatedAnonymousSessionId);

    // Logout must not clear the source namespace while the journal is live.
    clearInteractionState({ preservePendingOwnerTransfer: true });
    assert.equal(getInteractionOwner(), "anonymous");
    assert.equal(readPendingInteractions("anonymous").searches["00000000-0000-4000-8000-000000000503"].query, "journal-safe-after-reload");
    assert.equal(readPendingOwnerTransfer().targetOwner, "journal-account");

    rejectOutboxWrites = false;
    const recovered = setInteractionOwner("journal-account");
    assert.equal(recovered.transferPersisted, true);
    assert.equal(readPendingOwnerTransfer(), null);
    assert.equal(readPendingInteractions("anonymous").searches["00000000-0000-4000-8000-000000000503"], undefined);
    assert.equal(readPendingInteractions("journal-account").searches["00000000-0000-4000-8000-000000000503"].query, "journal-safe-after-reload");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a failed durable journal removal preserves the session recovery copy", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const localValues = new Map();
  const sessionValues = new Map();
  const localStorage = mapStorage(localValues);
  const sessionStorage = mapStorage(sessionValues);
  const journalKey = `${appConfig.interaction.ownerStorageKey}:pending-transfer`;
  let rejectJournalRemoval = true;
  const originalRemoveItem = localStorage.removeItem;
  localStorage.removeItem = (key) => {
    if (rejectJournalRemoval && key === journalKey) throw new Error("storage temporarily unavailable");
    originalRemoveItem.call(localStorage, key);
  };
  globalThis.window = {
    localStorage,
    sessionStorage,
    location: { pathname: "/" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000690";
  const mutationId = "00000000-0000-4000-8000-000000000691";
  try {
    interactionSessionStore.write(anonymousSessionId, "journal-recovery-token-0123456789", "anonymous");
    queuePendingSearch(
      { query: "preserve-session-journal", resultCount: 1, filters: {} },
      mutationId,
      null,
      "anonymous",
    );

    const transition = setInteractionOwner(
      "journal-recovery-account",
      { acceptedAnonymousSessionId: anonymousSessionId },
    );

    assert.equal(transition.transferPersisted, true);
    assert.equal(transition.pendingOwnerTransfer, true);
    assert.ok(localValues.has(journalKey), "the failed durable removal must leave the local journal for retry");
    assert.ok(sessionValues.has(journalKey), "the session recovery copy must survive a failed durable removal");
  } finally {
    rejectJournalRemoval = false;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a non-durable transfer keeps its session recovery copy when cleanup sees no local journal", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const localValues = new Map();
  const sessionValues = new Map();
  const localStorage = mapStorage(localValues);
  const sessionStorage = mapStorage(sessionValues);
  const journalKey = `${appConfig.interaction.ownerStorageKey}:pending-transfer`;
  let rejectJournalWrites = true;
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (rejectJournalWrites && key === journalKey) throw new Error("storage temporarily unavailable");
    originalSetItem.call(localStorage, key, value);
  };
  globalThis.window = {
    localStorage,
    sessionStorage,
    location: { pathname: "/" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000692";
  try {
    interactionSessionStore.write(anonymousSessionId, "non-durable-journal-token-0123456789", "anonymous");
    const transition = setInteractionOwner(
      "non-durable-journal-account",
      { acceptedAnonymousSessionId: anonymousSessionId },
    );

    assert.equal(transition.changed, false);
    assert.equal(transition.persisted, false);
    assert.equal(localValues.has(journalKey), false);
    assert.ok(sessionValues.has(journalKey));

    // Storage recovers, but the journal was never durable. Cleanup must not
    // mistake removeItem(absent-key) for successful durable journal removal.
    rejectJournalWrites = false;
    clearInteractionState({ resetOwner: true });

    assert.ok(sessionValues.has(journalKey));
    assert.equal(readPendingOwnerTransfer()?.targetOwner, "non-durable-journal-account");
  } finally {
    rejectJournalWrites = false;
    clearInteractionState({ resetOwner: true });
    assert.equal(localValues.has(journalKey), false);
    assert.equal(sessionValues.has(journalKey), false);
    assert.equal(readPendingOwnerTransfer(), null);
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("sync marks a successful signal batch for post-commit hydration", { concurrency: false }, async () => {
  appConfig.interaction.pendingSyncBatchSize = 10;
  appConfig.interaction.pendingSyncPacingMs = 0;
  setInteractionOwner("sync-test-hydration");
  clearInteractionState({ resetOwner: false });
  queuePendingSignal(
    "hydrated-title",
    { rating: 8, watchMinutes: 15 },
    "00000000-0000-4000-8000-000000000511"
  );
  const calls = installFetch([
    response(201, sessionPayload),
    response(201, {
      accepted: true,
      rating: { rating: 8, rated_at: "2026-09-15T10:03:00.000Z" }
    })
  ]);

  const results = await syncPendingInteractions([{ id: "hydrated-title" }]);

  assert.equal(results[0].kind, "signal");
  assert.equal(hasFulfilledSignal(results), true);
  assert.equal(calls.filter(({ url }) => url.endsWith("/signals")).length, 1);
  assert.equal(readOwnerScopedSignalState()["hydrated-title"].serverSavedAt, "2026-09-15T10:03:00.000Z");
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

test("promotion reports a non-durable journal and keeps anonymous data in place", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  const storage = mapStorage(values);
  const journalKey = `${appConfig.interaction.ownerStorageKey}:pending-transfer`;
  const originalSetItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === journalKey) throw new Error("quota exceeded");
    originalSetItem(key, value);
  };
  globalThis.window = {
    localStorage: storage,
    location: { pathname: "/" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000601";
  const mutationId = "00000000-0000-4000-8000-000000000602";
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    queuePendingSearch({ query: "journal-not-durable", resultCount: 1, filters: {} }, mutationId, null, "anonymous");
    const transition = setInteractionOwner(
      "journal-not-durable-account",
      { acceptedAnonymousSessionId: anonymousSessionId }
    );

    assert.equal(transition.changed, false);
    assert.equal(transition.persisted, false);
    assert.equal(transition.pendingOwnerTransfer, true);
    assert.equal(getInteractionOwner(), "anonymous");
    assert.equal(readPendingOwnerTransfer().targetOwner, "journal-not-durable-account");
    assert.equal(values.has(journalKey), false);
    assert.equal(readPendingInteractions("anonymous").searches[mutationId].query, "journal-not-durable");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("login exposes a blocked non-durable promotion instead of completing navigation", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const values = new Map();
  const storage = mapStorage(values);
  const journalKey = `${appConfig.interaction.ownerStorageKey}:pending-transfer`;
  const originalSetItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === journalKey) throw new Error("quota exceeded");
    originalSetItem(key, value);
  };
  globalThis.window = {
    localStorage: storage,
    location: { pathname: "/auth.html" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000611";
  const mutationId = "00000000-0000-4000-8000-000000000612";
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    queuePendingSearch({ query: "login-must-retry", resultCount: 1, filters: {} }, mutationId, null, "anonymous");
    globalThis.fetch = async () => response(200, {
      user: { user_id: "login-transfer-account" },
      interaction_session_id: anonymousSessionId
    });

    const result = await login({ identifier: "alice@example.com", password: "correct-password" });
    assert.equal(result.interactionTransition.changed, false);
    assert.equal(result.interactionTransition.persisted, false);
    assert.equal(result.interactionTransition.pendingOwnerTransfer, true);
    assert.equal(getInteractionOwner(), "anonymous");
    assert.equal(values.has(journalKey), false);
    assert.ok(values.has(`${appConfig.interaction.ownerStorageKey}:promotion-in-progress`));
    assert.equal(readPendingInteractions("anonymous").searches[mutationId].query, "login-must-retry");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearPendingAuthenticatedInteractionPromotion();
    clearInteractionState({ resetOwner: true });
  }
});

test("promotion marker must be durable before an auth request starts", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const values = new Map();
  const storage = mapStorage(values);
  const promotionKey = `${appConfig.interaction.ownerStorageKey}:promotion-in-progress`;
  const originalSetItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === promotionKey) throw new Error("quota exceeded");
    originalSetItem(key, value);
  };
  globalThis.window = {
    localStorage: storage,
    location: { pathname: "/auth.html" }
  };
  let requestCount = 0;
  try {
    interactionSessionStore.write(
      "00000000-0000-4000-8000-000000000641",
      "anonymous-session-token-0123456789",
      "anonymous",
    );
    globalThis.fetch = async () => {
      requestCount += 1;
      return response(200, { user: { user_id: "marker-account" } });
    };

    await assert.rejects(
      login({ identifier: "marker@example.com", password: "correct-password" }),
      (error) => error.code === "INTERACTION_PROMOTION_UNAVAILABLE" && error.status === 503,
    );
    assert.equal(requestCount, 0);
    assert.equal(values.has(promotionKey), false);
    assert.equal(getInteractionOwner(), "anonymous");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearPendingAuthenticatedInteractionPromotion();
    clearInteractionState({ resetOwner: true });
  }
});

test("successful auth clears the promotion marker after the transfer is durable", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const values = new Map();
  globalThis.window = {
    localStorage: mapStorage(values),
    location: { pathname: "/auth.html" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000651";
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    globalThis.fetch = async () => response(200, {
      user: { user_id: "successful-promotion-account" },
      interaction_session_id: anonymousSessionId
    });

    const result = await login({ identifier: "success@example.com", password: "correct-password" });

    assert.equal(result.interactionTransition.pendingOwnerTransfer, false);
    assert.equal(result.interactionTransition.promotionPending, false);
    assert.equal(getInteractionOwner(), "successful-promotion-account");
    assert.equal(values.has(`${appConfig.interaction.ownerStorageKey}:promotion-in-progress`), false);
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearPendingAuthenticatedInteractionPromotion();
    clearInteractionState({ resetOwner: true });
  }
});

test("promotion does not erase an anonymous mutation queued during source cleanup", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  const storage = mapStorage(values);
  const journalKey = `${appConfig.interaction.ownerStorageKey}:pending-transfer`;
  const lateMutationId = "00000000-0000-4000-8000-000000000681";
  let injected = false;
  const originalRemoveItem = storage.removeItem;
  storage.removeItem = (key) => {
    originalRemoveItem.call(storage, key);
    if (!injected && key === journalKey) {
      injected = true;
      // Simulate a second tab finishing an anonymous action while the first
      // tab has already copied the old snapshot but has not cleared it yet.
      queuePendingSearch(
        { query: "queued-during-promotion", resultCount: 1, filters: {} },
        lateMutationId,
        null,
        "anonymous",
      );
    }
  };
  globalThis.window = {
    localStorage: storage,
    location: { pathname: "/" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000680";
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    queuePendingSearch(
      { query: "queued-before-promotion", resultCount: 1, filters: {} },
      "00000000-0000-4000-8000-000000000679",
      null,
      "anonymous",
    );

    const transition = setInteractionOwner(
      "promotion-race-account",
      { acceptedAnonymousSessionId: anonymousSessionId },
    );
    const source = readPendingInteractions("anonymous");
    const target = readPendingInteractions("promotion-race-account");

    assert.equal(injected, true);
    assert.ok(
      source.searches[lateMutationId] || target.searches[lateMutationId],
      "a mutation created during promotion must survive in one owner namespace",
    );
    assert.equal(target.searches["00000000-0000-4000-8000-000000000679"].query, "queued-before-promotion");
    assert.equal(transition.transferPersisted, true);

    // A later owner boundary must not discard a source mutation that was
    // written after the transfer journal was cleared. This models a stale tab
    // finishing an anonymous request after the login tab completed promotion.
    clearInteractionState({
      ownerId: "promotion-race-account",
      resetOwner: true,
      clearPending: !hasPendingInteractions("promotion-race-account"),
      preservePendingOwnerTransfer: true,
    });
    const afterBoundary = readPendingInteractions("anonymous");
    const afterBoundaryTarget = readPendingInteractions("promotion-race-account");
    assert.ok(
      afterBoundary.searches[lateMutationId] || afterBoundaryTarget.searches[lateMutationId],
      "a late anonymous mutation must survive the next owner boundary",
    );
    if (afterBoundary.searches[lateMutationId]) {
      assert.equal(readPendingOwnerTransfer().targetOwner, "promotion-race-account");
      const retry = setInteractionOwner(
        "promotion-race-account",
        { acceptedAnonymousSessionId: anonymousSessionId },
      );
      assert.equal(retry.transferPersisted, true);
      assert.equal(readPendingInteractions("promotion-race-account").searches[lateMutationId].query, "queued-during-promotion");
      assert.equal(readPendingOwnerTransfer(), null);
    } else {
      assert.equal(afterBoundaryTarget.searches[lateMutationId].query, "queued-during-promotion");
    }

    // The bridge must not let the same stale anonymous context contaminate a
    // different account that logs in afterwards.
    setInteractionOwner("different-account-after-promotion");
    const unrelatedMutationId = "00000000-0000-4000-8000-000000000685";
    queuePendingSearch(
      { query: "must-stay-anonymous", resultCount: 1, filters: {} },
      unrelatedMutationId,
      null,
      "anonymous",
    );
    assert.equal(
      readPendingInteractions("different-account-after-promotion").searches[unrelatedMutationId],
      undefined,
    );
    assert.equal(
      readPendingInteractions("anonymous").searches[unrelatedMutationId].query,
      "must-stay-anonymous",
    );
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("promotion keeps the journal when a legacy aggregate is written during source cleanup", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  const baseStorage = mapStorage(values);
  const sessionPairKey = `${appConfig.interaction.sessionStorageKey}:pair:owner:anonymous`;
  const signalAggregateKey = appConfig.signals.storageKey;
  const journalKey = `${appConfig.interaction.ownerStorageKey}:pending-transfer`;
  const lateTitleId = "legacy-late-title";
  let armAggregateRace = false;
  let injected = false;
  const storage = {
    get length() { return baseStorage.length; },
    key(index) { return baseStorage.key(index); },
    getItem(key) {
      const value = baseStorage.getItem(key);
      if (armAggregateRace && !injected && key === signalAggregateKey) {
        injected = true;
        // Simulate an older tab writing the legacy owner aggregate immediately
        // after the promotion tab's first compare read.
        baseStorage.setItem(key, JSON.stringify({
          version: 2,
          owners: {
            anonymous: {
              [lateTitleId]: {
                rating: 8,
                watchMinutes: 4,
                savedAt: "2026-09-16T12:00:00.000Z"
              }
            }
          }
        }));
      }
      return value;
    },
    setItem(key, value) {
      baseStorage.setItem(key, value);
      if (key === sessionPairKey && String(value).includes('"deleted":true')) {
        armAggregateRace = true;
      }
    },
    removeItem(key) { baseStorage.removeItem(key); }
  };
  globalThis.window = {
    localStorage: storage,
    location: { pathname: "/" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000689";
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");

    const transition = setInteractionOwner(
      "legacy-aggregate-race-account",
      { acceptedAnonymousSessionId: anonymousSessionId },
    );

    assert.equal(injected, true);
    assert.equal(transition.transferPersisted, false);
    assert.equal(transition.pendingOwnerTransfer, true);
    assert.equal(readPendingOwnerTransfer().targetOwner, "legacy-aggregate-race-account");
    assert.equal(readOwnerScopedSignalState("anonymous")[lateTitleId].rating, 8);
    assert.equal(readOwnerScopedSignalState("legacy-aggregate-race-account")[lateTitleId], undefined);
    assert.notEqual(values.get(journalKey), undefined);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a stale anonymous writer after promotion cannot be cleared by the next logout", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: mapStorage(values),
    location: { pathname: "/" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000683";
  const lateMutationId = "00000000-0000-4000-8000-000000000684";
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    const transition = setInteractionOwner(
      "promotion-after-cleanup-account",
      { acceptedAnonymousSessionId: anonymousSessionId },
    );
    assert.equal(transition.pendingOwnerTransfer, false);
    assert.equal(readPendingOwnerTransfer(), null);

    // The stale tab captured owner=anonymous before login and finishes its
    // local enqueue after the successful transfer has already removed the
    // journal.
    queuePendingSearch(
      { query: "queued-after-journal-clear", resultCount: 1, filters: {} },
      lateMutationId,
      null,
      "anonymous",
      anonymousSessionId,
    );
    clearInteractionState({
      ownerId: "promotion-after-cleanup-account",
      resetOwner: true,
      clearPending: !hasPendingInteractions("promotion-after-cleanup-account"),
      preservePendingOwnerTransfer: true,
    });

    const source = readPendingInteractions("anonymous");
    const target = readPendingInteractions("promotion-after-cleanup-account");
    assert.ok(
      source.searches[lateMutationId] || target.searches[lateMutationId],
      "a post-journal stale write must not be erased by logout cleanup",
    );
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("promotion bridge does not re-home a different anonymous session", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: mapStorage(values),
    location: { pathname: "/" }
  };
  const acceptedSessionId = "00000000-0000-4000-8000-000000000686";
  const unrelatedSessionId = "00000000-0000-4000-8000-000000000687";
  const mutationId = "00000000-0000-4000-8000-000000000688";
  try {
    interactionSessionStore.write(
      acceptedSessionId,
      "accepted-session-token-0123456789",
      "anonymous",
    );
    const transition = setInteractionOwner(
      "bridge-bound-account",
      { acceptedAnonymousSessionId: acceptedSessionId },
    );
    assert.equal(transition.transferPersisted, true);

    // A different anonymous browsing context still has its own session when
    // the accepted session's short-lived bridge is active. Its mutation must
    // remain anonymous instead of being contaminated into the account that
    // completed the other session's promotion.
    interactionSessionStore.write(
      unrelatedSessionId,
      "unrelated-session-token-0123456789",
      "anonymous",
    );
    queuePendingSearch(
      { query: "must-not-enter-bridge-account", resultCount: 1, filters: {} },
      mutationId,
      null,
      "anonymous",
      unrelatedSessionId,
    );

    assert.equal(
      readPendingInteractions("bridge-bound-account").searches[mutationId],
      undefined,
    );
    assert.equal(
      readPendingInteractions("anonymous").searches[mutationId].query,
      "must-not-enter-bridge-account",
    );
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("missing server session confirmation abandons the stale source and continues auth", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const values = new Map();
  globalThis.window = {
    localStorage: mapStorage(values),
    location: { pathname: "/auth.html" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000661";
  const promotionKey = `${appConfig.interaction.ownerStorageKey}:promotion-in-progress`;
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    globalThis.fetch = async () => response(200, {
      user: { user_id: "unconfirmed-promotion-account" }
    });

    const result = await login({ identifier: "missing-confirmation@example.com", password: "correct-password" });

    assert.equal(result.interactionTransition.promotionPending, false);
    assert.equal(result.interactionTransition.discardedAnonymousPromotion, true);
    assert.equal(result.interactionTransition.pendingOwnerTransfer, false);
    assert.equal(getInteractionOwner(), "unconfirmed-promotion-account");
    assert.equal(values.has(promotionKey), false);
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearPendingAuthenticatedInteractionPromotion();
    clearInteractionState({ resetOwner: true });
  }
});

test("/me exposes the attached interaction lineage for crash recovery", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const values = new Map();
  const storage = mapStorage(values);
  const anonymousSessionId = "00000000-0000-4000-8000-000000000671";
  const sessionToken = "anonymous-session-token-0123456789";
  globalThis.window = {
    localStorage: storage,
    location: { pathname: "/" }
  };
  try {
    interactionSessionStore.write(anonymousSessionId, sessionToken, "anonymous");
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.headers.get("X-Cinemind-Session"), anonymousSessionId);
      assert.equal(options.headers.get("X-Cinemind-Session-Token"), sessionToken);
      return response(200, {
        authenticated: true,
        user: { user_id: "recovered-account" },
        interaction_session_id: anonymousSessionId
      });
    };

    const user = await getCurrentUser();

    assert.equal(user.user_id, "recovered-account");
    assert.equal(user.interaction_session_id, anonymousSessionId);
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("interaction session creation re-reads the shared pair under a cross-tab lock", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  let lockTail = Promise.resolve();
  let created = 0;
  const locks = {
    request(_name, callback) {
      const previous = lockTail;
      let release;
      lockTail = new Promise((resolve) => { release = resolve; });
      return previous.then(async () => {
        try {
          return await callback();
        } finally {
          release();
        }
      });
    }
  };
  globalThis.window = {
    localStorage: mapStorage(values),
    sessionStorage: mapStorage(new Map()),
    navigator: { locks },
    location: { pathname: "/" }
  };
  const sessionId = "00000000-0000-4000-8000-000000000691";
  try {
    const createOrAdopt = () => withInteractionSessionCreationLock(async () => {
      const existing = interactionSessionStore.read("anonymous");
      if (existing) return existing;
      await Promise.resolve();
      created += 1;
      interactionSessionStore.write(sessionId, "anonymous-session-token-0123456789", "anonymous");
      return sessionId;
    });
    const [first, second] = await Promise.all([createOrAdopt(), createOrAdopt()]);

    assert.equal(first.supported, true);
    assert.equal(second.supported, true);
    assert.equal(first.value, sessionId);
    assert.equal(second.value, sessionId);
    assert.equal(created, 1);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("concurrent scoped session writes preserve both owner namespaces", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  const baseStorage = mapStorage(values);
  const pairKey = (owner) => `${appConfig.interaction.sessionStorageKey}:pair:owner:${encodeURIComponent(owner)}`;
  const storage = {
    get length() { return baseStorage.length; },
    key(index) { return baseStorage.key(index); },
    getItem(key) { return baseStorage.getItem(key); },
    setItem(key, value) { baseStorage.setItem(key, value); },
    removeItem(key) { baseStorage.removeItem(key); },
  };
  globalThis.window = {
    localStorage: storage,
    sessionStorage: mapStorage(new Map()),
    location: { pathname: "/" },
  };
  try {
    interactionSessionStore.write(
      "00000000-0000-4000-8000-000000000692",
      "owner-a-session-token-0123456789",
      "owner-a",
    );
    interactionSessionStore.write(
      "00000000-0000-4000-8000-000000000693",
      "owner-b-session-token-0123456789",
      "owner-b",
    );
    assert.equal(interactionSessionStore.read("owner-a"), "00000000-0000-4000-8000-000000000692");
    assert.equal(interactionSessionStore.read("owner-b"), "00000000-0000-4000-8000-000000000693");
    assert.ok(values.has(pairKey("owner-a")));
    assert.ok(values.has(pairKey("owner-b")));
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a promotion marker claimed by another tab cannot be reused", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  const promotionKey = `${appConfig.interaction.ownerStorageKey}:promotion-in-progress`;
  const anonymousSessionId = "00000000-0000-4000-8000-000000000681";
  globalThis.window = {
    localStorage: mapStorage(values),
    sessionStorage: mapStorage(new Map()),
    location: { pathname: "/auth.html" }
  };
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    values.set(promotionKey, JSON.stringify({
      version: 2,
      sourceOwner: "anonymous",
      sourceSessionId: anonymousSessionId,
      promotionId: "00000000-0000-4000-8000-000000000682",
      claimId: "00000000-0000-4000-8000-000000000683",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString()
    }));

    assert.equal(await beginAuthenticatedInteractionPromotion(), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearPendingAuthenticatedInteractionPromotion();
    clearInteractionState({ resetOwner: true });
  }
});

test("promotion marker creation is serialized across browsing contexts", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  const baseStorage = mapStorage(values);
  const promotionKey = `${appConfig.interaction.ownerStorageKey}:promotion-in-progress`;
  let nestedReadStarted = false;
  let nestedResultPromise = null;
  const storage = {
    get length() { return baseStorage.length; },
    key(index) { return baseStorage.key(index); },
    getItem(key) {
      const snapshot = baseStorage.getItem(key);
      if (key === promotionKey && !nestedReadStarted) {
        nestedReadStarted = true;
        // Return the pre-write snapshot after the nested context has started,
        // simulating two tabs that both read an empty marker concurrently.
        nestedResultPromise = Promise.resolve(beginAuthenticatedInteractionPromotion());
      }
      return snapshot;
    },
    setItem(key, value) { baseStorage.setItem(key, value); },
    removeItem(key) { baseStorage.removeItem(key); }
  };
  let lockHeld = false;
  const lockWaiters = [];
  const navigator = {
    locks: {
      async request(_name, callback) {
        if (lockHeld) await new Promise((resolve) => lockWaiters.push(resolve));
        lockHeld = true;
        try {
          return await callback({ name: _name });
        } finally {
          lockHeld = false;
          lockWaiters.shift()?.();
        }
      }
    }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000684";
  globalThis.window = {
    localStorage: storage,
    sessionStorage: mapStorage(new Map()),
    navigator,
    location: { pathname: "/auth.html" }
  };
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    const outerPromotionId = await beginAuthenticatedInteractionPromotion();
    const nestedPromotionId = await nestedResultPromise;

    assert.match(outerPromotionId, /^[0-9a-f-]{36}$/iu);
    assert.equal(nestedPromotionId, outerPromotionId);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearPendingAuthenticatedInteractionPromotion();
    clearInteractionState({ resetOwner: true });
  }
});

test("a stale state snapshot cannot overwrite a newer cross-tab server receipt", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const owner = "state-watermark-account";
  setInteractionOwner(owner);
  const localSignal = {
    rating: 9,
    watchMinutes: 12,
    savedAt: "2026-09-16T10:05:00.000Z",
    serverSavedAt: "2026-09-16T10:05:00.000Z"
  };
  signalStore.write({ "stale-title": localSignal });

  const staleState = {
    snapshot_at: "2026-09-16T10:04:00.000Z",
    ratings: [{
      show_id: "stale-title",
      rating: 4,
      watch_minutes: 2,
      rated_at: "2026-09-16T10:03:00.000Z",
      event_at: "2026-09-16T10:03:00.000Z"
    }]
  };
  const merged = mergeInteractionState(staleState, { ratings: signalStore.read() });
  replaceOwnerScopedSignalState(merged.ratings, { snapshotAt: staleState.snapshot_at });

  assert.equal(readOwnerScopedSignalState()["stale-title"].rating, 9);
  clearInteractionState({ resetOwner: true });
});

test("sessionStorage fallback is not treated as a durable promotion journal", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const localValues = new Map();
  const sessionValues = new Map();
  const storage = mapStorage(localValues);
  const journalKey = `${appConfig.interaction.ownerStorageKey}:pending-transfer`;
  const originalSetItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === journalKey) throw new Error("quota exceeded");
    originalSetItem(key, value);
  };
  globalThis.window = {
    localStorage: storage,
    sessionStorage: mapStorage(sessionValues),
    location: { pathname: "/auth.html" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000621";
  const mutationId = "00000000-0000-4000-8000-000000000622";
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    queuePendingSearch({ query: "session-fallback", resultCount: 1, filters: {} }, mutationId, null, "anonymous");
    const transition = setInteractionOwner(
      "session-fallback-account",
      { acceptedAnonymousSessionId: anonymousSessionId }
    );

    assert.equal(transition.persisted, false);
    assert.equal(transition.transferPersisted, undefined);
    assert.equal(transition.promotionPending, true);
    assert.equal(getInteractionOwner(), "anonymous");
    assert.equal(readPendingOwnerTransfer().targetOwner, "session-fallback-account");
    assert.equal(localValues.has(journalKey), false);
    assert.equal(JSON.parse(sessionValues.get(journalKey)).targetOwner, "session-fallback-account");
    assert.equal(readPendingInteractions("anonymous").searches[mutationId].query, "session-fallback");
    assert.equal(readPendingInteractions("session-fallback-account").searches[mutationId], undefined);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("promotion marker blocks a cross-tab owner switch until the server accepts the source session", { concurrency: false }, async () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    localStorage: mapStorage(values),
    sessionStorage: mapStorage(new Map()),
    location: { pathname: "/auth.html" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000631";
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    const promotionId = await beginAuthenticatedInteractionPromotion();
    assert.match(promotionId, /^[0-9a-f-]{36}$/iu);

    const blocked = setInteractionOwner("promotion-account");
    assert.equal(blocked.changed, false);
    assert.equal(blocked.promotionPending, true);
    assert.equal(getInteractionOwner(), "anonymous");

    const accepted = setInteractionOwner(
      "promotion-account",
      { acceptedAnonymousSessionId: anonymousSessionId },
    );
    assert.equal(accepted.changed, true);
    assert.equal(accepted.pendingOwnerTransfer, false);
    assert.equal(getInteractionOwner(), "promotion-account");
    assert.equal(clearPendingAuthenticatedInteractionPromotion(promotionId), true);
    assert.equal(values.has(`${appConfig.interaction.ownerStorageKey}:promotion-in-progress`), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearPendingAuthenticatedInteractionPromotion();
    clearInteractionState({ resetOwner: true });
  }
});

test("anonymous outbox survives account promotion when its durable copy fails", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const values = new Map();
  const storage = mapStorage(values);
  const outboxEntryPrefix = `${appConfig.interaction.outboxStorageKey}:entry:`;
  const originalSetItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key.startsWith(outboxEntryPrefix)) throw new Error("quota exceeded");
    originalSetItem(key, value);
  };
  globalThis.window = {
    localStorage: storage,
    location: { pathname: "/" }
  };
  const anonymousSessionId = "00000000-0000-4000-8000-000000000401";
  const mutationId = "00000000-0000-4000-8000-000000000402";
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789");
    queuePendingSearch(
      { query: "quota-safe", resultCount: 1, filters: {} },
      mutationId
    );
    assert.equal(Object.keys(readPendingInteractions("anonymous").searches).length, 1);

    const transition = setInteractionOwner(
      "quota-copy-account",
      { acceptedAnonymousSessionId: anonymousSessionId }
    );

    assert.equal(transition.changed, true);
    assert.equal(getInteractionOwner(), "quota-copy-account");
    assert.equal(
      readPendingInteractions("anonymous").searches[mutationId].query,
      "quota-safe"
    );
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

test("unavailable browser storage reports queued interactions as session-only", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  globalThis.window = {
    localStorage: null,
    sessionStorage: mapStorage(new Map()),
    navigator: {},
    location: { pathname: "/" }
  };
  const owner = "session-only-outbox-owner";
  try {
    queuePendingSearch({ query: "session only", resultCount: 1, filters: {} }, undefined, null, owner);
    assert.equal(pendingInteractionsPersisted(), false);
    assert.equal(Object.keys(readPendingInteractions(owner).searches).length, 1);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a durable cross-tab outbox write wins over a stale quota fallback", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "outbox-durable-conflict";
  const mutationId = "00000000-0000-4000-8000-000000000710";
  const outboxPrefix = `${appConfig.interaction.outboxStorageKey}:entry:`;
  const entryKey = `${outboxPrefix}${encodeURIComponent(owner)}:searches:${encodeURIComponent(mutationId)}`;
  const values = new Map();
  let blockOutboxWrites = true;
  const baseStorage = mapStorage(values);
  globalThis.window = {
    localStorage: {
      get length() { return baseStorage.length; },
      key(index) { return baseStorage.key(index); },
      getItem(key) { return baseStorage.getItem(key); },
      setItem(key, value) {
        if (blockOutboxWrites && key.startsWith(outboxPrefix)) throw new Error("quota exceeded");
        baseStorage.setItem(key, value);
      },
      removeItem(key) { baseStorage.removeItem(key); }
    },
    location: { pathname: "/" }
  };
  try {
    queuePendingSearch({ query: "stale-memory-write", resultCount: 1, filters: {} }, mutationId, null, owner);
    assert.equal(readPendingInteractions(owner).searches[mutationId].query, "stale-memory-write");

    // Simulate tab B committing a newer durable value after tab A's quota
    // failure. Tab A must not let browserStore retry its stale memory copy
    // over this value on the next read.
    blockOutboxWrites = false;
    values.set(entryKey, JSON.stringify({
      query: "new-durable-write",
      resultCount: 2,
      filters: {},
      firstQueuedAt: "2026-09-16T12:00:00.000Z",
      lastAttemptAt: "2026-09-16T12:00:01.000Z",
      queuedAt: "2026-09-16T12:00:00.000Z",
      mutationId,
      outboxWriteNonce: "external-writer"
    }));

    assert.equal(readPendingInteractions(owner).searches[mutationId].query, "new-durable-write");
    assert.equal(JSON.parse(values.get(entryKey)).query, "new-durable-write");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("an outbox read cannot overwrite a newer cross-tab write during fallback recovery", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "outbox-read-recovery-race";
  const mutationId = "00000000-0000-4000-8000-000000000711";
  const outboxPrefix = `${appConfig.interaction.outboxStorageKey}:entry:`;
  const entryKey = `${outboxPrefix}${encodeURIComponent(owner)}:searches:${encodeURIComponent(mutationId)}`;
  const values = new Map();
  let blockOutboxWrites = true;
  let armRecovery = false;
  let injected = false;
  const baseStorage = mapStorage(values);
  const storage = {
    get length() { return baseStorage.length; },
    key(index) { return baseStorage.key(index); },
    getItem(key) {
      const value = baseStorage.getItem(key);
      if (armRecovery && !injected && key === entryKey) {
        injected = true;
        blockOutboxWrites = false;
        values.set(entryKey, JSON.stringify({
          query: "newer-tab-write-during-read",
          resultCount: 3,
          filters: {},
          firstQueuedAt: "2026-09-16T12:01:00.000Z",
          lastAttemptAt: "2026-09-16T12:01:01.000Z",
          queuedAt: "2026-09-16T12:01:00.000Z",
          mutationId,
          outboxWriteNonce: "newer-tab"
        }));
      }
      return value;
    },
    setItem(key, value) {
      if (blockOutboxWrites && key.startsWith(outboxPrefix)) throw new Error("quota exceeded");
      baseStorage.setItem(key, value);
    },
    removeItem(key) { baseStorage.removeItem(key); }
  };
  globalThis.window = {
    localStorage: storage,
    location: { pathname: "/" }
  };
  try {
    queuePendingSearch(
      { query: "stale-tab-fallback", resultCount: 1, filters: {} },
      mutationId,
      null,
      owner,
    );
    armRecovery = true;

    const recovered = readPendingInteractions(owner);
    assert.equal(injected, true);
    assert.equal(recovered.searches[mutationId].query, "newer-tab-write-during-read");
    assert.equal(JSON.parse(values.get(entryKey)).query, "newer-tab-write-during-read");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("pruning an old outbox snapshot cannot delete a newer cross-tab write", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "outbox-prune-race";
  const mutationId = "00000000-0000-4000-8000-000000000701";
  const entryKey = `${appConfig.interaction.outboxStorageKey}:entry:${encodeURIComponent(owner)}:searches:${encodeURIComponent(mutationId)}`;
  const migrationKey = `${appConfig.interaction.outboxStorageKey}:migration:${encodeURIComponent(owner)}`;
  const oldEntry = {
    query: "old-snapshot",
    resultCount: 1,
    filters: {},
    firstQueuedAt: "2000-01-01T00:00:00.000Z",
    lastAttemptAt: "2000-01-01T00:00:00.000Z",
    queuedAt: "2000-01-01T00:00:00.000Z",
    mutationId
  };
  const newEntry = {
    ...oldEntry,
    query: "new-cross-tab-write",
    firstQueuedAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    queuedAt: new Date().toISOString()
  };
  const values = new Map([
    [entryKey, JSON.stringify(oldEntry)],
    [migrationKey, JSON.stringify({ version: 1 })]
  ]);
  let entryReads = 0;
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) {
      if (key === entryKey) {
        entryReads += 1;
        if (entryReads === 3) {
          // Simulate tab B replacing the entry after tab A has taken its
          // prune snapshot but before tab A compares/removes it.
          values.set(entryKey, JSON.stringify(newEntry));
          return JSON.stringify(oldEntry);
        }
      }
      return values.get(key) ?? null;
    },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  globalThis.window = { localStorage: storage, location: { pathname: "/" } };
  try {
    readPendingInteractions(owner);
    assert.equal(entryReads >= 3, true);
    assert.equal(JSON.parse(values.get(entryKey)).query, "new-cross-tab-write");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("an acknowledged outbox entry stays hidden until a newer write supersedes its tombstone", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "outbox-tombstone-lifecycle";
  const mutationId = "00000000-0000-4000-8000-000000000702";
  const values = new Map();
  globalThis.window = {
    localStorage: mapStorage(values),
    location: { pathname: "/" }
  };
  try {
    queuePendingSearch({ query: "before-ack", resultCount: 1, filters: {} }, mutationId, null, owner);
    assert.equal(readPendingInteractions(owner).searches[mutationId].query, "before-ack");

    acknowledgePendingSearch(mutationId, owner);
    assert.equal(readPendingInteractions(owner).searches[mutationId], undefined);

    queuePendingSearch({ query: "after-ack-retry", resultCount: 2, filters: {} }, mutationId, null, owner);
    assert.equal(readPendingInteractions(owner).searches[mutationId].query, "after-ack-retry");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("outbox migration does not resurrect a legacy entry covered by a tombstone", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "outbox-legacy-tombstone";
  const mutationId = "00000000-0000-4000-8000-000000000706";
  const legacyEntry = {
    query: "stale-legacy-search",
    resultCount: 1,
    filters: {},
    firstQueuedAt: "2026-09-15T10:00:00.000Z",
    lastAttemptAt: "2026-09-15T10:00:00.000Z",
    queuedAt: "2026-09-15T10:00:00.000Z",
    mutationId
  };
  const previouslyMigratedEntry = {
    ...legacyEntry,
    clientDeviceId: null,
    clientEventSequence: null,
    outboxWriteNonce: "old-migration-write"
  };
  const values = new Map([
    [appConfig.interaction.outboxStorageKey, JSON.stringify({
      version: 2,
      owners: {
        [owner]: { signals: {}, searches: { [mutationId]: legacyEntry } }
      }
    })],
    [`${appConfig.interaction.outboxStorageKey}:tombstone:${encodeURIComponent(owner)}:searches:${encodeURIComponent(mutationId)}`, JSON.stringify({
      version: 1,
      fingerprint: JSON.stringify(previouslyMigratedEntry),
      createdAt: "2026-09-15T10:01:00.000Z"
    })]
  ]);
  globalThis.window = {
    localStorage: mapStorage(values),
    location: { pathname: "/" }
  };
  try {
    const pending = readPendingInteractions(owner);
    assert.equal(pending.searches[mutationId], undefined);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("a stale acknowledgement cannot remove a newer write with the same mutation id", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "outbox-stale-ack";
  const mutationId = "00000000-0000-4000-8000-000000000707";
  const values = new Map();
  globalThis.window = {
    localStorage: mapStorage(values),
    location: { pathname: "/" }
  };
  try {
    queuePendingSearch({ query: "old-write", resultCount: 1, filters: {} }, mutationId, null, owner);
    const oldEntry = readPendingInteractions(owner).searches[mutationId];
    queuePendingSearch({ query: "new-write", resultCount: 2, filters: {} }, mutationId, null, owner);
    acknowledgePendingSearch(mutationId, owner, oldEntry);
    assert.equal(readPendingInteractions(owner).searches[mutationId].query, "new-write");

    const signalMutationId = "00000000-0000-4000-8000-000000000708";
    queuePendingSignal("same-title", { rating: 3, watchMinutes: 1 }, signalMutationId, null, owner);
    const oldSignal = readPendingInteractions(owner).signals[signalMutationId];
    queuePendingSignal("same-title", { rating: 9, watchMinutes: 2 }, signalMutationId, null, owner);
    acknowledgePendingSignal("same-title", signalMutationId, owner, oldSignal);
    assert.equal(readPendingInteractions(owner).signals[signalMutationId].rating, 9);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("memory-only stale acknowledgement compares payloads independent of property order", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "memory-outbox-stale-ack";
  const mutationId = "00000000-0000-4000-8000-000000000709";
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
    queuePendingSearch({ query: "old-memory-write", resultCount: 1, filters: {} }, mutationId, null, owner);
    const oldEntry = readPendingInteractions(owner).searches[mutationId];
    queuePendingSearch({ query: "new-memory-write", resultCount: 2, filters: {} }, mutationId, null, owner);
    acknowledgePendingSearch(mutationId, owner, oldEntry);
    assert.equal(readPendingInteractions(owner).searches[mutationId].query, "new-memory-write");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("owner promotion does not overwrite a newer target-tab outbox write", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "promotion-target-race";
  const anonymousSessionId = "00000000-0000-4000-8000-000000000703";
  const targetMutationId = "00000000-0000-4000-8000-000000000704";
  const values = new Map();
  const storage = mapStorage(values);
  const targetEntryKey = `${appConfig.interaction.outboxStorageKey}:entry:${encodeURIComponent(owner)}:searches:${encodeURIComponent(targetMutationId)}`;
  const targetMigrationKey = `${appConfig.interaction.outboxStorageKey}:migration:${encodeURIComponent(owner)}`;
  globalThis.window = {
    localStorage: storage,
    location: { pathname: "/" }
  };
  try {
    interactionSessionStore.write(anonymousSessionId, "anonymous-session-token-0123456789", "anonymous");
    queuePendingSearch({ query: "source-event", resultCount: 1, filters: {} }, "00000000-0000-4000-8000-000000000705", null, "anonymous");
    queuePendingSearch({ query: "target-old", resultCount: 1, filters: {} }, targetMutationId, null, owner);
    const oldTarget = JSON.parse(values.get(targetEntryKey));
    const newTarget = { ...oldTarget, query: "target-newer-tab-write", resultCount: 2 };
    const originalGetItem = storage.getItem;
    let armed = false;
    let triggered = false;
    storage.getItem = (key) => {
      const result = originalGetItem(key);
      if (armed && !triggered && key === targetMigrationKey) {
        triggered = true;
        // Simulate the target tab writing after the promotion tab took its
        // target snapshot but before that snapshot is published.
        values.set(targetEntryKey, JSON.stringify(newTarget));
      }
      return result;
    };
    armed = true;

    const transition = setInteractionOwner(
      owner,
      { acceptedAnonymousSessionId: anonymousSessionId },
    );

    assert.equal(transition.transferPersisted, true);
    assert.equal(triggered, true);
    assert.equal(readPendingInteractions(owner).searches[targetMutationId].query, "target-newer-tab-write");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("clearing an owner namespace cannot delete a newer concurrent outbox write", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "outbox-clear-race";
  const mutationId = "00000000-0000-4000-8000-000000000706";
  const values = new Map();
  const storage = mapStorage(values);
  const entryKey = `${appConfig.interaction.outboxStorageKey}:entry:${encodeURIComponent(owner)}:searches:${encodeURIComponent(mutationId)}`;
  const tombstonePrefix = `${appConfig.interaction.outboxStorageKey}:tombstone:${encodeURIComponent(owner)}:`;
  globalThis.window = {
    localStorage: storage,
    location: { pathname: "/" }
  };
  try {
    queuePendingSearch({ query: "clear-old", resultCount: 1, filters: {} }, mutationId, null, owner);
    const oldEntry = JSON.parse(values.get(entryKey));
    const newEntry = { ...oldEntry, query: "clear-newer-tab-write", resultCount: 2 };
    const originalSetItem = storage.setItem;
    let triggered = false;
    storage.setItem = (key, value) => {
      if (!triggered && key.startsWith(tombstonePrefix)) {
        triggered = true;
        // Simulate tab B writing after tab A captured the old value but before
        // tab A publishes its logical clear marker.
        values.set(entryKey, JSON.stringify(newEntry));
      }
      originalSetItem(key, value);
    };

    clearInteractionState({ ownerId: owner, resetOwner: false });

    assert.equal(readPendingInteractions(owner).searches[mutationId].query, "clear-newer-tab-write");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("clearing signal state cannot erase a newer concurrent tab write", { concurrency: false }, () => {
  clearInteractionState({ resetOwner: true });
  const originalWindow = globalThis.window;
  const owner = "signal-clear-race";
  const values = new Map();
  const entryPrefix = `${appConfig.signals.storageKey}:entry:${encodeURIComponent(owner)}:`;
  const clearPrefix = `${appConfig.signals.storageKey}:clear:${encodeURIComponent(owner)}:`;
  let injected = false;
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      if (!injected && key.startsWith(clearPrefix)) {
        injected = true;
        const entryKey = [...values.keys()].find((candidate) => candidate.startsWith(entryPrefix));
        assert.ok(entryKey);
        values.set(entryKey, JSON.stringify({
          rating: 9,
          watchMinutes: 18,
          savedAt: "2026-09-16T01:00:00.000Z",
          serverSavedAt: "2026-09-16T01:00:00.000Z"
        }));
      }
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); }
  };
  globalThis.window = { localStorage: storage, location: { pathname: "/" } };
  try {
    setInteractionOwner(owner);
    writeOwnerScopedSignalState({
      "race-title": {
        rating: 4,
        watchMinutes: 2,
        savedAt: "2026-09-16T00:00:00.000Z",
        serverSavedAt: "2026-09-16T00:00:00.000Z"
      }
    });

    clearInteractionState({ resetOwner: false, ownerId: owner });

    assert.equal(injected, true);
    assert.equal(readOwnerScopedSignalState(owner)["race-title"].rating, 9);
    assert.equal(readOwnerScopedSignalState(owner)["race-title"].watchMinutes, 18);
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
  const sessionEntryKey = `${sessionKey}:owner:${encodeURIComponent("atomic-session-owner")}`;
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
        if (key === sessionEntryKey) throw new Error("quota exceeded");
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
    assert.equal(values.has(sessionEntryKey), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("releasing a device stream cannot delete a newer tab lease", { concurrency: false }, () => {
  const originalWindow = globalThis.window;
  const values = new Map();
  const sessionValues = new Map();
  const listeners = {};
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const sessionStorage = {
    get length() { return sessionValues.size; },
    key(index) { return [...sessionValues.keys()][index] ?? null; },
    getItem(key) { return sessionValues.get(key) ?? null; },
    setItem(key, value) { sessionValues.set(key, String(value)); },
    removeItem(key) { sessionValues.delete(key); }
  };
  globalThis.window = {
    localStorage: storage,
    sessionStorage,
    location: { pathname: "/" },
    addEventListener(type, handler) { listeners[type] = handler; }
  };
  try {
    const deviceId = getInteractionDeviceId();
    const claimKey = `${appConfig.interaction.deviceStorageKey}:active:${encodeURIComponent(deviceId)}`;
    const originalGetItem = storage.getItem.bind(storage);
    let armed = false;
    let reads = 0;
    storage.getItem = (key) => {
      if (armed && key === claimKey) {
        reads += 1;
        if (reads === 2) {
          values.set(key, JSON.stringify({ claimId: "newer-tab", touchedAt: Date.now() }));
        }
      }
      return originalGetItem(key);
    };
    armed = true;

    listeners.pagehide({ persisted: false });

    assert.equal(reads, 2);
    assert.equal(JSON.parse(values.get(claimKey)).claimId, "newer-tab");
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
