import { afterEach, describe, expect, it } from 'vitest';

import { bindConfiguration, KEYS } from './config';
import { addWord, dictionaryWords, isIgnored, removeWord } from './dictionary';

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

afterEach(() => bindConfiguration(undefined));

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

    expect(await addWord('Flosum')).toBe(true);
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

    expect(await addWord('flosum')).toBe(false);
    expect(dictionaryWords()).toEqual(['Flosum']);
  });

  it('refuses an empty word', async () => {
    bind();
    expect(await addWord('   ')).toBe(false);
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
