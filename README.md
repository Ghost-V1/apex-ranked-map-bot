# Apex Legends Ranked Map Bot 🎯

A Discord bot that automatically alerts your server when the Apex Legends ranked BR map rotates. Also provides
`/map` and `/nextmap` slash commands to check the current rotation at any time.

Data is scraped live from [apexlegendsstatus.com](https://apexlegendsstatus.com/current-map). No API key needed.

## Features

- **🔔 Auto alerts** — sends a styled embed to a configured channel whenever the ranked map changes
- **🗺️ `/map` command** — displays the current ranked map, how long it's active, and what's next
- **⏭️ `/nextmap` command** — shows the upcoming map and when it starts
- **🎨 Rich embeds** — each map gets its own emoji and accent color
- **⏱️ Discord timestamps** — shows times in each user's local timezone

## Prerequisites

- **Node.js 18+** installed
- A **Discord bot application** (see setup below)

## Step-by-Step Setup

### 1. Create your Discord bot (5 minutes)

1. Go to the **[Discord Developer Portal](https://discord.com/developers/applications)**
2. Click **New Application** → give it a name (e.g. "Apex Map Bot")
3. Go to **Bot** tab → click **Reset Token** → copy the **Token**
4. Under "Privileged Gateway Intents", turn off all toggles (not needed)
5. Go to **OAuth2** in the sidebar
6. Under **OAuth2 URL Generator**, check:
   - ✅ `bot`
   - ✅ `applications.commands`
7. Under "Bot Permissions", check:
   - ✅ `Send Messages`
   - ✅ `Embed Links`
   - ✅ `Read Message History`
   - ✅ `Use Slash Commands`
8. Copy the generated URL at the bottom, open it in your browser, and invite the bot to your server
9. Enable **Developer Mode** in Discord: User Settings → Advanced → Developer Mode ON
10. Right-click your server icon → **Copy Server ID**
11. Right-click the channel where alerts should go → **Copy Channel ID**
12. From the **General Information** tab of your app, copy the **Application ID**

### 2. Fill in your credentials

Open `.env` and replace the placeholders:
```env
DISCORD_TOKEN=paste_your_bot_token
CLIENT_ID=paste_your_application_id
CHANNEL_ID=paste_your_channel_id
```

### 3. Install & deploy commands

```bash
npm install
npm run deploy
```

### 4. Run locally to test (optional)

```bash
npm start
```

Try `/map` in your Discord server — it should respond with the current ranked map!

---

## ☁️ 24/7 Cloud Hosting (Free — PC not needed!)

The bot runs on **Render**'s free tier so it stays online even when your PC is off.

### One-time setup:

**A. Push to GitHub**

1. Create a new **private** repository on [GitHub](https://github.com/new)
2. Push this project:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/apex-ranked-map-bot.git
git push -u origin main
```

**B. Deploy on Render**

1. Go to [render.com](https://render.com) → Sign up with GitHub
2. Click **New +** → **Web Service**
3. Connect your GitHub repo (`apex-ranked-map-bot`)
4. Render auto-detects `render.yaml` — just confirm:
   - Name: `apex-ranked-map-bot`
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: Free
5. Under **Environment Variables**, add all four from your `.env`:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `CHANNEL_ID`
6. Click **Create Web Service**

**C. Keep it awake (free)**

Render's free tier sleeps after 15 minutes of inactivity. Prevent this:

1. After deploy, copy your bot's Render URL (looks like `https://apex-ranked-map-bot.onrender.com`)
2. Go to [uptimerobot.com](https://uptimerobot.com) → Sign up (free)
3. Click **+ Create New Monitor**
4. Type: **HTTP(s)**, paste the Render URL, interval: **5 minutes**
5. Click **Create Monitor**

✅ Done! The bot now runs 24/7 for free — no PC required.

**D. Deploy commands from the cloud**

After the Render service is live, you need to register slash commands. You can either:
- Run `npm run deploy` from your local machine (uses the same `DISCORD_TOKEN` and `CLIENT_ID`)
- Or use Render's Shell tab to run `npm run deploy` inside the cloud environment

## Commands

| Command | Description |
|---------|-------------|
| `/map` | Show the current ranked BR map with timing and next rotation |
| `/nextmap` | Show only the upcoming ranked map and when it starts |

## How it works

- The bot polls the Apex Legends Status API every **5 minutes**
- On startup, it silently records the current map (no alert)
- Whenever the map code changes between polls, it sends a rich embed alert to the configured channel
- Both slash commands fetch live data on demand

## Maps tracked

| Map | Emoji |
|-----|-------|
| Kings Canyon | 🏜️ |
| World's Edge | ❄️ |
| Olympus | ☁️ |
| Storm Point | 🌴 |
| Broken Moon | 🌑 |
| E-District | 🌃 |
