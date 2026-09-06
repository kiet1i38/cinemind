// Cookie-session client for the account API. No token is stored in JavaScript.

import { authConfig, resolveApiBaseUrl } from "../config/appConfig";
import { interactionSessionStore } from "./interactionStore";

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${resolveApiBaseUrl(authConfig.apiBaseUrl)}${path}`, {
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
    const detail = typeof payload?.detail === "string" ? payload.detail : `Authentication request failed with ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function interactionSessionPayload() {
  const sessionId = interactionSessionStore.read();
  return sessionId ? { anonymous_session_id: sessionId } : {};
}

export async function getCurrentUser() {
  const payload = await request("/me");
  return payload?.authenticated ? payload.user : null;
}

export function login({ identifier, password }) {
  return request("/login", {
    method: "POST",
    body: JSON.stringify({ identifier, password, ...interactionSessionPayload() })
  });
}

export function register({ email, username, displayName, password }) {
  return request("/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      username,
      display_name: displayName,
      password,
      ...interactionSessionPayload()
    })
  });
}

export function logout() {
  return request("/logout", { method: "POST" });
}

export function logoutAll() {
  return request("/logout-all", { method: "POST" });
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
