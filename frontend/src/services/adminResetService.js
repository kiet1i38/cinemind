// Client for the protected maintenance endpoint. Credentials stay in memory only.

import { appConfig, resolveApiBaseUrl } from "../config/appConfig";
import { clearInteractionState, interactionSessionStore } from "./interactionStore";

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
  const value = interactionSessionStore.read();
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null;
}

export function clearLocalInteractionState() {
  clearInteractionState({ clearPending: true, resetOwner: true });
}
