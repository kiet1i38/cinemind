// HTTP client for CineMind's anonymous interaction API.

import { appConfig, resolveApiBaseUrl } from "../config/appConfig";
import { fetchWithTimeout } from "./fetchWithTimeout";
import {
  acknowledgePendingSearch,
  acknowledgePendingSignal,
  createMutationId,
  getInteractionOwner,
  interactionSessionStore,
  pendingInteractionsPersisted,
  queuePendingSearch,
  queuePendingSignal,
  readPendingInteractions
} from "./interactionStore";

const interactionConfig = appConfig.interaction;
let sessionRequest = null;
let pendingSyncRequest = null;
const mutationChains = new Map();

function ownerChangedError() {
  const error = new Error("Interaction owner changed while a request was in flight");
  error.code = "INTERACTION_OWNER_CHANGED";
  return error;
}

function assertOwner(owner) {
  if (getInteractionOwner() !== owner) throw ownerChangedError();
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const sessionId = interactionSessionStore.read();
  const sessionToken = interactionSessionStore.readToken();
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

  if (!response.ok) {
    const detail = typeof payload?.detail === "string"
      ? payload.detail
      : payload?.detail?.message || `Interaction request failed with ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    error.code = payload?.detail?.code || payload?.code;
    throw error;
  }
  return payload;
}

export async function ensureInteractionSession({ locale, platform } = {}) {
  const owner = getInteractionOwner();
  const existingSessionId = interactionSessionStore.read();
  if (existingSessionId) return existingSessionId;
  if (sessionRequest?.owner === owner) return sessionRequest.promise;

  const promise = request("/sessions", {
    method: "POST",
    body: JSON.stringify({ locale, platform })
  })
    .then((payload) => {
      // A response from a previous account must never hydrate the current
      // owner's browser namespace.
      assertOwner(owner);
      const sessionId = payload?.session_id;
      if (!sessionId) throw new Error("Interaction session response is missing session_id");
      interactionSessionStore.write(sessionId, payload?.session_token);
      return sessionId;
    })
    .finally(() => {
      if (sessionRequest?.promise === promise) sessionRequest = null;
    });
  sessionRequest = { owner, promise };
  return promise;
}

export async function getInteractionState(metadata = {}) {
  const owner = getInteractionOwner();
  let sessionId = await ensureInteractionSession(metadata);
  assertOwner(owner);
  try {
    const result = await request(`/state/${encodeURIComponent(sessionId)}`);
    assertOwner(owner);
    return result;
  } catch (error) {
    if (error.code !== "SESSION_NOT_FOUND") throw error;
    assertOwner(owner);
    interactionSessionStore.write(null);
    sessionId = await ensureInteractionSession(metadata);
    assertOwner(owner);
    try {
      const result = await request(`/state/${encodeURIComponent(sessionId)}`);
      assertOwner(owner);
      return result;
    } catch (retryError) {
      if (retryError.code === "AUTH_REQUIRED" || retryError.status === 401) markAuthRequired(retryError);
      throw retryError;
    }
  }
}

export async function recordSearchEvent({ query, resultCount, filters, ...metadata }) {
  const mutationId = queuePendingSearch(
    { query, resultCount, filters },
    metadata.mutationId || createMutationId(),
    metadata.firstQueuedAt
  );
  const pendingPersisted = pendingInteractionsPersisted();
  const pendingEntry = readPendingInteractions().searches[mutationId];
  const clientOccurredAt = pendingEntry?.firstQueuedAt || new Date().toISOString();
  const owner = getInteractionOwner();
  return enqueueMutation(`${owner}:search:${mutationId}`, async () => {
    try {
      const result = await withFreshInteractionSession(metadata, async (sessionId) => request("/search-events", {
        method: "POST",
        body: JSON.stringify({
          session_id: sessionId,
          query,
          result_count: resultCount,
          filters,
          client_occurred_at: clientOccurredAt,
          client_mutation_id: mutationId
        })
      }));
      acknowledgePendingSearch(mutationId);
      return result;
    } catch (error) {
      error.pendingPersisted = pendingPersisted;
      if (!shouldKeepPendingInteraction(error)) acknowledgePendingSearch(mutationId);
      throw error;
    }
  });
}

export async function submitSignal({ record, rating, watchMinutes, ...metadata }) {
  const mutationId = queuePendingSignal(record.id, { rating, watchMinutes }, metadata.mutationId, metadata.firstQueuedAt);
  const pendingPersisted = pendingInteractionsPersisted();
  const pendingEntry = readPendingInteractions().signals[mutationId];
  const clientOccurredAt = pendingEntry?.firstQueuedAt || new Date().toISOString();
  const owner = getInteractionOwner();
  return enqueueMutation(`${owner}:signal:${record.id}`, async () => {
    try {
      const result = await withFreshInteractionSession(metadata, async (sessionId) => request("/signals", {
        method: "POST",
        body: JSON.stringify({
          session_id: sessionId,
          show_id: record.id,
          rating,
          watch_minutes: watchMinutes,
          client_occurred_at: clientOccurredAt,
          client_mutation_id: mutationId
        })
      }));
      acknowledgePendingSignal(record.id, mutationId);
      return result;
    } catch (error) {
      error.pendingPersisted = pendingPersisted;
      if (!shouldKeepPendingInteraction(error)) acknowledgePendingSignal(record.id, mutationId);
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

async function withFreshInteractionSession(metadata, operation) {
  const owner = getInteractionOwner();
  const sessionId = await ensureInteractionSession(metadata);
  assertOwner(owner);
  try {
    return await operation(sessionId);
  } catch (error) {
    if (error.code !== "SESSION_NOT_FOUND") throw error;
    assertOwner(owner);
    interactionSessionStore.write(null);
    const freshSessionId = await ensureInteractionSession(metadata);
    assertOwner(owner);
    try {
      return await operation(freshSessionId);
    } catch (retryError) {
      if (retryError.code === "AUTH_REQUIRED" || retryError.status === 401) markAuthRequired(retryError);
      throw retryError;
    }
  }
}

function markAuthRequired(error) {
  if (error && typeof error === "object") error.authRequired = true;
  return error;
}

export async function syncPendingInteractions(records, metadata = {}) {
  const owner = getInteractionOwner();
  if (pendingSyncRequest?.owner === owner) return pendingSyncRequest.promise;

  const promise = syncPendingInteractionsOnce(records, metadata)
    .finally(() => {
      if (pendingSyncRequest?.promise === promise) pendingSyncRequest = null;
    });
  pendingSyncRequest = { owner, promise };
  return promise;
}

async function syncPendingInteractionsOnce(records, metadata) {
  const recordsById = new Map((records || []).map((record) => [String(record.id), record]));
  const pending = readPendingInteractions();
  const pendingEvents = [];

  for (const search of Object.values(pending.searches)) {
    if (!search || typeof search !== "object" || !search.mutationId) {
      if (search?.mutationId) acknowledgePendingSearch(search.mutationId);
      continue;
    }
    pendingEvents.push({ kind: "search", entry: search });
  }

  for (const signal of Object.values(pending.signals)) {
    const showId = String(signal?.showId || "").trim();
    const record = recordsById.get(showId);
    if (!record || !signal || typeof signal !== "object" || !signal.mutationId) {
      if (signal?.mutationId) acknowledgePendingSignal(showId, signal.mutationId);
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
  const results = [];
  for (const { kind, entry, record } of orderedPending) {
    try {
      const task = kind === "search"
        ? recordSearchEvent({
          query: entry.query,
          resultCount: entry.resultCount,
          filters: entry.filters,
          ...metadata,
          mutationId: entry.mutationId,
          firstQueuedAt: entry.firstQueuedAt
        })
        : submitSignal({
          record,
          ...entry,
          ...metadata,
          mutationId: entry.mutationId,
          firstQueuedAt: entry.firstQueuedAt
        });
      results.push({ status: "fulfilled", value: await task });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }
  return results;
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
