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
  deleteOwnerScopedSignal,
  getInteractionDeviceId,
  getInteractionOwner,
  hasPendingInteractions,
  interactionSessionStore,
  mergeInteractionState,
  nextInteractionEventSequence,
  readPendingOwnerTransfer,
  queuePendingSignal,
  queuePendingSearch,
  readOwnerScopedSignalState,
  readPendingInteractions,
  replaceOwnerScopedSignalState,
  setInteractionOwner,
  signalWithServerReceipt
} = require(resolve(sourceDir, "services/interactionStore.js"));
const { signalStore } = require(resolve(sourceDir, "services/signalStore.js"));
const { hasFulfilledSignal, syncPendingInteractions } = require(resolve(sourceDir, "services/interactionService.js"));
const { login } = require(resolve(sourceDir, "services/authService.js"));

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
    assert.equal(readPendingInteractions("anonymous").searches[mutationId].query, "login-must-retry");
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    clearInteractionState({ resetOwner: true });
  }
});

test("sessionStorage fallback keeps a promotion journal durable when localStorage is full", { concurrency: false }, () => {
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

    assert.equal(transition.persisted, true);
    assert.equal(transition.transferPersisted, true);
    assert.equal(getInteractionOwner(), "session-fallback-account");
    assert.equal(readPendingOwnerTransfer(), null);
    assert.equal(readPendingInteractions("anonymous").searches[mutationId], undefined);
    assert.equal(readPendingInteractions("session-fallback-account").searches[mutationId].query, "session-fallback");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
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
