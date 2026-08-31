import { afterEach, describe, expect, it } from 'vitest';

import { backend, bindConfiguration, checkOptions, KEYS, triggerMode } from './config';

/** Stands in for the host's configuration service. */
function bind(values: Record<string, unknown>): void {
  bindConfiguration({
    get: <T,>(key: string, fallback?: T) => (key in values ? (values[key] as T) : (fallback as T)),
    update: async () => undefined,
    getAll: () => values,
  });
}

afterEach(() => bindConfiguration(undefined));

describe('defaults', () => {
  it('falls back to local and click when nothing is stored', () => {
    bind({});
    expect(backend()).toBe('local');
    expect(triggerMode()).toBe('click');
  });

  it('falls back to local and click when no service is bound at all', () => {
    // Reads happen lazily, so this is the startup window before the host's
    // cache has resolved. It must not throw.
    bindConfiguration(undefined);
    expect(backend()).toBe('local');
    expect(triggerMode()).toBe('click');
    expect(checkOptions().baseUrl).toBe('http://localhost:8081');
  });

  it('treats an unrecognised value as the default rather than passing it through', () => {
    bind({ [KEYS.backend]: 'nonsense', [KEYS.triggerMode]: 'nonsense' });
    expect(backend()).toBe('local');
    expect(triggerMode()).toBe('click');
  });
});

describe('checkOptions', () => {
  it('selects the URL belonging to the active backend', () => {
    bind({
      [KEYS.backend]: 'cloud',
      [KEYS.localUrl]: 'http://localhost:9999',
      [KEYS.cloudUrl]: 'https://cloud.example',
    });
    expect(checkOptions()).toMatchObject({
      backend: 'cloud',
      baseUrl: 'https://cloud.example',
    });
  });

  it('splits comma-separated lists and drops blanks and stray whitespace', () => {
    bind({ [KEYS.disabledRules]: ' DASH_RULE , ,OTHER ' });
    expect(checkOptions().disabledRules).toEqual(['DASH_RULE', 'OTHER']);
  });

  it('omits optional fields that are empty rather than sending them blank', () => {
    bind({ [KEYS.motherTongue]: '   ', [KEYS.username]: '' });
    const options = checkOptions();
    expect(options).not.toHaveProperty('motherTongue');
    expect(options).not.toHaveProperty('username');
  });

  it('never carries an apiKey, which is not stored in configuration', () => {
    bind({ [KEYS.backend]: 'cloud', apiKey: 'leaked' });
    expect(checkOptions()).not.toHaveProperty('apiKey');
  });

  it('falls back to a usable URL when the stored one is blank', () => {
    bind({ [KEYS.localUrl]: '' });
    expect(checkOptions().baseUrl).toBe('http://localhost:8081');
  });
});
