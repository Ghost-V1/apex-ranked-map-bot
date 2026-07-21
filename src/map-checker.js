/**
 * Scrapes current Apex Legends map rotation from apexlegendsstatus.com/current-map.
 * No API key required — parses the public page HTML.
 */
const SITE_URL = 'https://apexlegendsstatus.com/current-map';

/**
 * Map display name → internal code mapping for emoji/color lookups.
 */
const NAME_TO_CODE = {
  'Kings Canyon':  'kings_canyon',
  "King's Canyon": 'kings_canyon',
  "World's Edge":  'worlds_edge',
  'Olympus':       'olympus',
  'Storm Point':   'storm_point',
  'Broken Moon':   'broken_moon',
  'E-District':    'e_district',
};

/**
 * Fetch and parse the ranked map rotation from the public website.
 * @returns {Promise<object>} Contains `ranked` key with current/next/upcoming data.
 */
async function fetchMapRotation() {
  const res = await fetch(SITE_URL, {
    headers: {
      'User-Agent': 'ApexRankedMapBot/1.0 (Discord Bot)',
      'Accept': 'text/html',
    },
  });

  if (!res.ok) {
    throw new Error(`Website returned status ${res.status}`);
  }

  const html = await res.text();

  // ── Find the BR Ranked section ──────────────────────────────────
  const rankedMarker = html.indexOf('BR Ranked');
  if (rankedMarker === -1) {
    throw new Error('Could not find ranked section on page');
  }

  const rankedSection = html.slice(rankedMarker);

  // ── Current map ─────────────────────────────────────────────────
  // After "BR Ranked</h2>", there's a <div class="container brranked">
  // containing <h2>MapName</h2> and <h5> with data-tz spans.
  // Narrow extraction to the current map's container (before curmap-next-maps).
  const nextMapsStart = rankedSection.indexOf('curmap-next-maps');
  const currentBlock = nextMapsStart > 0
    ? rankedSection.slice(0, nextMapsStart)
    : rankedSection;

  const currentH2Match = currentBlock.match(/<h2[^>]*>([^<]+)<\/h2>/);
  const currentMap = currentH2Match ? currentH2Match[1].trim() : null;

  // Extract timestamps only from the current map's container
  const tzMatches = currentBlock.match(/data-tz="(\d+)"/g);
  const timestamps = tzMatches
    ? tzMatches.map(m => parseInt(m.match(/\d+/)[0]))
    : [];
  const currentEnd = timestamps.length >= 2 ? timestamps[1] : null;

  // ── Upcoming maps ───────────────────────────────────────────────
  // Isolate the ranked "curmap-next-maps" block (stop before Mixtape/Wildcard heading).
  // Falls back to consuming everything after the start if no boundary is found.
  let nextMapsBlock = rankedSection;
  if (nextMapsStart >= 0) {
    const afterStart = rankedSection.slice(nextMapsStart);
    const nextHeading = afterStart.search(/<(h2|h3)[^>]*>(?:Mixtape|Wildcard|LTM|BR Pubs)/i);
    nextMapsBlock = nextHeading > 0 ? afterStart.slice(0, nextHeading) : afterStart;
  }

  // Match each curmap-next-map div and parse name + timestamps inside
  const NEXT_MAP_RE = /<div class="curmap-next-map"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|$)/gi;
  const blockMatches = [...nextMapsBlock.matchAll(NEXT_MAP_RE)];

  const upcoming = [];
  for (const match of blockMatches) {
    const block = match[1]; // just the inner content
    const nameMatch = block.match(/<h4>([^<]+)<\/h4>/);
    const tzs = block.match(/data-tz="(\d+)"/g);
    if (nameMatch && tzs && tzs.length >= 2) {
      const name = nameMatch[1].trim();
      const start = parseInt(tzs[0].match(/\d+/)[0]);
      const end   = parseInt(tzs[1].match(/\d+/)[0]);
      upcoming.push({
        map: name,
        code: NAME_TO_CODE[name] || null,
        start,
        end,
      });
    }
  }

  const firstNext = upcoming[0] || null;

  return {
    ranked: {
      current: {
        map:  currentMap,
        code: NAME_TO_CODE[currentMap] || null,
        end:  currentEnd,
        readableDate: null,
      },
      next: firstNext ? {
        map:   firstNext.map,
        code:  firstNext.code,
        start: firstNext.start,
        end:   firstNext.end,
      } : { map: null, code: null, start: null, end: null },
      upcoming,
    },
  };
}

/**
 * Get just the current ranked map name and next rotation info.
 * @returns {Promise<object>}
 */
async function getCurrentRankedMap() {
  const data = await fetchMapRotation();
  const ranked = data.ranked;

  return {
    currentMap:       ranked.current?.map ?? null,
    currentCode:      ranked.current?.code ?? null,
    nextMap:          ranked.next?.map ?? null,
    nextCode:         ranked.next?.code ?? null,
    currentEnd:       ranked.current?.end ?? null,
    nextStart:        ranked.next?.start ?? null,
    nextEnd:          ranked.next?.end ?? null,
    currentReadableDate: ranked.current?.readableDate ?? null,
  };
}

module.exports = { fetchMapRotation, getCurrentRankedMap };
