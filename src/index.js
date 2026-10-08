const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { getCurrentRankedMap, fetchMapRotation } = require('./map-checker');
const { normalizeMapName, rotationState } = require('./rotation');
const http = require('http');
require('dotenv').config();
const { loadState, saveState } = require('./state-store');

// ── Config ───────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const REQUIRED_ENV = ['DISCORD_TOKEN', 'CLIENT_ID', 'CHANNEL_ID'];

// ── Validation ───────────────────────────────────────────────────────
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing environment variable: ${key}`);
    console.error('   Copy .env.example to .env and fill in your values.');
    process.exit(1);
  }
}

// ── Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ── Discord Connection Visibility ────────────────────────────────────
// Without these handlers, login/connection failures are silent: the health
// server keeps running so Render reports "live", but the bot never connects.
client.on('error', (err) => console.error('⚠️ Discord client error:', err.message));
client.on('shardError', (err) => console.error('⚠️ Discord shard error:', err.message));
client.on('disconnect', () => console.warn('🔌 Discord gateway disconnected'));
client.on('reconnecting', () => console.warn('🔄 Discord gateway reconnecting...'));
client.on('resume', () => {
  // Session resumed cleanly (or we freshly connected) — make sure polling is
  // running so map-change alerts fire. Guards the case where the gateway
  // dropped without firing 'clientReady' again. Idempotent and safe.
  ensurePolling();
  console.warn('🔌 Discord gateway session resumed — polling resumed');
});

// The last rotation we reported survives process restarts via a small file, so
// a rotation that happened while the bot was offline still alerts once on the
// next successful poll instead of being silently re-baselined. See state-store.js.
const persistedState = loadState();
let lastKnownMapCode = null; // tracks the previously-seen ranked map code
let lastKnownMapName = persistedState.lastKnownMapName; // tracks the previously-seen ranked map display name
let lastRotationEnd = persistedState.lastRotationEnd;   // scheduled end timestamp of the last alerted rotation (rotation identity)
let checkInFlight = false;   // re-entrancy guard so two polls can't race and double-send
let lastLoginError = null;   // last Discord login error message, surfaced via health endpoint
let pollTimer = null;
let loginWatchdog = null;    // per-attempt timeout: tears down a hanging login and retries
let retryTimer = null;       // scheduled next attempt (cleared on success to avoid stale retries)
let loginAttempt = 0;        // consecutive login retry counter (surfaced via health endpoint)
let loginAttempts = [];      // timestamps of recent login attempts — rolling connection budget
let readySinceTimer = null;  // clears the backoff counters only after a STABLE connection
let lastEgressCheck = null;  // cached Discord API reachability probe result
const processStart = Date.now();

// ── Map Emoji & Color Helpers ────────────────────────────────────────
const MAP_EMOJI = {
  kings_canyon:      '🏜️',
  worlds_edge:       '❄️',
  olympus:           '☁️',
  storm_point:       '🌴',
  broken_moon:       '🌑',
  e_district:        '🌃',
};

const MAP_COLOR = {
  kings_canyon:      0xe67e22,
  worlds_edge:       0x3498db,
  olympus:           0x9b59b6,
  storm_point:       0x2ecc71,
  broken_moon:       0x95a5a6,
  e_district:        0xe91e63,
};

function mapEmoji(code) {
  return MAP_EMOJI[code] || '🗺️';
}

function mapColor(code) {
  return MAP_COLOR[code] || 0xff4500;
}

function formatTime(ts) {
  if (!ts) return 'N/A';
  return `<t:${ts}:t>`; // Discord timestamp formatting — shows local time
}

function formatCountdown(ts) {
  if (!ts) return '';
  return `<t:${ts}:R>`; // relative time like "in 30 minutes"
}

// ── Poll & Alert ─────────────────────────────────────────────────────
// A rotation is identified by its scheduled END timestamp (falling back to the
// display name when the site omits it). The end timestamp is stable for the
// entire rotation, so cosmetic page jitter can't look like a new map.
//
// The rotation is committed to state BEFORE the message is sent, because
// channel.send() is NOT idempotent: on a flaky connection Discord can post the
// message while our request throws (Render's shared free-tier IP is routinely
// rate-limited, HTTP 429). Recording state only after a successful send meant
// such a failure re-fired the SAME alert on the next poll — every poll, hence
// multiple alerts per rotation.
async function checkAndAlert() {
  if (checkInFlight) {
    console.warn('⏭️ Skipping poll — previous check is still running.');
    return;
  }
  checkInFlight = true;

  try {
    const channel = client.channels.cache.get(process.env.CHANNEL_ID);
    if (!channel) {
      console.error('❌ Could not find the alert channel. Check CHANNEL_ID.');
      return;
    }

    const {
      currentMap: rawMap, currentCode, nextMap, nextCode, currentEnd,
    } = await getCurrentRankedMap();

    // Normalize whitespace so cosmetic markup changes can't look like a new map.
    const currentMap = normalizeMapName(rawMap);
    if (!currentMap) return; // nothing to report

    const end = Number.isFinite(currentEnd) ? currentEnd : null;
    const state = rotationState(
      { lastRotationEnd, lastKnownMapName },
      { end, map: currentMap },
    );

    // First successful observation in this process — baseline, don't alert.
    if (state === 'baseline') {
      lastRotationEnd = end;
      lastKnownMapCode = currentCode;
      lastKnownMapName = currentMap;
      saveState({ lastRotationEnd, lastKnownMapName });
      console.log(`📍 Initial map: ${currentMap} (${currentCode})`);
      return;
    }

    if (state === 'stale') {
      // An older rotation than the one we already reported — almost certainly a
      // cached/stale page. Never alert on it, and never overwrite our state.
      console.warn(`⏭️ Ignoring stale rotation (end ${end} ≤ ${lastRotationEnd}) — likely a cached page.`);
      return;
    }

    if (state === 'same') {
      // Same rotation — never alert. In timestamp mode leave the recorded name
      // alone so the next alert's "Previous" reflects the map you actually saw,
      // not a mid-rotation relabel. In fallback (name) mode keep it in sync so a
      // cosmetic spelling change can't re-trigger.
      if (end === null || lastRotationEnd === null) {
        lastKnownMapName = currentMap;
        lastKnownMapCode = currentCode;
        saveState({ lastRotationEnd, lastKnownMapName });
      }
      return;
    }

    // A genuinely new rotation — alert EXACTLY once. Commit the new rotation to
    // state before sending so a failed/ambiguous send can't repeat next poll.
    const previousName = lastKnownMapName;
    lastRotationEnd = end !== null ? end : lastRotationEnd;
    lastKnownMapCode = currentCode;
    lastKnownMapName = currentMap;
    // Persist BEFORE sending (same reasoning as the in-memory commit) so a crash
    // mid-send can't replay this rotation on the next start.
    saveState({ lastRotationEnd, lastKnownMapName });

    const embed = new EmbedBuilder()
      .setTitle(`${mapEmoji(currentCode)} Ranked Map Changed!`)
      .setDescription(
        `The ranked map has rotated!\n\n` +
        `**Previous:** ~~${previousName}~~\n` +
        `**Current:** **${currentMap}** ${mapEmoji(currentCode)}\n` +
        `**Next up:** ${nextMap || 'Unknown'} ${mapEmoji(nextCode)}\n\n` +
        `Current map ends ${formatCountdown(currentEnd)}`
      )
      .setColor(mapColor(currentCode))
      .setTimestamp();

    try {
      await channel.send({ embeds: [embed] });
      console.log(`🔄 Map changed: ${previousName} → ${currentMap} (rotation ends ${end ?? 'n/a'})`);
    } catch (err) {
      // State is already committed — deliberately do NOT re-alert. The message
      // may even have been delivered; Discord's send is not idempotent, so a
      // retry risks the exact duplicate we're eliminating.
      console.error(`⚠️ Alert send failed for rotation ending ${end ?? 'n/a'}: ${err.message}`);
    }
  } catch (err) {
    console.error('⚠️ Polling error:', err.message);
  } finally {
    checkInFlight = false;
  }
}

// ── Slash Commands ───────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'map') {
    await interaction.deferReply();

    try {
      const data = await fetchMapRotation();
      const ranked = data.ranked;
      const current = ranked?.current;
      const next = ranked?.next;

      if (!current?.map) {
        return interaction.editReply('❌ Could not find ranked map data right now.');
      }

      const embed = new EmbedBuilder()
        .setTitle(`${mapEmoji(current.code)} Current Ranked Map`)
        .setColor(mapColor(current.code))
        .addFields(
          { name: '🗺️ Map', value: `**${current.map}**`, inline: true },
          { name: '⏱️ Ends', value: formatCountdown(current.end), inline: true },
          { name: '\u200B', value: '\u200B', inline: true },
          { name: '⏭️ Next Map', value: next?.map || 'Unknown', inline: true },
          { name: '🕐 Starts', value: formatCountdown(next?.start), inline: true },
          { name: '\u200B', value: '\u200B', inline: true },
        )
        .setFooter({ text: 'Data from apexlegendsstatus.com' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('map command error:', err.message);
      await interaction.editReply('❌ Failed to fetch map data. Please try again later.');
    }
  }

  if (interaction.commandName === 'nextmap') {
    await interaction.deferReply();

    try {
      const { nextMap, nextCode, nextStart } =
        await getCurrentRankedMap();

      if (!nextMap) {
        return interaction.editReply('❌ Could not determine the next map right now.');
      }

      const embed = new EmbedBuilder()
        .setTitle(`${mapEmoji(nextCode)} Upcoming Ranked Map`)
        .setDescription(
          `The next ranked map will be **${nextMap}** ${mapEmoji(nextCode)}\n` +
          `Starts ${formatCountdown(nextStart)} (${formatTime(nextStart)})`
        )
        .setColor(mapColor(nextCode))
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('nextmap command error:', err.message);
      await interaction.editReply('❌ Failed to fetch data. Please try again later.');
    }
  }
});

// ── Lifecycle ────────────────────────────────────────────────────────
// Start the polling loop that watches for map rotations and alerts the channel.
// Idempotent — safe to call after a reconnect or session resume.
function ensurePolling() {
  if (pollTimer) return; // already running
  pollTimer = setInterval(checkAndAlert, POLL_INTERVAL_MS);
  // Immediate first check so an already-rotated map is caught right away.
  checkAndAlert();
  console.log(`⏱️  Polling every ${POLL_INTERVAL_MS / 60_000} minutes`);
}

// .on() (not .once()) so a re-login after a connection failure still re-runs setup.
client.on('clientReady', () => {
  if (loginWatchdog) {
    clearTimeout(loginWatchdog);
    loginWatchdog = null;
  }
  // Do NOT reset the backoff the instant we connect. A flapping link would
  // reset it on every brief connect and then retry at the minimum delay each
  // time — exactly how a reconnect storm builds up (Discord resets a bot's
  // token at >1000 connections in a short window). Only a connection that
  // holds for STABLE_RESET_MS counts as healthy and clears the counters.
  if (readySinceTimer) clearTimeout(readySinceTimer);
  readySinceTimer = setTimeout(() => {
    readySinceTimer = null;
    if (!client.isReady()) return;
    if (loginAttempt !== 0) console.log('✅ Connection stable — resetting login backoff.');
    loginAttempt = 0;
    loginAttempts = [];
  }, STABLE_RESET_MS);

  if (client.isReady() && !pollTimer) {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`📍 Alert channel: ${process.env.CHANNEL_ID}`);
    ensurePolling();
  } else if (pollTimer) {
    // Already set up from a previous successful login — this is a reconnect.
    console.log(`✅ Reconnected as ${client.user.tag}`);
  }
});

// ── Discord Reachability Probe ───────────────────────────────────────
// Pings Discord's REST API with the bot token so we can distinguish:
//   200  → Discord reachable AND token valid
//   401  → token invalid/revoked (fix in Render env)
//   429  → Discord rate-limiting this IP (back off and wait)
//   error → network-level unreachability
// Returns true if a probe actually ran, false if skipped inside a 429 backoff
// window (so the caller doesn't log stale state as if it were fresh).
async function probeDiscordEgress() {
  // Respect a 429 Retry-After window instead of hammering Discord's API —
  // continued requests can extend the rate limit and starve the real sends.
  if (lastEgressCheck?.retryAt && Date.now() < lastEgressCheck.retryAt) return false;
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ApexRankedMapBot/1.0',
        'Authorization': `Bot ${process.env.DISCORD_TOKEN}`,
      },
    });
    if (res.status === 200) {
      lastEgressCheck = { at: Date.now(), ok: true, ms: Date.now() - t0, error: null };
    } else if (res.status === 401) {
      lastEgressCheck = { at: Date.now(), ok: false, ms: Date.now() - t0, error: 'HTTP 401 — token invalid or revoked!' };
    } else if (res.status === 429) {
      const retryAfterRaw = res.headers.get('retry-after');
      const retryAfter = retryAfterRaw && Number.isFinite(parseFloat(retryAfterRaw))
        ? Math.ceil(parseFloat(retryAfterRaw))
        : null;
      lastEgressCheck = {
        at: Date.now(), ok: false, ms: Date.now() - t0,
        retryAt: retryAfter ? Date.now() + retryAfter * 1000 : null,
        error: `HTTP 429 — Discord rate-limiting this IP${retryAfter ? ` (retry in ${retryAfter}s)` : ''}`,
      };
    } else {
      lastEgressCheck = { at: Date.now(), ok: false, ms: Date.now() - t0, error: `HTTP ${res.status}` };
    }
  } catch (err) {
    lastEgressCheck = { at: Date.now(), ok: false, ms: Date.now() - t0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
  return true;
}

// Log reachability every minute so Render's Logs tab shows whether the instance
// can reach Discord over time.
setInterval(async () => {
  const ran = await probeDiscordEgress();
  if (!ran) return; // inside a 429 backoff window — stay quiet, don't probe
  if (lastEgressCheck?.ok) {
    console.log(`🌐 Discord API reachable (${lastEgressCheck.ms}ms)`);
  } else if (lastEgressCheck?.error?.includes('429')) {
    console.error('🌐 Discord API RATE-LIMITED (429) — will not probe again until Retry-After elapses');
  } else {
    console.error(`🌐 Discord API UNREACHABLE: ${lastEgressCheck?.error}`);
  }
}, 60_000);

// ── Free-Tier Keep-Alive ────────────────────────────────────────────
// Render free web services spin down after ~15 min with no INBOUND traffic.
// The bot's Discord connection is outbound (doesn't count) and self-pings don't
// reliably count either — the guaranteed fix is an EXTERNAL uptime monitor
// (e.g. UptimeRobot) hitting the health URL every ~5 min. This self-ping is a
// best-effort supplement that keeps the instance awake where self-requests do
// register. RENDER_EXTERNAL_URL is provided automatically by Render.
const KEEPALIVE_URL = process.env.RENDER_EXTERNAL_URL || null;
const KEEPALIVE_INTERVAL_MS = 5 * 60_000;

async function keepAlivePing() {
  if (!KEEPALIVE_URL) return;
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(KEEPALIVE_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ApexRankedMapBot/1.0 (keep-alive)' },
    });
    console.log(`🔄 Keep-alive ping: ${res.status} (${Date.now() - t0}ms)`);
  } catch (err) {
    console.warn(`🔄 Keep-alive ping failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

