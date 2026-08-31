/**
 * The cloud access token.
 *
 * Nimbalyst keeps extension secrets in `extension-secrets/<key>.enc` under the
 * app's user data, encrypted with Electron `safeStorage` (DPAPI on Windows).
 * This module reaches that store over the same IPC channels the SDK's
 * `ExtensionStorage` uses internally.
 *
 * Two separate reasons it does not use `ExtensionStorage` itself:
 *
 *   1. A contributed Lexical extension receives `ExtensionServices`, which
 *      carries no storage, so the runtime could never read the token at load.
 *      Tracked at https://github.com/nimbalyst/nimbalyst/issues/1407
 *
 *   2. `ExtensionStorage` is unusable for secrets on Windows regardless.
 *      `createExtensionStorage` scopes every secret as
 *      `nimbalyst:${extensionId}:${key}`, the main process sanitises with
 *      `[^a-zA-Z0-9_:-]` which keeps colons, and the result becomes a
 *      filename. NTFS reads `name:stream` as an Alternate Data Stream, so the
 *      write fails with ENOENT and the read finds nothing. Verified: a colon
 *      key fails, the same key with underscores succeeds.
 *
 * The key below is therefore chosen to survive that sanitiser unchanged rather
 * than to match the SDK's scheme, which cannot be produced on Windows anyway.
 * The store, the file location and the encryption are all still the host's.
 */

/** Already sanitiser-safe: only letters, digits and underscores. */
const SECRET_KEY = 'nimbalyst_io_github_davidschonert_languagetool_apiKey';

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
    loaded = true;
  } catch {
    warnOnce('Could not read the stored access token, so the cloud backend is unavailable.');
    cached = undefined;
    // Deliberately not `loaded`. A missing bridge never turns up later, so that
    // path latches; a failed read is transient, and latching it would turn one
    // bad IPC call into "no token" for the rest of the session.
  }

  return cached;
}

/** Whether a token is stored, without handing the value to the caller. */
export async function hasApiKey(): Promise<boolean> {
  return Boolean(await readApiKey());
}

export async function writeApiKey(value: string): Promise<boolean> {
  const api = bridge();
  if (!api) return false;

  const trimmed = value.trim();
  if (!trimmed) return clearApiKey();

  try {
    await api.invoke('secrets:set', SECRET_KEY, trimmed);
    cached = trimmed;
    loaded = true;
    return true;
  } catch (error) {
    console.error('[languagetool] Could not save the access token:', error);
    return false;
  }
}

export async function clearApiKey(): Promise<boolean> {
  const api = bridge();
  if (!api) return false;

  try {
    await api.invoke('secrets:delete', SECRET_KEY);
    cached = undefined;
    loaded = true;
    return true;
  } catch (error) {
    console.error('[languagetool] Could not remove the access token:', error);
    return false;
  }
}
