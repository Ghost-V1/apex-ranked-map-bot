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
let pollTimer = null;

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
client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📍 Alert channel: ${process.env.CHANNEL_ID}`);
  console.log(`⏱️  Polling every ${POLL_INTERVAL_MS / 60_000} minutes`);

  // Immediate first check
  checkAndAlert();
  // Set up recurring polling
  pollTimer = setInterval(checkAndAlert, POLL_INTERVAL_MS);
});

// ── HTTP Server (for Render health checks & UptimeRobot keep-alive) ──
// Try PORT env var first, fall back to a random available port if needed
const PORT = process.env.PORT || 0;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`🟢 Apex Ranked Map Bot — Online\nCurrent map: ${lastKnownMapName || 'loading...'}`);
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
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('❌ Discord login FAILED:', err.message);
  console.error('   This usually means DISCORD_TOKEN is wrong, expired, or has extra whitespace.');
  console.error('   Fix it in Render → Environment → DISCORD_TOKEN, then redeploy.');
  process.exit(1); // fail the deploy loudly instead of running a dead bot
});