if (KEEPALIVE_URL) {
  console.log(`🔄 Keep-alive enabled — self-pinging ${KEEPALIVE_URL} every 5 min`);
  setInterval(keepAlivePing, KEEPALIVE_INTERVAL_MS);
} else {
  console.warn('⚠️ RENDER_EXTERNAL_URL not set — free-tier instance may spin down.');
  console.warn('   Set up an external uptime monitor (UptimeRobot) on the bot URL');
  console.warn('   to ping it every ~5 min and prevent spin-down.');
}

// ── HTTP Server (for Render health checks & UptimeRobot keep-alive) ──
// Try PORT env var first, fall back to a random available port if needed
const PORT = process.env.PORT || 0;
const server = http.createServer((req, res) => {
  // Refresh the cached reachability probe if it's more than 30s old.
  if (!lastEgressCheck || Date.now() - lastEgressCheck.at > 30_000) {
    probeDiscordEgress();
  }
  const ready = client.isReady();
  const body =
    `🟢 Apex Ranked Map Bot — Online\n` +
    `Discord connected: ${ready ? 'YES ✅' : 'NO ❌'}\n` +
    `Current map: ${lastKnownMapName || 'loading...'}\n` +
    (lastLoginError ? `Last login error: ${lastLoginError}\n` : '') +
    `Discord API reachable: ${lastEgressCheck
      ? (lastEgressCheck.ok ? `YES ✅ (${lastEgressCheck.ms}ms)` : `NO ❌ (${lastEgressCheck.error})`)
      : 'checking...'}\n` +
    `Uptime: ${Math.floor((Date.now() - processStart) / 1000)}s\n` +
    `Login attempts: ${loginAttempt}` +
    ` (last hour: ${loginAttempts.filter((t) => t >= Date.now() - ATTEMPT_WINDOW_MS).length}/${MAX_ATTEMPTS_PER_WINDOW})\n`;
  // Always answer 200 while the process is alive — the body reports the truth.
  // (Returning 503 made Render mark deploys failed and show "Instance failed"
  // events even though the process was simply waiting to connect.)
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(body);
});
server.on('error', (err) => {
  console.error('🌐 Health server error:', err.message);
});
server.listen(PORT, () => {
  console.log(`🌐 Health server listening on port ${PORT}`);
});

