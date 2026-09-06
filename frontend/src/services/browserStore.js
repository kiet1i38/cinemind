const memoryValues = new Map();

function getStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function createJsonStore(key, fallback) {
  const getFallback = () => (typeof fallback === "function" ? fallback() : fallback);

  return {
    read() {
      const storage = getStorage();
      if (!storage) return memoryValues.has(key) ? memoryValues.get(key) : getFallback();
      try {
        const value = storage.getItem(key);
        if (value) {
          const parsed = JSON.parse(value);
          memoryValues.set(key, parsed);
          return parsed;
        }
      } catch {
        // Continue with the in-memory copy when the browser blocks storage.
      }
      return memoryValues.has(key) ? memoryValues.get(key) : getFallback();
    },
    write(value) {
      memoryValues.set(key, value);
      const storage = getStorage();
      if (!storage) return;
      try {
        storage.setItem(key, JSON.stringify(value));
      } catch {
        // Browser storage can be unavailable or full. The UI remains usable in memory.
      }
    },
    remove() {
      memoryValues.delete(key);
      const storage = getStorage();
      if (!storage) return;
      try {
        storage.removeItem(key);
      } catch {
        // Browser storage can be unavailable in a restricted context.
      }
    }
  };
}
