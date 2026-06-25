/**
 * localStorage shim for Node 26+.
 *
 * Node 26 ships an experimental built-in `localStorage` global that resolves to
 * `undefined` unless the process is started with `--localstorage-file`. It
 * shadows the `localStorage` that jsdom would otherwise expose, so a
 * `@vitest-environment jsdom` test that touches `localStorage` (e.g.
 * `composer-controls.test.tsx`'s `localStorage.clear()` in `beforeEach`) sees
 * `undefined` and throws `Cannot read properties of undefined (reading 'clear')`.
 *
 * This setup runs after the per-file environment is established and installs a
 * minimal in-memory `Storage` only when the ambient `localStorage` is unusable.
 * It is a no-op wherever a working `localStorage` already exists (browsers,
 * older Node, or Node launched with `--localstorage-file`), so it never
 * disturbs node-environment unit tests.
 */

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  } as Storage;
}

function isUsable(candidate: unknown): boolean {
  try {
    return !!candidate && typeof (candidate as Storage).clear === "function";
  } catch {
    return false;
  }
}

let ambient: unknown;
try {
  ambient = (globalThis as { localStorage?: unknown }).localStorage;
} catch {
  ambient = undefined;
}

if (!isUsable(ambient)) {
  const storage = makeMemoryStorage();
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: storage,
    });
  } catch {
    (globalThis as { localStorage?: Storage }).localStorage = storage;
  }
}