// ── Graceful Shutdown ────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  if (pollTimer) clearInterval(pollTimer);
  server.close();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (pollTimer) clearInterval(pollTimer);
  server.close();
  client.destroy();
  process.exit(0);
});

// ── Start ────────────────────────────────────────────────────────────
const LOGIN_TIMEOUT_MS = 45_000; // how long to wait for one login attempt
const RETRY_MIN_MS     = 60_000; // first retry delay (1 min — deliberately gentle)
const RETRY_MAX_MS     = 30 * 60_000; // backoff cap: never retry faster than every 30 min
const RECONNECT_WATCH_MS = 60_000; // how often we verify the gateway is still up
const STABLE_RESET_MS  = 5 * 60_000; // connection must hold this long before backoff resets
// Hard ceiling on gateway connections per rolling hour. Discord resets a bot's
// token when it sees excessive connections (>1000 in a short period). This
// budget makes that structurally impossible, whatever bug or flapping link
// triggered the retry loop in the first place.
const ATTEMPT_WINDOW_MS = 60 * 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 20;
// A rejected token can never be fixed by retrying — recognise it so we back off
// at the maximum instead of hammering Discord with invalid logins.
const INVALID_TOKEN_RE = /TokenInvalid|invalid token|401|unauthori[sz]ed/i;

