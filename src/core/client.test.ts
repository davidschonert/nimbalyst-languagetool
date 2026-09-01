import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnnotatedDocument } from './annotate';
import { addWordToAccount, check, CheckError, type CheckOptions } from './client';

const doc: AnnotatedDocument = {
  annotation: [{ text: 'The server are running.' }],
  segments: [{ start: 0, length: 23, nodeKey: 'k1', nodeOffset: 0 }],
};

const local: CheckOptions = {
  backend: 'local',
  baseUrl: 'http://localhost:8081',
  language: 'en-US',
};

function respondWith(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  // The parameters are declared so the recorded calls stay typed, which is
  // what lets sentBody read the request body without casting the tuple.
  const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'Error',
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The form body of the most recent request. */
function sentBody(fetchMock: ReturnType<typeof respondWith>): URLSearchParams {
  return fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
}

afterEach(() => vi.unstubAllGlobals());

describe('request assembly', () => {
  it('sends AnnotatedText rather than plain text', async () => {
    const fetchMock = respondWith({ matches: [] });
    await check(doc, local);

    const body = sentBody(fetchMock);
    expect(body.get('text')).toBeNull();
    expect(JSON.parse(body.get('data') ?? '{}')).toEqual({ annotation: doc.annotation });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:8081/v2/check');
  });

  it('omits optional parameters that are not set', async () => {
    const fetchMock = respondWith({ matches: [] });
    await check(doc, local);

    const body = sentBody(fetchMock);
    for (const key of ['level', 'motherTongue', 'disabledRules', 'disabledCategories']) {
      expect(body.get(key)).toBeNull();
    }
  });

  it('sends the parameters that suppress and broaden checking', async () => {
    const fetchMock = respondWith({ matches: [] });
    await check(doc, {
      ...local,
      picky: true,
      disabledRules: ['DASH_RULE', 'OTHER'],
      disabledCategories: ['PUNCTUATION'],
      motherTongue: 'de-DE',
    });

    const body = sentBody(fetchMock);
    expect(body.get('level')).toBe('picky');
    expect(body.get('disabledRules')).toBe('DASH_RULE,OTHER');
    expect(body.get('disabledCategories')).toBe('PUNCTUATION');
    expect(body.get('motherTongue')).toBe('de-DE');
  });

  it('sends preferredVariants only when the language is auto', async () => {
    // The service errors when preferredVariants accompanies an explicit language.
    let fetchMock = respondWith({ matches: [] });
    await check(doc, { ...local, preferredVariants: ['en-US'] });
    expect(sentBody(fetchMock).get('preferredVariants')).toBeNull();

    fetchMock = respondWith({ matches: [] });
    await check(doc, { ...local, language: 'auto', preferredVariants: ['en-US'] });
    expect(sentBody(fetchMock).get('preferredVariants')).toBe('en-US');
  });

  it('never sends credentials on the local backend', async () => {
    const fetchMock = respondWith({ matches: [] });
    await check(doc, { ...local, username: 'a@b.com', apiKey: 'secret' });

    const body = sentBody(fetchMock);
    expect(body.get('username')).toBeNull();
    expect(body.get('apiKey')).toBeNull();
  });

  it('sends both credentials together on the cloud backend', async () => {
    const fetchMock = respondWith({ matches: [] });
    await check(doc, {
      backend: 'cloud',
      baseUrl: 'https://api.languagetoolplus.com',
      language: 'en-US',
      username: 'a@b.com',
      apiKey: 'secret',
    });

    const body = sentBody(fetchMock);
    expect(body.get('username')).toBe('a@b.com');
    expect(body.get('apiKey')).toBe('secret');
  });

  it('refuses the cloud backend without a token, before making a request', async () => {
    // The service rejects one credential without the other, so this never goes out.
    const fetchMock = respondWith({ matches: [] });
    await expect(
      check(doc, { ...local, backend: 'cloud', username: 'a@b.com' }),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call out at all for a document with no prose', async () => {
    const fetchMock = respondWith({ matches: [] });
    const result = await check({ annotation: [{ markup: '{% hint %}' }], segments: [] }, local);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('failure handling', () => {
  it('reports an unreachable server as offline, not as an error to shout about', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    await expect(check(doc, local)).rejects.toMatchObject({ kind: 'offline' });
  });

  it('maps 401 and 403 to auth, and other statuses to http', async () => {
    respondWith('nope', { ok: false, status: 401 });
    await expect(check(doc, local)).rejects.toMatchObject({ kind: 'auth', status: 401 });

    respondWith('boom', { ok: false, status: 500 });
    await expect(check(doc, local)).rejects.toMatchObject({ kind: 'http', status: 500 });
  });

  it('handles a non-JSON error body, which the service really does return', async () => {
    // Sending a username without an apiKey produces a plain-text error.
    respondWith("Error: With 'username' set, you also need to specify 'apiKey'", {
      ok: false,
      status: 400,
    });

    await expect(check(doc, local)).rejects.toBeInstanceOf(CheckError);
  });

  it('reports a success response that is not a check result as malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('not json');
        },
        text: async () => 'not json',
      })),
    );

    await expect(check(doc, local)).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('lets an abort through rather than turning it into a failure', async () => {
    // Superseding a check is normal, not an error state.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );

    await expect(check(doc, local)).rejects.toBeInstanceOf(DOMException);
  });
});

describe('adding a word to the account', () => {
  const account = { baseUrl: 'https://cloud.example/', username: 'a@b.com', apiKey: 'k' };

  it('posts the word and both credentials to the words endpoint', async () => {
    const fetchMock = respondWith({ added: true });

    await expect(addWordToAccount('Flosum', account)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cloud.example/v2/words/add');
    const body = sentBody(fetchMock);
    expect(body.get('word')).toBe('Flosum');
    expect(body.get('username')).toBe('a@b.com');
    expect(body.get('apiKey')).toBe('k');
  });

  it('rejects a 200 that says the word was not added', async () => {
    // The service refuses a word with a 200 and `added: false`. Trusting the
    // status alone tells the user their account has a word it does not have.
    respondWith({ added: false });
    await expect(addWordToAccount('Flosum', account)).rejects.toBeInstanceOf(CheckError);
  });

  it('rejects a 200 whose body says nothing about it', async () => {
    respondWith({});
    await expect(addWordToAccount('Flosum', account)).rejects.toMatchObject({ kind: 'http' });
  });

  it('reports rejected credentials as auth rather than a generic failure', async () => {
    respondWith('nope', { ok: false, status: 403 });
    await expect(addWordToAccount('Flosum', account)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('gives the request a deadline, so an unreachable account cannot hang', async () => {
    const fetchMock = respondWith({ added: true });
    await addWordToAccount('Flosum', account);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
