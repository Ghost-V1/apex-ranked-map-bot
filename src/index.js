const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { getCurrentRankedMap, fetchMapRotation } = require('./map-checker');
const http = require('http');
require('dotenv').config();

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

let lastKnownMapCode = null; // tracks the previously-seen ranked map code
let lastKnownMapName = null; // tracks the previously-seen ranked map display name
let lastLoginError = null;   // last Discord login error message, surfaced via health endpoint
let pollTimer = null;
let loginWatchdog = null;    // per-attempt timeout: tears down a hanging login and retries
let retryTimer = null;       // scheduled next attempt (cleared on success to avoid stale retries)
let loginAttempt = 0;        // login retry counter (surfaced via health endpoint)
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
async function checkAndAlert() {
  const channel = client.channels.cache.get(process.env.CHANNEL_ID);
  if (!channel) {
    console.error('❌ Could not find the alert channel. Check CHANNEL_ID.');
    return;
  }

  try {
    const { currentMap, currentCode, nextMap, nextCode, currentEnd } =
      await getCurrentRankedMap();

    if (!currentMap) return; // nothing to report

    // First run — just store, don't alert.
    // Track by the raw map NAME, not the mapped code. The name is always a
    // non-null string when we get here, so this sentinel can't collide with a
    // missing/unrecognized value and silently stop the bot from alerting.
    if (lastKnownMapName === null) {
      lastKnownMapCode = currentCode;
      lastKnownMapName = currentMap;
      console.log(`📍 Initial map: ${currentMap} (${currentCode})`);
      return;
    }

    // Map changed!
    if (currentMap !== lastKnownMapName) {
      const embed = new EmbedBuilder()
        .setTitle(`${mapEmoji(currentCode)} Ranked Map Changed!`)
        .setDescription(
          `The ranked map has rotated!\n\n` +
          `**Previous:** ~~${lastKnownMapName}~~\n` +
          `**Current:** **${currentMap}** ${mapEmoji(currentCode)}\n` +
          `**Next up:** ${nextMap || 'Unknown'} ${mapEmoji(nextCode)}\n\n` +
          `Current map ends ${formatCountdown(currentEnd)}`
        )
        .setColor(mapColor(currentCode))
        .setTimestamp();

      await channel.send({ embeds: [embed] });
      console.log(`🔄 Map changed: ${lastKnownMapName} → ${currentMap}`);
      lastKnownMapCode = currentCode;
      lastKnownMapName = currentMap;
    }
  } catch (err) {
    console.error('⚠️ Polling error:', err.message);
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
// .on() (not .once()) so a re-login after a connection failure still re-runs setup.
client.on('clientReady', () => {
  loginAttempt = 0; // successful login — reset the backoff counter
  if (loginWatchdog) {
    clearTimeout(loginWatchdog);
    loginWatchdog = null;
  }
  if (pollTimer) {
    // Already set up from a previous successful login — this is a reconnect.
    console.log(`✅ Reconnected as ${client.user.tag}`);
    return;
  }
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📍 Alert channel: ${process.env.CHANNEL_ID}`);
  console.log(`⏱️  Polling every ${POLL_INTERVAL_MS / 60_000} minutes`);

  // Immediate first check
  checkAndAlert();
  // Set up recurring polling
  pollTimer = setInterval(checkAndAlert, POLL_INTERVAL_MS);
});

// ── Discord Reachability Probe ───────────────────────────────────────
// Pings Discord's REST API with the bot token so we can distinguish:
//   200  → Discord reachable AND token valid
//   401  → token invalid/revoked (fix in Render env)
//   429  → Discord rate-limiting this IP (back off and wait)
//   error → network-level unreachability
async function probeDiscordEgress() {
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
}

// Log reachability every minute so Render's Logs tab shows whether the instance
// can reach Discord over time.
setInterval(async () => {
  await probeDiscordEgress();
  if (lastEgressCheck?.ok) {
    console.log(`🌐 Discord API reachable (${lastEgressCheck.ms}ms)`);
  } else if (lastEgressCheck?.error?.includes('429')) {
    console.error('🌐 Discord API RATE-LIMITED (429) — backing off, will retry automatically');
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
    `Login attempts: ${loginAttempt}\n`;
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
const RETRY_MIN_MS     = 15_000; // first retry delay
const RETRY_MAX_MS     = 5 * 60_000; // backoff cap: never retry faster than every 5 min

// Exponential backoff: 15s, 30s, 60s, 120s, 240s, 480s→capped at 5 min.
// Rapid retries trigger Discord's rate limiter (HTTP 429); backing off lets the
// limit expire and still self-heals the moment Discord responds again.
function nextRetryDelay(attempt) {
  return Math.min(RETRY_MIN_MS * 2 ** Math.min(attempt - 1, 5), RETRY_MAX_MS);
}

// Retry login in-process instead of crashing the container: Render keeps the
// service running and healthy (200), the bot backs off exponentially, and the
// moment Discord allows the connection it logs in — no manual redeploys, no
// crash loops, no rate-limit hammering.
async function attemptLogin() {
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
    retryTimer = setTimeout(attemptLogin, nextRetryDelay(attempt));
  }, LOGIN_TIMEOUT_MS);

  try {
    await client.login(process.env.DISCORD_TOKEN);
    // Cancel any stale scheduled retry now that login settled, even if the
    // watchdog fired first (destroy() normally forces a rejection, but be safe).
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (aborted) return; // watchdog already took over
    clearTimeout(loginWatchdog);
    loginWatchdog = null;
    // clientReady handler (client.on) performs the rest of setup
  } catch (err) {
    if (aborted) return; // watchdog already scheduled the next attempt
    clearTimeout(loginWatchdog);
    loginWatchdog = null;
    lastLoginError = err.message;
    if (/429|rate.?limit/i.test(err.message || '')) {
      console.error(`⏸️ Attempt #${attempt} RATE-LIMITED by Discord (429). Backing off — next try in ${delaySec}s.`);
    } else {
      console.error(`❌ Attempt #${attempt} FAILED:`, err.message);
    }
    client.destroy().catch(() => {});
    retryTimer = setTimeout(attemptLogin, nextRetryDelay(attempt));
  }
}

attemptLogin();
