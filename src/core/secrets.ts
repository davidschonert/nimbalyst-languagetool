/**
 * The cloud access token.
 *
 * Nimbalyst keeps extension secrets in `extension-secrets/<key>.enc` under the
 * app's user data, encrypted with Electron `safeStorage` (DPAPI on Windows).
 * The SDK wraps that as `ExtensionStorage.getSecret`, but only hands the
 * storage object to custom editors, panels and settings panels. A contributed
 * Lexical extension receives `ExtensionServices`, which carries no storage at
 * all, so there is no supported way to reach the store from here.
 *
 * This calls the same IPC channel `ExtensionStorage` calls internally. The
 * store, the file and the encryption are identical; what is given up is API
 * stability, not secrecy. The key below mirrors the SDK's own scoping scheme
 * exactly, so if `ExtensionServices` ever gains storage, `getSecret('apiKey')`
 * reads this same value and nothing needs migrating.
 *
 * Everything is funnelled through one module with a null fallback, so a
 * renamed channel degrades to "the cloud backend is unavailable" rather than
 * throwing into the check path.
 *
 * Tracked upstream: nimbalyst/nimbalyst — expose storage on ExtensionServices.
 */

const EXTENSION_ID = 'io.github.davidschonert.languagetool';

/** Mirrors the SDK: `nimbalyst:${extensionId}:${key}`. Do not change casually. */
const SECRET_KEY = `nimbalyst:${EXTENSION_ID}:apiKey`;

interface ElectronBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

let cached: string | undefined;
let loaded = false;
let warned = false;

function bridge(): ElectronBridge | undefined {
  const candidate = (window as unknown as { electronAPI?: ElectronBridge }).electronAPI;
  return typeof candidate?.invoke === 'function' ? candidate : undefined;
}

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[languagetool] ${message}`);
}

/** The stored token, or undefined when none is set or the store is unreachable. */
export async function readApiKey(): Promise<string | undefined> {
  if (loaded) return cached;

  const api = bridge();
  if (!api) {
    warnOnce('No electronAPI bridge, so the cloud backend is unavailable.');
    loaded = true;
    return undefined;
  }

  try {
    const value = await api.invoke('secrets:get', SECRET_KEY);
    cached = typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    warnOnce('Could not read the stored access token, so the cloud backend is unavailable.');
    cached = undefined;
  }

  loaded = true;
  return cached;
}

export async function writeApiKey(value: string): Promise<boolean> {
  const api = bridge();
  if (!api) return false;

  const trimmed = value.trim();
  try {
    if (trimmed) {
      await api.invoke('secrets:set', SECRET_KEY, trimmed);
      cached = trimmed;
    } else {
      await api.invoke('secrets:delete', SECRET_KEY);
      cached = undefined;
    }
    loaded = true;
    return true;
  } catch {
    return false;
  }
}

export async function clearApiKey(): Promise<boolean> {
  return writeApiKey('');
}
