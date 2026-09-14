const memoryValues = new Map();
const memoryOnlyKeys = new Set();

function getStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getBrowserStorage() {
  return getStorage();
}

export function createJsonStore(key, fallback) {
  const getFallback = () => (typeof fallback === "function" ? fallback() : fallback);

  return {
    read() {
      const storage = getStorage();
      if (memoryOnlyKeys.has(key) && memoryValues.has(key)) {
        // A previous quota/restricted-storage failure must not make the
        // current tab immediately fall back to a stale persistent value.
        // Retry persistence opportunistically while keeping memory authoritative.
        if (storage) {
          try {
            storage.setItem(key, JSON.stringify(memoryValues.get(key)));
            memoryOnlyKeys.delete(key);
          } catch {
            // Keep the in-memory value until storage becomes writable again.
          }
        }
        return memoryValues.get(key);
      }
      if (!storage) return memoryValues.has(key) ? memoryValues.get(key) : getFallback();
      try {
        const value = storage.getItem(key);
        if (value === null) {
          memoryValues.delete(key);
          return getFallback();
        }
        const parsed = JSON.parse(value);
        memoryValues.set(key, parsed);
        memoryOnlyKeys.delete(key);
        return parsed;
      } catch {
        // Continue with the in-memory copy when the browser blocks storage.
      }
      return memoryValues.has(key) ? memoryValues.get(key) : getFallback();
    },
    write(value) {
      memoryValues.set(key, value);
      const storage = getStorage();
      if (!storage) return true;
      try {
        storage.setItem(key, JSON.stringify(value));
        memoryOnlyKeys.delete(key);
        return true;
      } catch {
        // Browser storage can be unavailable or full. The UI remains usable in memory.
        memoryOnlyKeys.add(key);
        return false;
      }
    },
    remove() {
      memoryValues.delete(key);
      memoryOnlyKeys.delete(key);
      const storage = getStorage();
      if (!storage) return true;
      try {
        storage.removeItem(key);
        return true;
      } catch {
        // Browser storage can be unavailable in a restricted context.
        return false;
      }
    }
  };
}
