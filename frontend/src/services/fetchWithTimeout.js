// Abort network calls that would otherwise leave the shell in a permanent
// loading state when a proxy or upstream socket stops responding.

export class RequestTimeoutError extends Error {
  constructor(message = "The request timed out") {
    super(message);
    this.name = "RequestTimeoutError";
    this.code = "REQUEST_TIMEOUT";
  }
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
  const forwardAbort = () => controller.abort();

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limit);

  try {
    return await fetch(input, { ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError(`Request timed out after ${limit} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}
