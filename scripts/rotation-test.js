/**
 * Dependency-free checks for the alert-dedupe logic in src/rotation.js.
 * Run with: npm test
 */
const assert = require('assert');
const { rotationState, normalizeMapName } = require('../src/rotation');

let passed = 0;
function check(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: expected ${expected}, got ${actual}`);
  passed += 1;
}

// ── normalizeMapName ────────────────────────────────────────────────
check('trim + collapse whitespace', normalizeMapName('  World\u00a0Edge  '), 'World Edge');
check('blank becomes null', normalizeMapName('   '), null);
check('null stays null', normalizeMapName(null), null);

// ── rotationState ───────────────────────────────────────────────────
const NONE = { lastRotationEnd: null, lastKnownMapName: null };

check('first ever observation is baseline',
  rotationState(NONE, { end: 100, map: 'A' }), 'baseline');

// THE BUG: repeated polls of the same rotation must never look new again.
check('same rotation on the next poll',
  rotationState({ lastRotationEnd: 100, lastKnownMapName: 'A' }, { end: 100, map: 'A' }), 'same');
check('same rotation with markup jitter in name',
  rotationState({ lastRotationEnd: 100, lastKnownMapName: 'A' }, { end: 100, map: 'A ' }), 'same');
check('same rotation even if name spelling drifts',
  rotationState({ lastRotationEnd: 200, lastKnownMapName: 'Worlds Edge' }, { end: 200, map: "World's Edge" }), 'same');

check('advanced end is a new rotation',
  rotationState({ lastRotationEnd: 100, lastKnownMapName: 'A' }, { end: 200, map: 'B' }), 'new');

// A cached page serving the PREVIOUS rotation must not re-alert.
check('older end is stale, not new',
  rotationState({ lastRotationEnd: 200, lastKnownMapName: 'B' }, { end: 100, map: 'A' }), 'stale');

// Fallback path when the site omits timestamps.
check('fallback: name change is new',
  rotationState({ lastRotationEnd: null, lastKnownMapName: 'A' }, { end: null, map: 'B' }), 'new');
check('fallback: same name is same',
  rotationState({ lastRotationEnd: null, lastKnownMapName: 'A' }, { end: null, map: 'A' }), 'same');

// ── Simulation: one alert per rotation across a realistic poll stream ──
// 12 polls of rotation A, then rotation B arrives, then a stale cached A shows
// up, then more B polls. Expect exactly 2 alerts (A baseline is silent).
const stream = [
  { end: 100, map: 'Storm Point' }, // baseline
  { end: 100, map: 'Storm Point' },
  { end: 100, map: 'Storm Point' },
  { end: 100, map: 'Storm Point' },
  { end: 200, map: 'Broken Moon' }, // rotation → exactly 1 alert
  { end: 100, map: 'Storm Point' }, // stale cached page → ignored
  { end: 200, map: 'Broken Moon' }, // still the same rotation
  { end: 200, map: 'Broken Moon' },
  { end: 300, map: 'World\u2019s Edge' }, // next rotation → 1 alert
  { end: 300, map: 'World\u2019s Edge' },
  { end: 300, map: 'World\u2019s Edge' },
];

let alerts = 0;
let state = { lastRotationEnd: null, lastKnownMapName: null };
for (const obs of stream) {
  const s = rotationState(state, obs);
  if (s === 'new') alerts += 1;
  if (s === 'new' || s === 'baseline') {
    state = { lastRotationEnd: obs.end, lastKnownMapName: obs.map };
  }
}
check('simulation yields exactly one alert per rotation', alerts, 2);

console.log(`✅ rotation dedupe: all ${passed} assertions passed`);
