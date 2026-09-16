// Abort network calls that would otherwise leave the shell in a permanent
// loading state when a proxy or upstream socket stops responding.

export class RequestTimeoutError extends Error {
  constructor(message = "The request timed out") {
    super(message);
    this.name = "RequestTimeoutError";
    this.code = "REQUEST_TIMEOUT";
  }
}

const BODY_METHODS = new Set(["arrayBuffer", "blob", "formData", "json", "text"]);

function clearResponseTimeout(state) {
  if (!state || state.cleaned) return;
  clearTimeout(state.timer);
  state.externalSignal?.removeEventListener("abort", state.forwardAbort);
  state.cleaned = true;
}

function wrapResponseBody(response, state) {
  if (!response || typeof response !== "object") return response;
  return new Proxy(response, {
    get(target, property) {
      if (!BODY_METHODS.has(property)) return Reflect.get(target, property, target);
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      return (...args) => {
        let bodyPromise;
        try {
          bodyPromise = Promise.resolve(method.apply(target, args));
        } catch (error) {
          clearResponseTimeout(state);
          throw error;
        }
        return Promise.race([bodyPromise, state.timeoutPromise])
          .catch((error) => {
            if (state.timedOut) {
              throw new RequestTimeoutError(`Request timed out after ${state.limit} ms`);
            }
            throw error;
          })
          .finally(() => clearResponseTimeout(state));
      };
    }
  });
}

export async function fetchWithTimeout(input, options = {}, timeoutMs = 8000) {
  const limit = Number(timeoutMs);
  if (!Number.isFinite(limit) || limit <= 0 || typeof AbortController === "undefined") {
    return fetch(input, options);
  }

  const controller = new AbortController();
  const externalSignal = options.signal;
  let timedOut = false;
  let timer = null;
  let responseReceived = false;
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  // A caller may inspect only response headers and never consume the body.
  // Mark the internal timeout rejection as handled while still allowing a
  // body-method race to observe the same rejection.
  timeoutPromise.catch(() => undefined);
  const forwardAbort = () => controller.abort();
  const state = {
    externalSignal,
    forwardAbort,
    limit,
    timer: null,
    timedOut: false,
    timeoutPromise,
    cleaned: false
  };

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  timer = setTimeout(() => {
    timedOut = true;
    state.timedOut = true;
    controller.abort();
    rejectTimeout(new RequestTimeoutError(`Request timed out after ${limit} ms`));
    // A caller may stop at the Response headers and never consume the body.
    // Clean the external listener here as well as in the body-method finally
    // block so each timed-out response releases its resources deterministically.
    clearResponseTimeout(state);
  }, limit);
  state.timer = timer;

  try {
    const response = await fetch(input, { ...options, signal: controller.signal });
    responseReceived = true;
    return wrapResponseBody(response, state);
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError(`Request timed out after ${limit} ms`);
    throw error;
  } finally {
    // A successful fetch only means that response headers arrived. Keep the
    // timer and abort listener alive until the caller consumes the body.
    // Failed header requests have no Response wrapper to clean them up.
    if (!responseReceived || timedOut) clearResponseTimeout(state);
  }
}
