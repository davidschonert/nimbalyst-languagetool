/**
 * The settings panel.
 *
 * Owning this is the house pattern in Nimbalyst: of the 26 built-in
 * extensions, the ones with real settings ship their own UI. It also fixes
 * three things the host-rendered fields cannot:
 *
 *   - Text fields keep focus. The host disables each input while it saves,
 *     which blurs it on every keystroke. Here the value is local state and is
 *     committed on blur.
 *   - Changes apply live. Writing through `services.configuration.update()`
 *     refreshes the host's cache, which an edit made in the host UI does not.
 *   - The access token has a real home, instead of a call typed into DevTools.
 *
 * The token does NOT go through `SettingsPanelProps.storage`, even though the
 * panel is handed one. `ExtensionStorage` scopes secrets with colons, which are
 * illegal in Windows filenames, so writing through it fails with ENOENT. See
 * secrets.ts.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SettingsPanelProps } from '@nimbalyst/extension-sdk';

import type { Backend } from '../core/client';
import { CheckError, testConnection } from '../core/client';
import { DEFAULTS, KEYS, readBoolean, readString, writeSetting } from '../core/config';
import { clearApiKey, hasApiKey, readApiKey, writeApiKey } from '../core/secrets';

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok' }
  | { status: 'failed'; message: string };

/**
 * A text field that commits on blur rather than on every keystroke, so typing
 * is never interrupted by a save.
 */
function TextField({
  label,
  hint,
  value,
  onCommit,
  placeholder,
  type = 'text',
}: {
  label: string;
  hint?: string;
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
}) {
  const [draft, setDraft] = useState(value);

  // Follow external changes, but never while the user is mid-edit.
  useEffect(() => setDraft(value), [value]);

  return (
    <label className="lt-field">
      <span className="lt-field__label">{label}</span>
      <input
        className="lt-field__input"
        type={type}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      {hint ? <span className="lt-field__hint">{hint}</span> : null}
    </label>
  );
}

