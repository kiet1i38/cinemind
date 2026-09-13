// HTTP client for CineMind's anonymous interaction API.

import { appConfig, resolveApiBaseUrl } from "../config/appConfig";
import {
  acknowledgePendingSearch,
  acknowledgePendingSignal,
  createMutationId,
  getInteractionOwner,
  interactionSessionStore,
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

  const response = await fetch(`${resolveApiBaseUrl(interactionConfig.apiBaseUrl)}${path}`, {
    ...options,
    headers,
    credentials: "include"
  });
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
    const error = new Error(payload?.detail || `Interaction request failed with ${response.status}`);
    error.status = response.status;
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
    if (error.status !== 404 && error.status !== 401) throw error;
    assertOwner(owner);
    interactionSessionStore.write(null);
    sessionId = await ensureInteractionSession(metadata);
    assertOwner(owner);
    try {
      const result = await request(`/state/${encodeURIComponent(sessionId)}`);
      assertOwner(owner);
      return result;
    } catch (retryError) {
      if (retryError.status === 401) markAuthRequired(retryError);
      throw retryError;
    }
  }
}

export async function recordSearchEvent({ query, resultCount, filters, ...metadata }) {
  const mutationId = queuePendingSearch(
    { query, resultCount, filters },
    metadata.mutationId || createMutationId()
  );
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
          client_mutation_id: mutationId
        })
      }));
      acknowledgePendingSearch(mutationId);
      return result;
    } catch (error) {
      if (!isRetryableInteractionError(error)) acknowledgePendingSearch(mutationId);
      throw error;
    }
  });
}

export async function submitSignal({ record, rating, watchMinutes, ...metadata }) {
  const mutationId = queuePendingSignal(record.id, { rating, watchMinutes }, metadata.mutationId);
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
          client_mutation_id: mutationId
        })
      }));
      acknowledgePendingSignal(record.id, mutationId);
      return result;
    } catch (error) {
      if (!isRetryableInteractionError(error)) acknowledgePendingSignal(record.id, mutationId);
      throw error;
    }
  });
}

export function isRetryableInteractionError(error) {
  return !error?.status || error.status === 408 || error.status === 429 || error.status >= 500;
}

async function withFreshInteractionSession(metadata, operation) {
  const owner = getInteractionOwner();
  const sessionId = await ensureInteractionSession(metadata);
  assertOwner(owner);
  try {
    return await operation(sessionId);
  } catch (error) {
    if (error.status !== 401 && error.status !== 404) throw error;
    assertOwner(owner);
    interactionSessionStore.write(null);
    const freshSessionId = await ensureInteractionSession(metadata);
    assertOwner(owner);
    try {
      return await operation(freshSessionId);
    } catch (retryError) {
      if (retryError.status === 401) markAuthRequired(retryError);
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
  const tasks = [];

  for (const search of Object.values(pending.searches)) {
    if (!search || typeof search !== "object" || !search.mutationId) continue;
    tasks.push(recordSearchEvent({
      query: search.query,
      resultCount: search.resultCount,
      filters: search.filters,
      ...metadata,
      mutationId: search.mutationId
    }));
  }

  for (const [showId, signal] of Object.entries(pending.signals)) {
    const record = recordsById.get(showId);
    if (record) {
      tasks.push(submitSignal({ record, ...signal, ...metadata, mutationId: signal.mutationId }));
    }
  }
  return Promise.allSettled(tasks);
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