// Exponential backoff: 60s, 2m, 4m, 8m, 16m, 32m→capped at 30 min.
// Rapid retries trigger Discord's rate limiter (HTTP 429) and, at the extreme, a
// token reset; backing off lets the limit expire and still self-heals the moment
// Discord responds again.
function nextRetryDelay(attempt) {
  return Math.min(RETRY_MIN_MS * 2 ** Math.min(attempt - 1, 5), RETRY_MAX_MS);
}

// ── Liveness Supervisor ─────────────────────────────────────────────
// The retry loop normally keeps the bot trying until it connects, and keeps it
// alive across gateway drops. But a single unexpected path — a hung login whose
// promise resolves instead of rejecting, an unexpected throw, etc. — can leave
// the bot with NOTHING scheduled: Render reports "live" (HTTP 200) while Discord
// shows the bot offline and rotation alerts silently stop (observed: one login
// attempt, then no retries for hours). This supervisor runs every minute and,
// ONLY when the client is not ready AND nothing is in flight AND no retry is
// scheduled, schedules a normal backoff retry. Because every failure path
// schedules a 60s–30min backoff retry and the connection budget caps attempts
// per hour, the supervisor stays quiet during a normal outage or rate-limit
// window and only steps in when the chain has genuinely broken — so it can
// never hammer Discord.
//
// It deliberately preserves lastRotationEnd/lastKnownMapName so a rotation that
// happened while we were down still alerts on the next poll.
let supervisor = null;

