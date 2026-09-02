function hasStorage() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

export function createJsonStore(key, fallback) {
  const getFallback = () => (typeof fallback === "function" ? fallback() : fallback);

  return {
    read() {
      if (!hasStorage()) return getFallback();
      try {
        const value = window.localStorage.getItem(key);
        return value ? JSON.parse(value) : getFallback();
      } catch {
        return getFallback();
      }
    },
    write(value) {
      if (!hasStorage()) return;
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Browser storage can be unavailable or full. The UI remains usable in memory.
      }
    }
  };
}
