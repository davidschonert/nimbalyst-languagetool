/**
 * The LanguageTool HTTP client.
 *
 * One request shape, two backends. The call runs in the renderer: Nimbalyst
 * sets no CSP, and both servers answer with `Access-Control-Allow-Origin: *`,
 * so a form-encoded POST is a CORS-simple request and needs no preflight. That
 * was verified against a live server rather than assumed.
 *
 * Document text only ever leaves the machine when the cloud backend is
 * explicitly selected. Local is the default.
 */

import type { AnnotatedDocument } from './annotate';

export type Backend = 'local' | 'cloud';

export interface CheckOptions {
  backend: Backend;
  /** Base URL of the selected backend, without a trailing slash. */
  baseUrl: string;
  /** `auto`, or an explicit code such as `en-US`. */
  language: string;
  /** Only valid when `language` is `auto`; the service errors otherwise. */
  preferredVariants?: string[];
  /** Enables additional rules useful for formal text. */
  picky?: boolean;
  disabledRules?: string[];
  disabledCategories?: string[];
  /** Enables false-friend checks. */
  motherTongue?: string;
  /** Cloud only. Sent only when both are present. */
  username?: string;
  apiKey?: string;
}

/** The subset of a `/v2/check` match this extension consumes. */
export interface RawMatch {
  offset: number;
  length: number;
  message: string;
  shortMessage?: string;
  replacements?: Array<{ value: string }>;
  /** Carries the flagged fragment, so reading the editor state is not needed. */
  context?: { text: string; offset: number; length: number };
  rule: {
    id: string;
    issueType?: string;
    category?: { id?: string; name?: string };
  };
}

export type CheckErrorKind =
  /** The server could not be reached. Expected for a local server that is not running. */
  | 'offline'
  /** Credentials missing or rejected. */
  | 'auth'
  /** Too much, too fast. The one failure that says to send less rather than to stop. */
  | 'rate'
  /** The server answered, but not with success. */
  | 'http'
  /** The server answered with something that is not a check result. */
  | 'malformed';

export class CheckError extends Error {
  readonly kind: CheckErrorKind;
  readonly status?: number;
  /** From `Retry-After` on a refusal, when the service sent one. */
  readonly retryAfterMs?: number;

  constructor(kind: CheckErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'CheckError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/**
 * `Retry-After` is either a whole number of seconds or an HTTP date, and the
 * spec allows both on the same header. Anything unparseable is treated as
 * absent rather than as zero, so a malformed header cannot turn a backoff off.
 */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const when = Date.parse(header);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}

const CHECK_PATH = '/v2/check';
const ADD_WORD_PATH = '/v2/words/add';

/**
 * The account copy is a bonus rather than the thing that makes a word work, so
 * it gets a bound rather than the platform's TCP timeout. Nothing waits on it.
 */
const ADD_WORD_TIMEOUT_MS = 10_000;

/**
 * Add a word to the LanguageTool account's own dictionary.
 *
 * This writes to the user's account, so it also changes what the browser
 * extension and any other LanguageTool client report. It is only ever called
 * when the user has turned that on explicitly.
 *
 * The endpoint takes the same credentials as a check and rejects a username
 * without an apiKey the same way, with a plain-text body.
 *
 * A 200 is not the answer. The service reports a refused word — one already in
 * the account, or one it will not accept — as `{"added": false}` with a 200, so
 * the body is what decides, and anything but `true` throws.
 */
export async function addWordToAccount(
  word: string,
  options: { baseUrl: string; username: string; apiKey: string },
): Promise<void> {
  const body = new URLSearchParams();
  body.set('word', word);
  body.set('username', options.username);
  body.set('apiKey', options.apiKey);

  const url = options.baseUrl.replace(/\/+$/, '') + ADD_WORD_PATH;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(ADD_WORD_TIMEOUT_MS),
    });
  } catch {
    throw new CheckError('offline', `Could not reach LanguageTool at ${url}.`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const kind: CheckErrorKind =
      response.status === 401 || response.status === 403 ? 'auth' : 'http';
    throw new CheckError(kind, detail.slice(0, 200) || response.statusText, response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CheckError('malformed', 'LanguageTool returned a response that was not JSON.');
  }

  if ((payload as { added?: unknown }).added !== true) {
    throw new CheckError('http', 'LanguageTool did not add the word.', response.status);
  }
}

function buildBody(doc: AnnotatedDocument, options: CheckOptions): URLSearchParams {
  const body = new URLSearchParams();

  // AnnotatedText, not plain text: the markup runs keep their length in the
  // offset space so returned offsets still index the original document.
  body.set('data', JSON.stringify({ annotation: doc.annotation }));
  body.set('language', options.language);

  if (options.language === 'auto' && options.preferredVariants?.length) {
    body.set('preferredVariants', options.preferredVariants.join(','));
  }
  if (options.picky) body.set('level', 'picky');
  if (options.motherTongue) body.set('motherTongue', options.motherTongue);
  if (options.disabledRules?.length) {
    body.set('disabledRules', options.disabledRules.join(','));
  }
  if (options.disabledCategories?.length) {
    body.set('disabledCategories', options.disabledCategories.join(','));
  }

  // Both or neither. Sending one alone makes the service reject the request.
  const username = options.username?.trim();
  const apiKey = options.apiKey?.trim();
  if (options.backend === 'cloud' && username && apiKey) {
    body.set('username', username);
    body.set('apiKey', apiKey);
  }

  return body;
}

/**
 * Send one short sentence to confirm the backend answers and, for cloud, that
 * the credentials are accepted. Throws the same CheckError as a real check, so
 * the caller can tell "not running" from "bad token".
 */
export async function testConnection(options: CheckOptions): Promise<void> {
  const probe: AnnotatedDocument = {
    annotation: [{ text: 'This is a test.' }],
    segments: [{ start: 0, length: 15, nodeKey: 'probe', nodeOffset: 0 }],
  };
  await check(probe, options);
}

export async function check(
  doc: AnnotatedDocument,
  options: CheckOptions,
  signal?: AbortSignal,
): Promise<RawMatch[]> {
  if (doc.segments.length === 0) return [];

  if (options.backend === 'cloud' && !(options.username && options.apiKey)) {
    throw new CheckError('auth', 'The cloud backend needs both a username and an access token.');
  }

  const url = options.baseUrl.replace(/\/+$/, '') + CHECK_PATH;

  let response: Response;
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildBody(doc, options),
    };
    if (signal) init.signal = signal;
    response = await fetch(url, init);
  } catch (cause) {
    // An aborted request is a normal part of superseding a check, not a failure.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new CheckError('offline', `Could not reach LanguageTool at ${url}.`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const kind: CheckErrorKind =
      response.status === 401 || response.status === 403
        ? 'auth'
        : response.status === 429
          ? 'rate'
          : 'http';
    throw new CheckError(
      kind,
      detail.slice(0, 200) || response.statusText,
      response.status,
      retryAfterMs(response.headers.get('Retry-After')),
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CheckError('malformed', 'LanguageTool returned a response that was not JSON.');
  }

  const matches = (payload as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) {
    throw new CheckError('malformed', 'LanguageTool returned no matches array.');
  }

  return matches as RawMatch[];
}
