// HTTP client for CineMind's anonymous interaction API.

import { appConfig, resolveApiBaseUrl } from "../config/appConfig";
import { fetchWithTimeout } from "./fetchWithTimeout";
import {
  acknowledgePendingSearch,
  acknowledgePendingSignal,
  createMutationId,
  getInteractionOwner,
  getInteractionRevision,
  interactionSessionStore,
  pendingInteractionsPersisted,
  queuePendingSearch,
  queuePendingSignal,
  readPendingInteractions
} from "./interactionStore";

const interactionConfig = appConfig.interaction;
const DEFAULT_PENDING_SYNC_BATCH_SIZE = 20;
// Backend's default interaction budget is 120 writes per 60 seconds. Keep
// replay below that budget even when a queue contains many pending events.
const DEFAULT_PENDING_SYNC_PACING_MS = 500;
const DEFAULT_PENDING_SYNC_BACKOFF_MS = 5000;
const DEFAULT_PENDING_SYNC_MAX_BACKOFF_MS = 300000;
let sessionRequest = null;
let pendingSyncRequest = null;
const mutationChains = new Map();
const pendingSyncBackoffs = new Map();

function ownerChangedError() {
  const error = new Error("Interaction owner changed while a request was in flight");
  error.code = "INTERACTION_OWNER_CHANGED";
  return error;
}

function captureInteractionContext() {
  return { owner: getInteractionOwner(), revision: getInteractionRevision() };
}

function normalizeInteractionContext(context = null) {
  if (context && typeof context === "object" && typeof context.owner === "string") {
    return {
      owner: context.owner,
      revision: Number.isInteger(context.revision) ? context.revision : getInteractionRevision()
    };
  }
  return captureInteractionContext();
}

function assertInteractionContext(context) {
  if (getInteractionOwner() === context.owner && getInteractionRevision() === context.revision) return;
  const error = ownerChangedError();
  error.expectedOwner = context.owner;
  error.currentOwner = getInteractionOwner();
  error.expectedRevision = context.revision;
  error.currentRevision = getInteractionRevision();
  throw error;
}

function isCurrentInteractionContext(context) {
  try {
    assertInteractionContext(context);
    return true;
  } catch {
    return false;
  }
}

