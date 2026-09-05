// HTTP client for CineMind's anonymous interaction API.

import { appConfig } from "../config/appConfig";
import { interactionSessionStore } from "./interactionStore";

const interactionConfig = appConfig.interaction;
let sessionRequest = null;

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(`${interactionConfig.apiBaseUrl}${path}`, { ...options, headers });
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
    if (error.status !== 404) throw error;
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
  const sessionId = await ensureInteractionSession(metadata);
  return request("/signals", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      show_id: record.id,
      rating,
      watch_minutes: watchMinutes
    })
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