function startSupervisor() {
  if (supervisor) return;
  supervisor = setInterval(() => {
    if (client.isReady()) return; // all good
    if (loginWatchdog) return;    // a login attempt is in flight
    if (retryTimer) return;       // an attempt is already scheduled
    // Nothing in flight and nothing scheduled — the retry chain genuinely broke.
    // Schedule a NORMAL backoff retry (which honours the connection budget and
    // the exponential delay) instead of force-destroying the client and logging
    // straight back in. The old eager reconnect was itself a connection-storm
    // source: it bypassed the backoff and could run every 60s indefinitely.
    console.warn('🩺 Supervisor: disconnected with no attempt scheduled — scheduling a retry.');
    scheduleRetry(loginAttempt);
  }, RECONNECT_WATCH_MS);
}

startSupervisor();

// Schedule the next login attempt with exponential backoff. Never stacks two
// retries, so the supervisor can rely on `retryTimer` meaning "one is pending".
// `delayOverrideMs` lets a caller (e.g. the connection budget, or an invalid
// token) wait longer than the computed backoff.
function scheduleRetry(attempt, delayOverrideMs) {
  if (retryTimer) return;
  const delay = Number.isFinite(delayOverrideMs) ? delayOverrideMs : nextRetryDelay(attempt);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    attemptLogin().catch((err) => {
      console.error('❌ Scheduled retry threw:', err.message);
      scheduleRetry(attempt);
    });
  }, delay);
}

