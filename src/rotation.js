/**
 * Pure helpers for deciding whether a scraped ranked-map observation is a NEW
 * rotation. Kept separate from the Discord wiring so the alert-dedupe logic can
 * be unit tested without booting the bot.
 */

/**
 * Collapse whitespace so cosmetic markup jitter can't look like a new map.
 * @param {string|null} name
 * @returns {string|null}
 */
function normalizeMapName(name) {
  if (!name) return null;
  return name.replace(/\s+/g, ' ').trim() || null;
}

/**
 * Classify the current observation against the previously-alerted rotation.
 *
 * The map's scheduled END timestamp identifies a rotation: it is stable for the
 * whole rotation and strictly increases across rotations. We only treat an
 * observation as `new` when that timestamp advances, which makes repeats
 * impossible even if the displayed name jitters or the site serves a cached
 * page. When timestamps are unavailable we fall back to comparing names.
 *
 * @param {{ lastRotationEnd: number|null, lastKnownMapName: string|null }} prev
 * @param {{ end: number|null, map: string|null }} curr
 * @returns {'baseline'|'new'|'same'|'stale'}
 */
function rotationState(prev, curr) {
  if (prev.lastRotationEnd === null && prev.lastKnownMapName === null) {
    return 'baseline';
  }
  if (prev.lastRotationEnd !== null && curr.end !== null) {
    if (curr.end > prev.lastRotationEnd) return 'new';
    if (curr.end < prev.lastRotationEnd) return 'stale';
    return 'same';
  }
  return curr.map !== prev.lastKnownMapName ? 'new' : 'same';
}

module.exports = { normalizeMapName, rotationState };
