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

    expect(await addWord('Flosum')).toEqual({ added: true, cloud: 'off' });
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

    expect((await addWord('Flosum')).cloud).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports it cannot run without a username and token', async () => {
    bind({ [KEYS.dictionaryPushToCloud]: true, [KEYS.username]: 'a@b.com' });
    bridgeWithToken(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect((await addWord('Flosum')).cloud).toBe('unavailable');
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
    }));
    vi.stubGlobal('fetch', fetchMock);

    expect((await addWord('Flosum')).cloud).toBe('added');

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

    expect(await addWord('Flosum')).toEqual({ added: true, cloud: 'failed' });
    expect(dictionaryWords()).toEqual(['Flosum']);
  });
});
