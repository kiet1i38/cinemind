// Cookie-session client for the account API. No token is stored in JavaScript.

import { appConfig, authConfig, resolveApiBaseUrl } from "../config/appConfig";
import { getInteractionOwner, interactionSessionStore, promoteAuthenticatedInteraction } from "./interactionStore";
import { fetchWithTimeout } from "./fetchWithTimeout";

export const AUTH_EVENT_STORAGE_KEY = authConfig.eventsStorageKey || "cinemind-auth-event";

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetchWithTimeout(`${resolveApiBaseUrl(authConfig.apiBaseUrl)}${path}`, {
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
      : payload?.detail?.message || `Authentication request failed with ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    error.code = payload?.detail?.code || payload?.code;
    throw error;
  }
  return payload;
}

function interactionSessionPayload() {
  const sessionId = interactionSessionStore.read();
  const sessionToken = interactionSessionStore.readToken();
  return sessionId
    ? { anonymous_session_id: sessionId, anonymous_session_token: sessionToken }
    : {};
}

export async function getCurrentUser({ signal } = {}) {
  try {
    const payload = await request("/me", { signal });
    return payload?.authenticated ? payload.user : null;
  } catch (error) {
    // An expired or revoked cookie is an anonymous state, not an outage.
    if (error?.status === 401 || error?.status === 403) return null;
    throw error;
  }
}

export async function login({ identifier, password }) {
  const result = await request("/login", {
    method: "POST",
    body: JSON.stringify({ identifier, password, ...interactionSessionPayload() })
  });
  promoteAuthenticatedInteraction(result?.user?.user_id, result?.interaction_session_id);
  broadcastAuthEvent("login");
  return result;
}

export async function register({ email, username, displayName, password }) {
  const result = await request("/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      username,
      display_name: displayName,
      password,
      ...interactionSessionPayload()
    })
  });
  promoteAuthenticatedInteraction(result?.user?.user_id, result?.interaction_session_id);
  broadcastAuthEvent("login");
  return result;
}

export async function logout({ preservePendingInteractions = false } = {}) {
  const sessionId = interactionSessionStore.read();
  const sessionToken = interactionSessionStore.readToken();
  const result = await request("/logout", {
    method: "POST",
    body: JSON.stringify({
      interaction_session_id: sessionId,
      interaction_session_token: sessionToken
    })
  });
  broadcastAuthEvent("logout", { preservePendingInteractions });
  return result;
}

export async function logoutAll({ preservePendingInteractions = false } = {}) {
  const result = await request("/logout-all", { method: "POST" });
  broadcastAuthEvent("logout", { preservePendingInteractions });
  return result;
}

function broadcastAuthEvent(type, details = {}) {
  try {
    const eventId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(AUTH_EVENT_STORAGE_KEY, JSON.stringify({
      type,
      eventId,
      occurredAt: Date.now(),
      ownerId: getInteractionOwner(),
      ...details
    }));
  } catch {
    // Storage is optional; the current tab still completes its auth flow.
  }
}

function currentReturnTo() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function pageUrl(page, mode, returnTo) {
  const url = new URL(`./${page}`, window.location.href);
  if (mode) url.searchParams.set("mode", mode);
  if (returnTo) url.searchParams.set("returnTo", returnTo);
  return `${url.pathname}${url.search}`;
}

export function getAuthPageUrl(mode = "login", returnTo = currentReturnTo()) {
  return pageUrl(authConfig.authPage, mode, returnTo);
}

export function getProfilePageUrl() {
  return pageUrl(authConfig.profilePage);
}
