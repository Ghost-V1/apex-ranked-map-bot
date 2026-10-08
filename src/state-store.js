/**
 * Tiny crash/restart-safe store for the last rotation we alerted (or baselined).
 *
 * Without this, every process start begins with lastRotationEnd/lastKnownMapName
 * === null, so the first poll after a restart/deploy/reconnect re-baselines
 * SILENTLY. If a rotation happened while the bot was offline, that alert is lost
 * forever — which is exactly the "the bot never alerted for the latest map
 * change" failure. Persisting the rotation identity lets the first poll after a
 * restart compare against the last rotation we actually reported and alert once
 * if it has advanced.
 *
 * The file lives on the app's disk. On ephemeral hosts (e.g. Render) it survives
 * in-place restarts but not necessarily a fresh deploy; set STATE_FILE to point
 * at a durable path if you have one.
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), '.bot-state.json');

/**
 * @returns {{ lastRotationEnd: number|null, lastKnownMapName: string|null }}
 */
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      lastRotationEnd: Number.isFinite(parsed.lastRotationEnd) ? parsed.lastRotationEnd : null,
      lastKnownMapName: typeof parsed.lastKnownMapName === 'string' && parsed.lastKnownMapName
        ? parsed.lastKnownMapName
        : null,
    };
  } catch {
    // Missing or corrupt file → behave like a first-ever run (silent baseline).
    return { lastRotationEnd: null, lastKnownMapName: null };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({
        lastRotationEnd: Number.isFinite(state.lastRotationEnd) ? state.lastRotationEnd : null,
        lastKnownMapName: state.lastKnownMapName ?? null,
      }),
      'utf8',
    );
  } catch (err) {
    // Persistence is best-effort; never let a disk error stop the bot.
    console.warn('⚠️ Could not persist rotation state:', err.message);
  }
}

module.exports = { loadState, saveState, STATE_FILE };