export function LanguageToolSettings(_props: SettingsPanelProps) {
  const [backend, setBackend] = useState<Backend>(DEFAULTS.backend);
  const [localUrl, setLocalUrl] = useState(DEFAULTS.localUrl);
  const [cloudUrl, setCloudUrl] = useState(DEFAULTS.cloudUrl);
  const [username, setUsername] = useState('');
  const [language, setLanguage] = useState(DEFAULTS.language);
  const [motherTongue, setMotherTongue] = useState('');
  const [picky, setPicky] = useState(false);
  const [disabledRules, setDisabledRules] = useState('');
  const [disabledCategories, setDisabledCategories] = useState('');
  const [triggerMode, setTriggerMode] = useState(DEFAULTS.triggerMode);

  const [tokenDraft, setTokenDraft] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });

  useEffect(() => {
    setBackend(readString(KEYS.backend, DEFAULTS.backend) === 'cloud' ? 'cloud' : 'local');
    setLocalUrl(readString(KEYS.localUrl, DEFAULTS.localUrl));
    setCloudUrl(readString(KEYS.cloudUrl, DEFAULTS.cloudUrl));
    setUsername(readString(KEYS.username));
    setLanguage(readString(KEYS.language, DEFAULTS.language));
    setMotherTongue(readString(KEYS.motherTongue));
    setPicky(readBoolean(KEYS.picky));
    setDisabledRules(readString(KEYS.disabledRules));
    setDisabledCategories(readString(KEYS.disabledCategories));
    setTriggerMode(readString(KEYS.triggerMode, DEFAULTS.triggerMode) === 'hover' ? 'hover' : 'click');

    // Only whether one exists. The value is never shown.
    void hasApiKey().then(setHasToken);
  }, []);

  const save = useCallback((key: string, value: unknown) => {
    setTest({ status: 'idle' });
    // The host write crosses IPC and can reject. Discarding that silently makes
    // a failed save look exactly like one that worked.
    void writeSetting(key, value).catch(() => {
      setTest({ status: 'failed', message: 'Could not save that setting.' });
    });
  }, []);

  const saveToken = useCallback(async () => {
    const trimmed = tokenDraft.trim();
    if (!trimmed) return;
    const saved = await writeApiKey(trimmed);
    if (!saved) {
      setTest({ status: 'failed', message: 'Could not save the token. See the console.' });
      return;
    }
    setTokenDraft('');
    setHasToken(true);
    setTest({ status: 'idle' });
  }, [tokenDraft]);

  const clearToken = useCallback(async () => {
    await clearApiKey();
    setHasToken(false);
    setTokenDraft('');
    setTest({ status: 'idle' });
  }, []);

  const runTest = useCallback(async () => {
    setTest({ status: 'testing' });
    try {
      const apiKey = backend === 'cloud' ? await readApiKey() : undefined;
      // Distinguish "nothing to send" from "sent and rejected", which the
      // client cannot: it raises the same auth error for both.
      if (backend === 'cloud' && !apiKey) {
        setTest({ status: 'failed', message: 'Save an access token first.' });
        return;
      }
      if (backend === 'cloud' && !username.trim()) {
        setTest({ status: 'failed', message: 'Add the username for your account first.' });
        return;
      }
      await testConnection({
        backend,
        // From local state, not the configuration service: save() does not await
        // the host's IPC round-trip, so its cache still holds the previous URL
        // when the blur that commits an edit is the same gesture as this click.
        baseUrl:
          (backend === 'cloud' ? cloudUrl : localUrl).trim() ||
          (backend === 'cloud' ? DEFAULTS.cloudUrl : DEFAULTS.localUrl),
        language: language || DEFAULTS.language,
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      setTest({ status: 'ok' });
    } catch (error) {
      const message =
        error instanceof CheckError
          ? error.kind === 'offline'
            ? 'Could not reach the server. Is it running?'
            : error.kind === 'auth'
              ? 'The server rejected the credentials.'
              : error.message
          : String(error);
      setTest({ status: 'failed', message });
    }
  }, [backend, language, username, localUrl, cloudUrl]);

  return (
    <div className="lt-settings">
      <section className="lt-section">
        <h4 className="lt-section__title">Backend</h4>
        <p className="lt-section__note">
          Local keeps document text on this machine and is the default. Cloud sends document text to
          LanguageTool and unlocks the premium-only rules.
        </p>

        <div className="lt-segmented" role="radiogroup" aria-label="Backend">
          {(['local', 'cloud'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={backend === option}
              className="lt-segmented__option"
              data-selected={backend === option}
              onClick={() => {
                setBackend(option);
                save(KEYS.backend, option);
              }}
            >
              {option === 'local' ? 'Local' : 'Cloud'}
            </button>
          ))}
        </div>

        {backend === 'local' ? (
          <TextField
            label="Local server URL"
            value={localUrl}
            placeholder={DEFAULTS.localUrl}
            onCommit={(next) => {
              setLocalUrl(next);
              save(KEYS.localUrl, next);
            }}
          />
        ) : (
          <>
            <TextField
              label="Cloud service URL"
              value={cloudUrl}
              placeholder={DEFAULTS.cloudUrl}
              onCommit={(next) => {
                setCloudUrl(next);
                save(KEYS.cloudUrl, next);
              }}
            />
            <TextField
              label="Username"
              hint="The email address on your LanguageTool account."
              value={username}
              onCommit={(next) => {
                setUsername(next);
                save(KEYS.username, next);
              }}
            />

            <div className="lt-field">
              <span className="lt-field__label">Access token</span>
              <div className="lt-token">
                <input
                  className="lt-field__input"
                  type="password"
                  value={tokenDraft}
                  placeholder={hasToken ? 'A token is saved' : 'Paste your access token'}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setTokenDraft(event.target.value)}
                />
                <button
                  type="button"
                  className="lt-button"
                  disabled={!tokenDraft.trim()}
                  onClick={() => void saveToken()}
                >
                  Save
                </button>
                {hasToken ? (
                  <button type="button" className="lt-button" onClick={() => void clearToken()}>
                    Remove
                  </button>
                ) : null}
              </div>
              <span className="lt-field__hint">
                Stored in Nimbalyst&rsquo;s encrypted secret store, never in settings or in the
                project. It is not shown again once saved.
              </span>
            </div>
          </>
        )}

        <div className="lt-test">
          <button type="button" className="lt-button" onClick={() => void runTest()}>
            {test.status === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          {test.status === 'ok' ? <span className="lt-test__ok">Connected.</span> : null}
          {test.status === 'failed' ? (
            <span className="lt-test__failed">{test.message}</span>
          ) : null}
        </div>
      </section>

      <section className="lt-section">
        <h4 className="lt-section__title">Checking</h4>

        <TextField
          label="Language"
          hint="A code such as en-US or en-GB, or auto to detect per document."
          value={language}
          placeholder={DEFAULTS.language}
          onCommit={(next) => {
            setLanguage(next);
            save(KEYS.language, next);
          }}
        />

        <TextField
          label="Mother tongue"
          hint="Optional, such as de-DE. Enables false-friend checks."
          value={motherTongue}
          onCommit={(next) => {
            setMotherTongue(next);
            save(KEYS.motherTongue, next);
          }}
        />

        <label className="lt-toggle">
          <input
            type="checkbox"
            checked={picky}
            onChange={(event) => {
              setPicky(event.target.checked);
              save(KEYS.picky, event.target.checked);
            }}
          />
          <span>
            <span className="lt-field__label">Picky mode</span>
            <span className="lt-field__hint">
              Additional rules for formal writing. Finds more, including more you will disagree with.
            </span>
          </span>
        </label>
      </section>

      <section className="lt-section">
        <h4 className="lt-section__title">Suppressions</h4>

        <TextField
          label="Disabled rules"
          hint="Comma-separated rule IDs, such as DASH_RULE."
          value={disabledRules}
          onCommit={(next) => {
            setDisabledRules(next);
            save(KEYS.disabledRules, next);
          }}
        />

        <TextField
          label="Disabled categories"
          hint="Comma-separated category IDs, such as PUNCTUATION."
          value={disabledCategories}
          onCommit={(next) => {
            setDisabledCategories(next);
            save(KEYS.disabledCategories, next);
          }}
        />
      </section>

      <section className="lt-section">
        <h4 className="lt-section__title">Corrections</h4>

        <div className="lt-segmented" role="radiogroup" aria-label="How the correction card opens">
          {(['click', 'hover'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={triggerMode === option}
              className="lt-segmented__option"
              data-selected={triggerMode === option}
              onClick={() => {
                setTriggerMode(option);
                save(KEYS.triggerMode, option);
              }}
            >
              {option === 'click' ? 'Open on click' : 'Open on hover'}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
