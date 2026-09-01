import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindConfiguration, KEYS } from './config';
import { addWord, dictionaryWords, isIgnored, removeWord } from './dictionary';
import { invalidateApiKey } from './secrets';

/** A configuration service that actually stores, so writes can be read back. */
function bind(initial: Record<string, unknown> = {}): Record<string, unknown> {
  const values: Record<string, unknown> = { ...initial };
  bindConfiguration({
    get: <T,>(key: string, fallback?: T) => (key in values ? (values[key] as T) : (fallback as T)),
    update: async (key: string, value: unknown) => {
      values[key] = value;
    },
    getAll: () => values,
  });
  return values;
}

/** Stand in for the preload bridge, so a stored token can be read. */
function bridgeWithToken(token: string | undefined): void {
  vi.stubGlobal('window', {
    electronAPI: { invoke: async () => token },
  });
  invalidateApiKey();
}

afterEach(() => {
  bindConfiguration(undefined);
  vi.unstubAllGlobals();
  invalidateApiKey();
});

describe('reading', () => {
  it('is empty when nothing is stored', () => {
    bind();
    expect(dictionaryWords()).toEqual([]);
    expect(isIgnored('Flosum')).toBe(false);
  });

  it('survives a stored value that is not a list of strings', () => {
    // Configuration is a plain JSON bag, so nothing guarantees the shape.
    bind({ [KEYS.dictionary]: ['Flosum', 42, null] });
    expect(dictionaryWords()).toEqual(['Flosum']);
  });
});

describe('adding', () => {
  it('stores the word and starts ignoring it', async () => {
    const values = bind();

    const result = await addWord('Flosum');
    expect(result.added).toBe(true);
    expect(await result.cloud).toBe('off');
    expect(values[KEYS.dictionary]).toEqual(['Flosum']);
    expect(isIgnored('Flosum')).toBe(true);
  });

  it('matches regardless of case, but stores the case the user typed', async () => {
    bind();
    await addWord('Flosum');

    expect(isIgnored('flosum')).toBe(true);
    expect(isIgnored('FLOSUM')).toBe(true);
    expect(dictionaryWords()).toEqual(['Flosum']);
  });

  it('refuses a duplicate, including one differing only by case', async () => {
    bind();
    await addWord('Flosum');

    expect((await addWord('flosum')).added).toBe(false);
    expect(dictionaryWords()).toEqual(['Flosum']);
  });

  it('refuses an empty word', async () => {
    bind();
    expect((await addWord('   ')).added).toBe(false);
    expect(dictionaryWords()).toEqual([]);
  });

  it('trims surrounding whitespace', async () => {
    bind();
    await addWord('  Flosum  ');
    expect(dictionaryWords()).toEqual(['Flosum']);
  });
});

describe('removing', () => {
  it('removes regardless of case', async () => {
    bind({ [KEYS.dictionary]: ['Flosum', 'Salesforce'] });
    await removeWord('FLOSUM');

    expect(dictionaryWords()).toEqual(['Salesforce']);
    expect(isIgnored('Flosum')).toBe(false);
  });

  it('does nothing for a word that is not stored', async () => {
    bind({ [KEYS.dictionary]: ['Flosum'] });
    await removeWord('Nothing');
    expect(dictionaryWords()).toEqual(['Flosum']);
  });
});

describe('what an entry does and does not cover', () => {
  it('does not suppress a longer fragment that merely contains the word', async () => {
    // An entry says "this word is fine". That cannot justify dropping a grammar
    // match spanning several words, one of which happens to be in the list.
    bind();
    await addWord('Flosum');

    expect(isIgnored('Flosum tenant')).toBe(false);
  });
});

describe('turning the list off', () => {
  it('stops applying without losing anything', () => {
    bind({ [KEYS.dictionary]: ['Flosum'], [KEYS.dictionaryEnabled]: false });

    expect(isIgnored('Flosum')).toBe(false);
    expect(dictionaryWords()).toEqual(['Flosum']);
  });

  it('is on when nothing has been chosen', () => {
    bind({ [KEYS.dictionary]: ['Flosum'] });
    expect(isIgnored('Flosum')).toBe(true);
  });

  it('still refuses a duplicate while off, so the list cannot grow copies', async () => {
    bind({ [KEYS.dictionary]: ['Flosum'], [KEYS.dictionaryEnabled]: false });
    expect((await addWord('flosum')).added).toBe(false);
  });
});

