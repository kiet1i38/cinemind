const memoryValues = new Map();
const memoryOnlyKeys = new Set();
// Keep the durable value observed before a write fell back to memory. A later
// read can then distinguish an unchanged value from a concurrent tab update.
const memoryOnlyBaselines = new Map();
const removedKeys = new Set();
// Keep the persistent value observed when a removal could not be completed.
// A later read must not delete a different value written by another tab.
const removedKeySnapshots = new Map();

function serializeMemoryValue(key) {
  if (!memoryValues.has(key)) return undefined;
  try {
    return JSON.stringify(memoryValues.get(key));
  } catch {
    return undefined;
  }
}

function clearRemovalMarker(key) {
  removedKeys.delete(key);
  removedKeySnapshots.delete(key);
}

function clearMemoryOnlyMarker(key) {
  memoryOnlyKeys.delete(key);
  memoryOnlyBaselines.delete(key);
}

function getStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function getSessionStorage() {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function getBrowserStorage() {
  return getStorage();
}

export function getBrowserSessionStorage() {
  return getSessionStorage();
}

export function createJsonStore(key, fallback, storageGetter = getStorage) {
  const getFallback = () => (typeof fallback === "function" ? fallback() : fallback);
  const readStorage = () => {
    try {
      return typeof storageGetter === "function" ? storageGetter() : null;
    } catch {
      return null;
    }
  };

  return {
    read() {
      const storage = readStorage();
      if (removedKeys.has(key)) {
        if (!storage) return getFallback();
        try {
          const persistentValue = storage.getItem(key);
          if (persistentValue === null) {
            clearRemovalMarker(key);
            return getFallback();
          }

          const expectedValue = removedKeySnapshots.get(key);
          // If the key changed after the failed removal, it belongs to a
          // concurrent writer. Preserve that value instead of deleting it.
          if (expectedValue === undefined || persistentValue !== expectedValue) {
            clearRemovalMarker(key);
            const parsed = JSON.parse(persistentValue);
            memoryValues.set(key, parsed);
            clearMemoryOnlyMarker(key);
            return parsed;
          }

          // Re-read immediately before the destructive operation. This does
          // not make localStorage a compare-and-swap primitive, but it closes
          // the observable failed-remove/write interleaving and keeps the
          // tombstone safe when storage becomes writable again.
          if (storage.getItem(key) !== expectedValue) {
            clearRemovalMarker(key);
            const currentValue = storage.getItem(key);
            if (currentValue === null) return getFallback();
            const parsed = JSON.parse(currentValue);
            memoryValues.set(key, parsed);
            clearMemoryOnlyMarker(key);
            return parsed;
          }

          storage.removeItem(key);
          if (storage.getItem(key) === null) {
            clearRemovalMarker(key);
            return getFallback();
          }
        } catch {
          // Keep the tombstone authoritative for this page lifetime.
        }
        return getFallback();
      }
      if (memoryOnlyKeys.has(key) && memoryValues.has(key)) {
        const memoryValue = memoryValues.get(key);
        if (!storage) return memoryValue;

        let persistentValue;
        try {
          persistentValue = storage.getItem(key);
        } catch {
          // Keep the in-memory value while storage is still unavailable.
          return memoryValue;
        }

        const hasBaseline = memoryOnlyBaselines.has(key);
        const baseline = memoryOnlyBaselines.get(key);
        if (hasBaseline && persistentValue !== baseline) {
          // Another tab changed or removed the durable value while this tab
          // was in memory-only mode. Never publish this tab's stale fallback
          // over that newer state.
          clearMemoryOnlyMarker(key);
          if (persistentValue === null) {
            memoryValues.delete(key);
            return getFallback();
          }
          try {
            const parsed = JSON.parse(persistentValue);
            memoryValues.set(key, parsed);
            return parsed;
          } catch {
            memoryValues.delete(key);
            return getFallback();
          }
        }

        if (!hasBaseline) {
          // A missing baseline means the original read was blocked, so an
          // absent key remains ambiguous and the page can keep its session
          // fallback. A recovered durable value is different: it is the only
          // state that can survive a reload, and this tab has no evidence that
          // its memory copy ever reached storage. Let that durable value win
          // instead of exposing a stale cross-tab snapshot.
          if (persistentValue === null) return memoryValue;
          try {
            const parsed = JSON.parse(persistentValue);
            memoryValues.set(key, parsed);
            clearMemoryOnlyMarker(key);
            return parsed;
          } catch {
            memoryValues.delete(key);
            clearMemoryOnlyMarker(key);
            return getFallback();
          }
        }

        if (persistentValue === null) {
          // A known absent baseline may represent the failed first write or a
          // concurrent deletion. Keep the value available to this page, but
          // do not resurrect it implicitly into durable storage.
          return memoryValue;
        }

        // Do not replay a memory-only value from read(). localStorage has no
        // compare-and-swap primitive, so another tab could write between the
        // read above and a setItem() here. A later explicit write() can retry
        // persistence safely with a fresh durable baseline.
        return memoryValue;
      }
      if (!storage) return memoryValues.has(key) ? memoryValues.get(key) : getFallback();
      try {
        const value = storage.getItem(key);
        if (value === null) {
          memoryValues.delete(key);
          clearMemoryOnlyMarker(key);
          return getFallback();
        }
        const parsed = JSON.parse(value);
        memoryValues.set(key, parsed);
        clearMemoryOnlyMarker(key);
        return parsed;
      } catch {
        // Continue with the in-memory copy when the browser blocks storage.
      }
      return memoryValues.has(key) ? memoryValues.get(key) : getFallback();
    },
    write(value) {
      memoryValues.set(key, value);
      clearRemovalMarker(key);
      const storage = readStorage();
      if (!storage) return true;
      let persistentBaseline;
      let hasPersistentBaseline = false;
      try {
        persistentBaseline = storage.getItem(key);
        hasPersistentBaseline = true;
      } catch {
        // A storage read may be blocked independently from a write.
      }
      const serializedValue = JSON.stringify(value);
      try {
        storage.setItem(key, serializedValue);
        // Web Storage normally throws when a write cannot be completed, but
        // wrappers/privacy adapters can silently ignore setItem(). Confirm the
        // value before reporting durable success; otherwise callers may clear
        // their memory fallback and lose the pending state on the next read.
        if (storage.getItem(key) !== serializedValue) throw new Error("storage write was not persisted");
        clearMemoryOnlyMarker(key);
        return true;
      } catch {
        // Browser storage can be unavailable or full. The UI remains usable
        // in memory, but remember the durable value so a recovered tab cannot
        // overwrite a concurrent write from another tab.
        memoryOnlyKeys.add(key);
        if (hasPersistentBaseline) memoryOnlyBaselines.set(key, persistentBaseline);
        else memoryOnlyBaselines.delete(key);
        return false;
      }
    },
    remove() {
      const memorySnapshot = serializeMemoryValue(key);
      const storage = readStorage();
      let observedValue;
      let canComparePersistentValue = false;
      if (storage) {
        try {
          observedValue = storage.getItem(key);
          canComparePersistentValue = true;
        } catch {
          // Keep the memory snapshot, if any, as a best-effort guard.
          observedValue = memorySnapshot;
        }
      } else {
        observedValue = memorySnapshot;
      }
      memoryValues.delete(key);
      clearMemoryOnlyMarker(key);
      removedKeys.add(key);
      removedKeySnapshots.set(key, observedValue);
      if (!storage) return true;
      try {
        if (!canComparePersistentValue) return false;
        // Do not remove a value that changed after the initial observation.
        // The caller's old value is already hidden by the local tombstone.
        if (storage.getItem(key) !== observedValue) {
          clearRemovalMarker(key);
          return true;
        }
        storage.removeItem(key);
        // Treat a silent no-op as a failed removal. Keep the page-lifetime
        // tombstone so a later retry can remove the same observed value, while
        // a concurrent newer value remains protected by the read check above.
        if (storage.getItem(key) !== null) return false;
        clearRemovalMarker(key);
        return true;
      } catch {
        // Browser storage can be unavailable in a restricted context.
        return false;
      }
    }
  };
}
