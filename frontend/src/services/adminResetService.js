// Client for the protected maintenance endpoint. Credentials stay in memory only.

import { appConfig, resolveApiBaseUrl } from "../config/appConfig";

const resetConfig = appConfig.adminReset;

function encodeBasicCredentials(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

export async function resetDatabase({ username, password, scope, confirmation, sessionId }) {
  const payload = { scope, confirmation };
  if (scope === "interaction" && sessionId) payload.session_id = sessionId;

  const response = await fetch(`${resolveApiBaseUrl(resetConfig.apiBaseUrl)}${resetConfig.resetPath}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodeBasicCredentials(username, password)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    credentials: "omit"
  });
  const result = await parseResponse(response);
  if (!response.ok) {
    const error = new Error(result?.detail || `Reset request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

export function readCurrentInteractionSession() {
  try {
    const value = window.localStorage.getItem(appConfig.interaction.sessionStorageKey);
    return value?.trim() || null;
  } catch {
    return null;
  }
}

export function clearLocalInteractionState() {
  const keys = [
    appConfig.interaction.sessionStorageKey,
    appConfig.interaction.favoritesStorageKey,
    appConfig.interaction.watchlistStorageKey,
    appConfig.signals.storageKey
  ];
  try {
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Local storage can be unavailable in a restricted browser context.
  }
}