async function request(path, options = {}, context = null) {
  const interactionContext = normalizeInteractionContext(context);
  assertInteractionContext(interactionContext);
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const sessionId = interactionSessionStore.read(interactionContext.owner);
  const sessionToken = interactionSessionStore.readToken(interactionContext.owner);
  if (sessionId && !headers.has("X-Cinemind-Session")) headers.set("X-Cinemind-Session", sessionId);
  if (sessionToken && !headers.has("X-Cinemind-Session-Token")) {
    headers.set("X-Cinemind-Session-Token", sessionToken);
  }

  const response = await fetchWithTimeout(`${resolveApiBaseUrl(interactionConfig.apiBaseUrl)}${path}`, {
    ...options,
    headers,
    credentials: "include"
  }, appConfig.runtime?.requestTimeoutMs);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { detail: text };
    }
  }

  // Never let a response from an earlier owner/auth generation affect the
  // current account, including error responses.
  assertInteractionContext(interactionContext);

  if (!response.ok) {
    const detail = typeof payload?.detail === "string"
      ? payload.detail
      : payload?.detail?.message || `Interaction request failed with ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    error.code = payload?.detail?.code || payload?.code;
    const retryAfter = readResponseHeader(response, "Retry-After");
    const retryAfterMs = parseRetryAfter(retryAfter);
    if (retryAfter !== null) error.retryAfter = retryAfter;
    if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
    if (response.status === 401 || response.status === 403) markAuthRequired(error);
    throw error;
  }
  return payload;
}

function readResponseHeader(response, name) {
  try {
    if (typeof response?.headers?.get === "function") {
      const value = response.headers.get(name);
      if (value !== null && value !== undefined) return String(value);
    }
    const headers = response?.headers;
    if (!headers || typeof headers !== "object") return null;
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

export async function ensureInteractionSession({ locale, platform } = {}, context = null) {
  const interactionContext = normalizeInteractionContext(context);
  assertInteractionContext(interactionContext);
  const existingSessionId = interactionSessionStore.read(interactionContext.owner);
  if (existingSessionId) return existingSessionId;
  if (sessionRequest?.owner === interactionContext.owner
    && sessionRequest?.revision === interactionContext.revision) return sessionRequest.promise;

  const promise = request("/sessions", {
    method: "POST",
    body: JSON.stringify({ locale, platform })
  }, interactionContext)
    .then((payload) => {
      // A response from a previous account must never hydrate the current
      // owner's browser namespace.
      assertInteractionContext(interactionContext);
      const sessionId = payload?.session_id;
      if (!sessionId) throw new Error("Interaction session response is missing session_id");
      interactionSessionStore.write(sessionId, payload?.session_token, interactionContext.owner);
      return sessionId;
    })
    .finally(() => {
      if (sessionRequest?.promise === promise) sessionRequest = null;
    });
  sessionRequest = { ...interactionContext, promise };
  return promise;
}

export async function getInteractionState(metadata = {}) {
  const interactionContext = captureInteractionContext();
  let sessionId = await ensureInteractionSession(metadata, interactionContext);
  assertInteractionContext(interactionContext);
  try {
    const result = await request(`/state/${encodeURIComponent(sessionId)}`, {}, interactionContext);
    assertInteractionContext(interactionContext);
    return result;
  } catch (error) {
    if (error.code !== "SESSION_NOT_FOUND") throw error;
    assertInteractionContext(interactionContext);
    interactionSessionStore.write(null, null, interactionContext.owner);
    sessionId = await ensureInteractionSession(metadata, interactionContext);
    assertInteractionContext(interactionContext);
    try {
      const result = await request(`/state/${encodeURIComponent(sessionId)}`, {}, interactionContext);
      assertInteractionContext(interactionContext);
      return result;
    } catch (retryError) {
      if (retryError.code === "AUTH_REQUIRED" || retryError.status === 401) markAuthRequired(retryError);
      throw retryError;
    }
  }
}

export function recordSearchEvent({ query, resultCount, filters, ...metadata }, context = null) {
  const interactionContext = normalizeInteractionContext(context);
  assertInteractionContext(interactionContext);
  const mutationId = queuePendingSearch(
    { query, resultCount, filters },
    metadata.mutationId || createMutationId(),
    metadata.firstQueuedAt,
    interactionContext.owner
  );
  const pendingPersisted = pendingInteractionsPersisted();
  const pendingEntry = readPendingInteractions(interactionContext.owner).searches[mutationId];
  const clientOccurredAt = pendingEntry?.firstQueuedAt || new Date().toISOString();
  return enqueueMutation(`${interactionContext.owner}:search:${mutationId}`, async () => {
    try {
      assertInteractionContext(interactionContext);
      const result = await withFreshInteractionSession(metadata, async (sessionId) => request("/search-events", {
        method: "POST",
        body: JSON.stringify({
          session_id: sessionId,
          query,
          result_count: resultCount,
          filters,
          client_occurred_at: clientOccurredAt,
          client_mutation_id: mutationId,
          client_device_id: pendingEntry?.clientDeviceId || undefined,
          client_event_sequence: pendingEntry?.clientEventSequence || undefined
        })
      }, interactionContext), interactionContext);
      assertInteractionContext(interactionContext);
      acknowledgePendingSearch(mutationId, interactionContext.owner);
      return result;
    } catch (error) {
      error.pendingPersisted = pendingPersisted;
      if (!shouldKeepPendingInteraction(error) && isCurrentInteractionContext(interactionContext)) {
        acknowledgePendingSearch(mutationId, interactionContext.owner);
      }
      throw error;
    }
  });
}

export function submitSignal({ record, rating, watchMinutes, ...metadata }, context = null) {
  const interactionContext = normalizeInteractionContext(context);
  assertInteractionContext(interactionContext);
  const mutationId = queuePendingSignal(record.id, { rating, watchMinutes }, metadata.mutationId, metadata.firstQueuedAt, interactionContext.owner);
  const pendingPersisted = pendingInteractionsPersisted();
  const pendingEntry = readPendingInteractions(interactionContext.owner).signals[mutationId];
  const clientOccurredAt = pendingEntry?.firstQueuedAt || new Date().toISOString();
  return enqueueMutation(`${interactionContext.owner}:signal:${record.id}`, async () => {
    try {
      assertInteractionContext(interactionContext);
      const result = await withFreshInteractionSession(metadata, async (sessionId) => request("/signals", {
        method: "POST",
        body: JSON.stringify({
          session_id: sessionId,
          show_id: record.id,
          rating,
          watch_minutes: watchMinutes,
          client_occurred_at: clientOccurredAt,
          client_mutation_id: mutationId,
          client_device_id: pendingEntry?.clientDeviceId || undefined,
          client_event_sequence: pendingEntry?.clientEventSequence || undefined
        })
      }, interactionContext), interactionContext);
      assertInteractionContext(interactionContext);
      acknowledgePendingSignal(record.id, mutationId, interactionContext.owner);
      return result;
    } catch (error) {
      error.pendingPersisted = pendingPersisted;
      if (!shouldKeepPendingInteraction(error) && isCurrentInteractionContext(interactionContext)) {
        acknowledgePendingSignal(record.id, mutationId, interactionContext.owner);
      }
      throw error;
    }
  });
}

export function isRetryableInteractionError(error) {
  // Only a confirmed expired session may trigger a fresh session. A title 404
  // or an expired auth cookie is a definitive response and must reach the UI.
  return !error?.status
    || error.code === "SESSION_NOT_FOUND"
    || [408, 429].includes(error.status)
    || error.status >= 500;
}

function shouldKeepPendingInteraction(error) {
  // Auth-required payloads belong to the signed-in owner. Keep them paused so
  // re-authentication can retry them, without presenting the current save as
  // a successful local-only write.
  return isRetryableInteractionError(error)
    || error?.code === "AUTH_REQUIRED"
    || error?.status === 401;
}

async function withFreshInteractionSession(metadata, operation, context = null) {
  const interactionContext = normalizeInteractionContext(context);
  assertInteractionContext(interactionContext);
  const sessionId = await ensureInteractionSession(metadata, interactionContext);
  assertInteractionContext(interactionContext);
  try {
    const result = await operation(sessionId);
    assertInteractionContext(interactionContext);
    return result;
  } catch (error) {
    if (error.code !== "SESSION_NOT_FOUND") throw error;
    assertInteractionContext(interactionContext);
    interactionSessionStore.write(null, null, interactionContext.owner);
    const freshSessionId = await ensureInteractionSession(metadata, interactionContext);
    assertInteractionContext(interactionContext);
    try {
      const result = await operation(freshSessionId);
      assertInteractionContext(interactionContext);
      return result;
    } catch (retryError) {
      if (retryError.code === "AUTH_REQUIRED" || retryError.status === 401) markAuthRequired(retryError);
      throw retryError;
    }
  }
}

function markAuthRequired(error) {
  if (error && typeof error === "object") error.authRequired = true;
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("cinemind-auth-required"));
  } catch {
    // Event notification is best-effort; the caller still receives the error.
  }
  return error;
}

export function getInteractionContext() {
  return captureInteractionContext();
}

export async function syncPendingInteractions(records, metadata = {}) {
  const interactionContext = captureInteractionContext();
  if (pendingSyncRequest?.owner === interactionContext.owner
    && pendingSyncRequest?.revision === interactionContext.revision) return pendingSyncRequest.promise;

  const promise = syncPendingInteractionsOnce(records, metadata, interactionContext)
    .finally(() => {
      if (pendingSyncRequest?.promise === promise) pendingSyncRequest = null;
    });
  pendingSyncRequest = { ...interactionContext, promise };
  return promise;
}

async function syncPendingInteractionsOnce(records, metadata, interactionContext) {
  assertInteractionContext(interactionContext);
  const existingBackoff = pendingSyncBackoffs.get(interactionContext.owner);
  if (existingBackoff && existingBackoff.until > Date.now()) return [];
  const recordsById = new Map((records || []).map((record) => [String(record.id), record]));
  const pending = readPendingInteractions(interactionContext.owner);
  const pendingEvents = [];

  for (const search of Object.values(pending.searches)) {
    if (!search || typeof search !== "object" || !search.mutationId) {
      if (search?.mutationId && isCurrentInteractionContext(interactionContext)) {
        acknowledgePendingSearch(search.mutationId, interactionContext.owner);
      }
      continue;
    }
    pendingEvents.push({ kind: "search", entry: search });
  }

  for (const signal of Object.values(pending.signals)) {
    const showId = String(signal?.showId || "").trim();
    const record = recordsById.get(showId);
    if (!signal || typeof signal !== "object" || !signal.mutationId) {
      continue;
    }
    if (!record) {
      pendingEvents.push({
        kind: "signal",
        entry: signal,
        record: null,
        unavailable: true
      });
      continue;
    }
    pendingEvents.push({ kind: "signal", entry: signal, record });
  }
  // Preserve the historical event order during replay. Signals for the same
  // title are serialized by enqueueMutation, but Promise.all would still let
  // different titles/searches reach PostgreSQL in an arbitrary order.
  const orderedPending = pendingEvents.sort((left, right) => {
    const leftTime = Date.parse(left.entry?.firstQueuedAt || left.entry?.queuedAt || "") || 0;
    const rightTime = Date.parse(right.entry?.firstQueuedAt || right.entry?.queuedAt || "") || 0;
    return leftTime - rightTime || String(left.entry?.mutationId || "").localeCompare(String(right.entry?.mutationId || ""));
  });
  if (!orderedPending.length) {
    pendingSyncBackoffs.delete(interactionContext.owner);
    return [];
  }

  const batchSize = configuredPendingSyncBatchSize();
  const pacingMs = configuredPendingSyncPacingMs();
  const results = [];
  let attempted = 0;
  let rateLimited = false;
  let authBlocked = false;
  // A title missing from the current catalog is intentionally retained for a
  // later refresh, but it must not consume network batch capacity. Otherwise
  // a full prefix of unavailable titles starves every valid event behind it
  // until the queue TTL expires.
  const unavailableEntries = orderedPending.filter((event) => event.unavailable);
  results.push(...unavailableEntries.map((event) => {
    const reason = new Error(`Catalog title ${event.entry.showId} is not available yet`);
    reason.code = "CATALOG_RECORD_UNAVAILABLE";
    return { status: "rejected", reason, entry: event.entry };
  }));
  const batch = orderedPending.filter((event) => !event.unavailable).slice(0, batchSize);
  for (const { kind, entry, record } of batch) {
    if (attempted > 0 && pacingMs > 0) await waitForPendingSyncPacing(pacingMs);
    try {
      assertInteractionContext(interactionContext);
    } catch (reason) {
      // Stop the snapshot when the owner changes. Remaining entries stay in
      // the captured owner's outbox and cannot be replayed into a new owner.
      results.push({ status: "rejected", reason });
      break;
    }
    attempted += 1;
    try {
      const task = kind === "search"
        ? recordSearchEvent({
          query: entry.query,
          resultCount: entry.resultCount,
          filters: entry.filters,
          ...metadata,
          mutationId: entry.mutationId,
          firstQueuedAt: entry.firstQueuedAt
        }, interactionContext)
        : submitSignal({
          record,
          ...entry,
          ...metadata,
          mutationId: entry.mutationId,
          firstQueuedAt: entry.firstQueuedAt
        }, interactionContext);
      results.push({ status: "fulfilled", value: await task, entry });
    } catch (reason) {
      results.push({ status: "rejected", reason, entry });
      if (reason?.status === 429) {
        rateLimited = true;
        setPendingSyncBackoff(interactionContext.owner, reason);
        break;
      }
      if (reason?.status === 401 || reason?.status === 403 || reason?.authRequired) {
        authBlocked = true;
        setPendingSyncBackoff(interactionContext.owner, { retryAfterMs: 60000 });
        break;
      }
    }
  }
  if (!rateLimited && !authBlocked) pendingSyncBackoffs.delete(interactionContext.owner);
  return results;
}

function configuredPendingSyncBatchSize() {
  const value = Number(interactionConfig.pendingSyncBatchSize);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PENDING_SYNC_BATCH_SIZE;
}

function configuredPendingSyncPacingMs() {
  const value = Number(interactionConfig.pendingSyncPacingMs);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PENDING_SYNC_PACING_MS;
}

function configuredPendingSyncBackoffMs() {
  const value = Number(interactionConfig.pendingSyncBackoffMs);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PENDING_SYNC_BACKOFF_MS;
}

function configuredPendingSyncMaxBackoffMs() {
  const value = Number(interactionConfig.pendingSyncMaxBackoffMs);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PENDING_SYNC_MAX_BACKOFF_MS;
}

function setPendingSyncBackoff(owner, error) {
  const previous = pendingSyncBackoffs.get(owner);
  const attempt = (previous?.attempt || 0) + 1;
  const retryAfterMs = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0
    ? error.retryAfterMs
    : null;
  const fallbackDelay = Math.min(
    configuredPendingSyncBackoffMs() * (2 ** (attempt - 1)),
    configuredPendingSyncMaxBackoffMs()
  );
  pendingSyncBackoffs.set(owner, {
    attempt,
    until: Date.now() + (retryAfterMs === null ? fallbackDelay : retryAfterMs)
  });
}

function waitForPendingSyncPacing(delayMs) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function enqueueMutation(key, operation) {
  const previous = mutationChains.get(key) || Promise.resolve();
  const next = previous.then(operation, operation);
  const tracked = next.finally(() => {
    if (mutationChains.get(key) === tracked) mutationChains.delete(key);
  });
  mutationChains.set(key, tracked);
  return tracked;
}