describe('the account copy', () => {
  it('is not attempted unless it has been turned on', async () => {
    bind();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await (await addWord('Flosum')).cloud).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports it cannot run without a username and token', async () => {
    bind({ [KEYS.dictionaryPushToCloud]: true, [KEYS.username]: 'a@b.com' });
    bridgeWithToken(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await (await addWord('Flosum')).cloud).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the word with both credentials', async () => {
    bind({
      [KEYS.dictionaryPushToCloud]: true,
      [KEYS.username]: 'a@b.com',
      [KEYS.cloudUrl]: 'https://cloud.example',
    });
    bridgeWithToken('secret-token');
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ added: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await (await addWord('Flosum')).cloud).toBe('added');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://cloud.example/v2/words/add');
    const body = init?.body as URLSearchParams;
    expect(body.get('word')).toBe('Flosum');
    expect(body.get('username')).toBe('a@b.com');
    expect(body.get('apiKey')).toBe('secret-token');
  });

  it('keeps the word locally when the account rejects it', async () => {
    // The local list is what makes the word work, so a failed push upstream
    // must not undo it.
    bind({
      [KEYS.dictionaryPushToCloud]: true,
      [KEYS.username]: 'a@b.com',
    });
    bridgeWithToken('secret-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => 'no' })),
    );

    const result = await addWord('Flosum');
    expect(result.added).toBe(true);
    expect(await result.cloud).toBe('failed');
    expect(dictionaryWords()).toEqual(['Flosum']);
  });

  it('reports failure when the service answers 200 but says it did not add it', async () => {
    // /v2/words/add refuses a word with a 200 and `added: false`, so the status
    // alone would report a word that never reached the account as added.
    bind({ [KEYS.dictionaryPushToCloud]: true, [KEYS.username]: 'a@b.com' });
    bridgeWithToken('secret-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ added: false }),
      })),
    );

    expect(await (await addWord('Flosum')).cloud).toBe('failed');
    expect(dictionaryWords()).toEqual(['Flosum']);
  });

  it('does not make the local add wait for the account round trip', async () => {
    // The word works because it is in the local list. Gating on the network
    // would leave it underlined until an unreachable account timed out.
    const values = bind({ [KEYS.dictionaryPushToCloud]: true, [KEYS.username]: 'a@b.com' });
    bridgeWithToken('secret-token');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await held;
        return { ok: true, status: 200, text: async () => '', json: async () => ({ added: true }) };
      }),
    );

    const result = await addWord('Flosum');
    expect(result.added).toBe(true);
    expect(values[KEYS.dictionary]).toEqual(['Flosum']);
    expect(isIgnored('Flosum')).toBe(true);

    release();
    expect(await result.cloud).toBe('added');
  });
});

describe('two edits at once', () => {
  /** A store that writes asynchronously, which is what makes the race possible. */
  function bindSlow(initial: Record<string, unknown> = {}): Record<string, unknown> {
    const values: Record<string, unknown> = { ...initial };
    bindConfiguration({
      get: <T,>(key: string, fallback?: T) => (key in values ? (values[key] as T) : (fallback as T)),
      update: async (key: string, value: unknown) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        values[key] = value;
      },
      getAll: () => values,
    });
    return values;
  }

  it('keeps both words when two adds are in flight together', async () => {
    bindSlow();
    await Promise.all([addWord('Flosum'), addWord('Nimbalyst')]);
    expect(dictionaryWords()).toEqual(['Flosum', 'Nimbalyst']);
  });

  it('does not resurrect a removed word when an add starts before the write lands', async () => {
    bindSlow({ [KEYS.dictionary]: ['Flosum', 'Salesforce'] });
    await Promise.all([removeWord('Salesforce'), addWord('Nimbalyst')]);
    expect(dictionaryWords()).toEqual(['Flosum', 'Nimbalyst']);
  });

  it('still refuses a duplicate raced against its own first add', async () => {
    bindSlow();
    const [first, second] = await Promise.all([addWord('Flosum'), addWord('flosum')]);
    expect([first.added, second.added].filter(Boolean)).toHaveLength(1);
    expect(dictionaryWords()).toHaveLength(1);
  });
});
