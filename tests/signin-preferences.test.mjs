import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIGNIN_PREFERENCE_KEY, SIGNIN_PREFERENCE_TTL,
  readSigninPreference, rememberSigninWorkspace, workspaceSigninPath,
} from '../src/lib/healthpass-signin.ts';

test('remembered context expires after thirty days even with repeated sign-ins', () => {
  const values = new Map();
  const oldStorage = globalThis.localStorage;
  const originalNow = Date.now;
  let time = originalNow();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  Date.now = () => time;
  try {
    assert.equal(rememberSigninWorkspace('HP-ABC123'), true);
    const first = readSigninPreference();
    assert.equal(first.expiresAt, time + SIGNIN_PREFERENCE_TTL);
    assert.deepEqual(Object.keys(JSON.parse(values.get(SIGNIN_PREFERENCE_KEY))).sort(), ['expiresAt', 'workspaceCode']);
    time += 20 * 86400000;
    rememberSigninWorkspace('HP-ABC123');
    assert.equal(readSigninPreference().expiresAt, first.expiresAt);
    time = first.expiresAt;
    assert.equal(readSigninPreference(), null);
    assert.equal(values.has(SIGNIN_PREFERENCE_KEY), false);
    rememberSigninWorkspace('HP-OTHER');
    assert.equal(readSigninPreference().workspaceCode, 'HP-OTHER');
    rememberSigninWorkspace();
    assert.equal(readSigninPreference(), null);
    values.set(SIGNIN_PREFERENCE_KEY, JSON.stringify({ workspaceCode: 'HP-OTHER', expiresAt: time + 2 * SIGNIN_PREFERENCE_TTL }));
    assert.equal(readSigninPreference(), null);
  } finally {
    Date.now = originalNow;
    if (oldStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = oldStorage;
  }
});

test('storage failure cannot block link-based sign-in and link labels never replace unique identifiers', () => {
  const oldStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => { throw new Error('unavailable'); },
    setItem: () => { throw new Error('unavailable'); },
    removeItem: () => { throw new Error('unavailable'); },
  };
  try {
    assert.equal(readSigninPreference(), null);
    assert.equal(rememberSigninWorkspace('HP-ABC123'), false);
    assert.equal(workspaceSigninPath('GreenSprings Hospital', 'HP-ABC123'), '/w/greensprings-hospital/HP-ABC123');
    assert.notEqual(workspaceSigninPath('Same name', 'HP-A'), workspaceSigninPath('Same name', 'HP-B'));
  } finally {
    if (oldStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = oldStorage;
  }
});
