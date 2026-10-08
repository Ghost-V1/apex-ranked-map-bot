/**
 * Dependency-free checks for the restart-safe rotation state in
 * src/state-store.js, plus the behavior that matters most: a rotation that
 * happened while the bot was offline must still alert EXACTLY ONCE after a
 * restart, and a restart during the SAME rotation must NOT re-alert.
 *
 * Run with: npm test
 */
process.env.STATE_FILE = require('path').join(
  require('os').tmpdir(),
  `apex-state-test-${process.pid}.json`,
);

const assert = require('assert');
const fs = require('fs');
const { loadState, saveState, STATE_FILE } = require('../src/state-store');
const { rotationState } = require('../src/rotation');

let passed = 0;
function check(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed += 1;
}

// Start clean.
try { fs.unlinkSync(STATE_FILE); } catch {}

// ── Empty / first-ever run ──────────────────────────────────────────
check('no file → first-ever baseline values', loadState(), { lastRotationEnd: null, lastKnownMapName: null });
const firstRun = loadState();
check('first-ever run baselines silently',
  rotationState(firstRun, { end: 100, map: 'Storm Point' }), 'baseline');

// ── Round-trip ──────────────────────────────────────────────────────
saveState({ lastRotationEnd: 100, lastKnownMapName: 'Storm Point' });
check('state round-trips through disk',
  loadState(), { lastRotationEnd: 100, lastKnownMapName: 'Storm Point' });

// ── Restart during the SAME rotation must not re-alert ──────────────
const restartSame = loadState();
check('restart during same rotation → same (no duplicate alert)',
  rotationState(restartSame, { end: 100, map: 'Storm Point' }), 'same');

// ── THE BUG: restart after an offline rotation must alert once ──────
const restartMissed = loadState();
check('restart after an offline rotation → new (alert the missed change)',
  rotationState(restartMissed, { end: 200, map: 'Broken Moon' }), 'new');
// ...and only once: the next poll of that same rotation is 'same'.
check('the missed rotation alerts only once',
  rotationState({ lastRotationEnd: 200, lastKnownMapName: 'Broken Moon' }, { end: 200, map: 'Broken Moon' }), 'same');

// ── Corrupt file degrades to a safe baseline, never a crash ────────
fs.writeFileSync(STATE_FILE, '{ not valid json', 'utf8');
check('corrupt file → safe defaults', loadState(), { lastRotationEnd: null, lastKnownMapName: null });

// ── saveState sanitizes non-finite / blank input ───────────────────
saveState({ lastRotationEnd: NaN, lastKnownMapName: '' });
check('non-finite end and blank name → nulls', loadState(), { lastRotationEnd: null, lastKnownMapName: null });

try { fs.unlinkSync(STATE_FILE); } catch {}

console.log(`✅ restart-safe state: all ${passed} assertions passed`);