// Retry login in-process instead of crashing the container: Render keeps the
// service running and healthy (200), the bot backs off exponentially, and the
// moment Discord allows the connection it logs in — no manual redeploys, no
// crash loops, no rate-limit hammering.
async function attemptLogin() {
  // A fresh attempt supersedes any previously-scheduled retry.
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  // ── Connection budget ──────────────────────────────────────────────
  // Absolute ceiling on gateway connections per rolling hour. Even if some bug
  // or a flapping link makes us retry continuously, we can never approach the
  // >1000-connections-in-a-short-window that got the token reset. Once the
  // budget is spent we wait for the oldest attempt to age out, then resume.
  const windowCutoff = Date.now() - ATTEMPT_WINDOW_MS;
  loginAttempts = loginAttempts.filter((t) => t >= windowCutoff);
  if (loginAttempts.length >= MAX_ATTEMPTS_PER_WINDOW) {
    const oldest = loginAttempts[0];
    const waitMs = Math.max(RETRY_MIN_MS, oldest + ATTEMPT_WINDOW_MS - Date.now() + 5_000);
    const waitSec = Math.ceil(waitMs / 1000);
    console.error(`🛑 Connection budget reached (${MAX_ATTEMPTS_PER_WINDOW}/hour) — pausing ${waitSec}s so we never trigger a Discord token reset.`);
    lastLoginError = `Connection budget reached — paused ${waitSec}s`;
    scheduleRetry(loginAttempt, waitMs);
    return;
  }

  loginAttempts.push(Date.now());
  loginAttempt += 1;
  const attempt = loginAttempt;
  let aborted = false;
  const delaySec = nextRetryDelay(attempt) / 1000;
  console.log(`🔁 Login attempt #${attempt}... (next retry in ${delaySec}s if this fails)`);
  lastLoginError = null;

  // If this attempt neither succeeds nor fails in time (e.g. the gateway TCP
  // handshake hangs), tear the client down and schedule a fresh attempt.
  loginWatchdog = setTimeout(() => {
    aborted = true;
    console.error(`⏰ Attempt #${attempt} hung after ${LOGIN_TIMEOUT_MS / 1000}s — Discord not responding. Backing off — next try in ${delaySec}s.`);
    lastLoginError = 'Login timed out — Discord gateway not responding (possibly rate-limited)';
    client.destroy().catch(() => {});
    scheduleRetry(attempt);
  }, LOGIN_TIMEOUT_MS);

  try {
    await client.login(process.env.DISCORD_TOKEN);
    clearTimeout(loginWatchdog);
    loginWatchdog = null;
    // Check `aborted` BEFORE touching retryTimer: if the watchdog already took
    // over, ITS scheduled retry is the live one. Clearing it here could leave
    // the bot permanently offline with no attempt pending — the exact stall that
    // produced "one login attempt, then nothing for hours".
    if (aborted) return;
    if (!client.isReady()) {
      // Login resolved but the gateway never became ready (rare). Treat it as a
      // failure rather than sitting idle forever.
      lastLoginError = 'Login resolved but the gateway never became ready';
      client.destroy().catch(() => {});
      scheduleRetry(attempt);
      return;
    }
    // Genuinely connected — drop any stale scheduled retry.
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    // clientReady handler (client.on) performs the rest of setup
  } catch (err) {
    if (aborted) return; // watchdog already scheduled the next attempt
    clearTimeout(loginWatchdog);
    loginWatchdog = null;
    lastLoginError = err.message;
    const msg = err.message || '';
    client.destroy().catch(() => {});
    if (INVALID_TOKEN_RE.test(msg)) {
      // The token itself is wrong or was revoked — retrying cannot help, and
      // hammering Discord with invalid logins is exactly what got the token
      // reset. Wait at the maximum backoff and say precisely what to do.
      const waitSec = Math.round(RETRY_MAX_MS / 1000);
      console.error(`🔑 Attempt #${attempt} rejected — DISCORD_TOKEN is invalid or was reset.`);
      console.error('   Fix: get a new token at https://discord.com/developers/applications');
      console.error(`   then update DISCORD_TOKEN and redeploy. Next try in ${waitSec}s.`);
      scheduleRetry(attempt, RETRY_MAX_MS);
    } else if (/429|rate.?limit/i.test(msg)) {
      console.error(`⏸️ Attempt #${attempt} RATE-LIMITED by Discord (429). Backing off — next try in ${delaySec}s.`);
      scheduleRetry(attempt);
    } else {
      console.error(`❌ Attempt #${attempt} FAILED:`, msg);
      scheduleRetry(attempt);
    }
  }
}

attemptLogin();
