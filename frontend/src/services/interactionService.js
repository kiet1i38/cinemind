// HTTP client for CineMind's anonymous interaction API.

import { appConfig, resolveApiBaseUrl } from "../config/appConfig";
import {
  acknowledgePendingPreference,
  acknowledgePendingSignal,
  interactionSessionStore,
  queuePendingPreference,
  queuePendingSignal,
  readPendingInteractions
} from "./interactionStore";

const interactionConfig = appConfig.interaction;
let sessionRequest = null;
const mutationChains = new Map();

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

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
  const existingSessionId = interactionSessionStore.read();
  if (existingSessionId) return existingSessionId;
  if (!sessionRequest) {
    sessionRequest = request("/sessions", {
      method: "POST",
      body: JSON.stringify({ locale, platform })
    })
      .then((payload) => {
        const sessionId = payload?.session_id;
        if (!sessionId) throw new Error("Interaction session response is missing session_id");
        interactionSessionStore.write(sessionId);
        return sessionId;
      })
      .finally(() => {
        sessionRequest = null;
      });
  }
  return sessionRequest;
}

export async function getInteractionState(metadata = {}) {
  let sessionId = await ensureInteractionSession(metadata);
  try {
    return await request(`/state/${encodeURIComponent(sessionId)}`);
  } catch (error) {
    if (error.status !== 404 && error.status !== 401) throw error;
    interactionSessionStore.write(null);
    sessionId = await ensureInteractionSession(metadata);
    return request(`/state/${encodeURIComponent(sessionId)}`);
  }
}

export async function recordSearchEvent({ query, resultCount, filters, ...metadata }) {
  const sessionId = await ensureInteractionSession(metadata);
  return request("/search-events", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      query,
      result_count: resultCount,
      filters
    })
  });
}

export async function submitSignal({ record, rating, watchMinutes, ...metadata }) {
  const mutationId = queuePendingSignal(record.id, { rating, watchMinutes }, metadata.mutationId);
  return enqueueMutation(`signal:${record.id}`, async () => {
    try {
      const sessionId = await ensureInteractionSession(metadata);
      const result = await request("/signals", {
        method: "POST",
        body: JSON.stringify({
          session_id: sessionId,
          show_id: record.id,
          rating,
          watch_minutes: watchMinutes
        })
      });
      acknowledgePendingSignal(record.id, mutationId);
      return result;
    } catch (error) {
      if (!isRetryableInteractionError(error)) acknowledgePendingSignal(record.id, mutationId);
      throw error;
    }
  });
}

async function changePreference(path, method, record, metadata) {
  const sessionId = await ensureInteractionSession(metadata);
  const options = { method };
  if (method === "POST") {
    options.body = JSON.stringify({ session_id: sessionId, show_id: record.id });
  } else {
    path += `/${encodeURIComponent(record.id)}/${encodeURIComponent(sessionId)}`;
  }
  return request(path, options);
}

export function addFavorite(record, metadata) {
  return changePreference("/favorites", "POST", record, metadata);
}

export function removeFavorite(record, metadata) {
  return changePreference("/favorites", "DELETE", record, metadata);
}

export function addWatchlistItem(record, metadata) {
  return changePreference("/watchlist-items", "POST", record, metadata);
}

export function removeWatchlistItem(record, metadata) {
  return changePreference("/watchlist-items", "DELETE", record, metadata);
}

export function isRetryableInteractionError(error) {
  return !error?.status || error.status === 408 || error.status === 429 || error.status >= 500;
}

export function setFavoritePreference(record, active, metadata = {}) {
  return setPreference("favorites", record, active, metadata);
}

export function setWatchlistPreference(record, active, metadata = {}) {
  return setPreference("watchlist", record, active, metadata);
}

async function setPreference(kind, record, active, metadata) {
  const mutationId = queuePendingPreference(kind, record.id, active, metadata.mutationId);
  const path = kind === "favorites" ? "/favorites" : "/watchlist-items";
  return enqueueMutation(`${kind}:${record.id}`, async () => {
    try {
      const result = active
        ? await changePreference(path, "POST", record, metadata)
        : await changePreference(path, "DELETE", record, metadata);
      acknowledgePendingPreference(kind, record.id, mutationId);
      return result;
    } catch (error) {
      if (!isRetryableInteractionError(error)) acknowledgePendingPreference(kind, record.id, mutationId);
      throw error;
    }
  });
}

export async function syncPendingInteractions(records, metadata = {}) {
  const recordsById = new Map((records || []).map((record) => [String(record.id), record]));
  const pending = readPendingInteractions();
  const tasks = [];

  for (const [showId, signal] of Object.entries(pending.signals)) {
    const record = recordsById.get(showId);
    if (record) {
      tasks.push(submitSignal({ record, ...signal, mutationId: signal.mutationId, ...metadata }));
    }
  }
  for (const [showId, preference] of Object.entries(pending.preferences.favorites)) {
    const record = recordsById.get(showId);
    if (record) {
      tasks.push(setFavoritePreference(record, preference.active, { ...metadata, mutationId: preference.mutationId }));
    }
  }
  for (const [showId, preference] of Object.entries(pending.preferences.watchlist)) {
    const record = recordsById.get(showId);
    if (record) {
      tasks.push(setWatchlistPreference(record, preference.active, { ...metadata, mutationId: preference.mutationId }));
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
