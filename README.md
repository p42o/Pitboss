# Pitboss — Shadow Spade Lounge Bot Manager

A Discord bot management web app for the **Shadow Spade Lounge** poker group. Schedule messages, generate AI-powered poker night polls, and send automated reminders — all from a dark, card-club-themed web dashboard.

---

## Project Structure

```
pitboss/
  web/                  # Firebase-hosted frontend (vanilla HTML/CSS/JS)
  bot/                  # Node.js Discord bot (runs on VPS)
  firebase.json         # Firebase hosting + Firestore config
  .firebaserc           # Firebase project alias
  firestore.rules       # Firestore security rules
  firestore.indexes.json
```

---

## Prerequisites

- [Node.js](https://nodejs.org) v18+
- [Firebase CLI](https://firebase.google.com/docs/cli): `npm install -g firebase-tools`
- A Firebase project (already configured: `pitboss-92bba`)
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An OpenRouter API key ([openrouter.ai](https://openrouter.ai))

---

## 1. Create the First Admin User

The web app uses Firebase Email/Password authentication. There is no self-registration — you must create the first user manually in the Firebase Console.

1. Go to [Firebase Console](https://console.firebase.google.com) → select **pitboss-92bba**
2. Navigate to **Authentication** → **Users** tab
3. Click **Add user**
4. Enter an email address and a strong password
5. Click **Add user**

That user can now log in at the Pitboss web app.

---

## 2. Deploy the Web App to Firebase Hosting

```bash
# From the pitboss/ root directory

# Login to Firebase (first time only)
firebase login

# Deploy hosting + Firestore rules + indexes
firebase deploy
```

Your app will be live at:
- `https://pitboss-92bba.web.app`
- `https://pitboss-92bba.firebaseapp.com`

To deploy only hosting (no rule changes):
```bash
firebase deploy --only hosting
```

To deploy only Firestore rules:
```bash
firebase deploy --only firestore
```

---

## 3. Set Up the Bot on Your VPS

### Install dependencies

```bash
cd pitboss/bot
npm install
```

### Download Firebase Service Account

1. Go to Firebase Console → **Project Settings** → **Service Accounts**
2. Click **Generate new private key** → download the JSON file
3. Upload it to your VPS (e.g., `/home/youruser/pitboss-service-account.json`)
4. Keep this file secure — do **not** commit it to git

### Configure environment variables

```bash
cp .env.example .env
nano .env
```

Fill in:

```env
# DISCORD_TOKEN is optional here — if omitted, the bot reads the token from
# Firestore (settings/config.discordToken), which is set via the Settings UI.
# If set here, this value takes priority over Firestore. Leave it out to let
# the Settings page be the single source of truth for the token.
# DISCORD_TOKEN=your_discord_bot_token_here

# Absolute path to the Firebase service account JSON on this server
FIREBASE_SERVICE_ACCOUNT=/home/youruser/pitboss-service-account.json

# Firebase project ID
FIREBASE_PROJECT_ID=pitboss-92bba
```

> **Recommended:** Do not set `DISCORD_TOKEN` in `.env`. Instead, paste the token in the Settings page of the web app — it saves to Firestore and the bot reads it automatically. This means you never need to SSH in just to rotate a token.

### Discord Bot Permissions

In the Discord Developer Portal, your bot needs:
- **Scopes**: `bot`
- **Bot Permissions**: `Send Messages`, `View Channels`
- **Privileged Gateway Intents**: none required (Pitboss only uses `Guilds` intent)

Invite the bot to your server:
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=2048
```
Replace `YOUR_CLIENT_ID` with your bot's Application ID.

### Run the bot

**Directly:**
```bash
node index.js
```

**With PM2 (recommended for VPS — keeps bot running after logout/crash):**
```bash
npm install -g pm2

# Start
pm2 start index.js --name pitboss-bot

# Auto-start on server reboot
pm2 startup
pm2 save

# View logs
pm2 logs pitboss-bot

# Restart after updating .env or code changes
pm2 restart pitboss-bot
```

**With systemd (alternative):**

Create `/etc/systemd/system/pitboss-bot.service`:
```ini
[Unit]
Description=Pitboss Discord Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/pitboss/bot
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10
EnvironmentFile=/home/youruser/pitboss/bot/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable pitboss-bot
sudo systemctl start pitboss-bot
sudo systemctl status pitboss-bot
```

---

## 4. Configure the App (Settings Page)

After deploying and logging in:

1. Go to **Settings**
2. **Discord Bot**: Paste your bot token → **Save & Connect**. The app saves the token to Firestore, sends a restart command to the bot, and waits for the bot to come back online — no SSH needed.
3. **OpenRouter**: Paste your API key → Save → Test Connection
4. **Channels**: Click **Refresh Channels from Server** to auto-import, or add channel name + ID pairs manually.
5. **Test Channel**: Select which channel receives test sends.
6. **Bot Controls**: Use Ping, Restart, and Status Check to verify the bot is healthy.

---

## 5. Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | No | Discord bot token. If omitted, the bot reads it from Firestore (set via Settings UI). If set, overrides Firestore. |
| `FIREBASE_SERVICE_ACCOUNT` | Yes | Absolute path to Firebase service account JSON on the VPS |
| `FIREBASE_PROJECT_ID` | Yes | Firebase project ID (`pitboss-92bba`) |

---

## How the Bot Works

The bot (`bot/index.js` + `bot/scheduler.js`) runs on your VPS and:

1. Connects to Discord using discord.js v14
2. Every **30 seconds**, queries Firestore for `scheduled_jobs` where `status == 'pending'` and `scheduledFor <= now`
3. For `message` and `reminder` types: sends the content as a text message to the specified channel
4. For `poll` types: sends a native Discord poll (multiple choice, configurable duration)
5. Marks completed jobs as `status: 'sent'` and writes to the `logs` collection
6. On connect/disconnect: writes log entries visible in the Settings activity log

---

## Firestore Data Model

| Collection | Description |
|-----------|-------------|
| `settings/config` | Bot token, OpenRouter key, channel list, test channel |
| `scheduled_jobs` | Pending/sent/failed jobs created from the dashboard |
| `logs` | Activity log entries shown in Settings |

---

## Firestore Connection

The web app uses `experimentalAutoDetectLongPolling` so Firestore listeners automatically fall back from WebChannel (streaming XHR) to long-polling if the WebChannel transport is blocked. This prevents the `Fetch API cannot load ...Listen/channel` CORS error that can occur in some browser/network environments.

## Notes

- All times are displayed and stored in **Central Time (America/Chicago)**
- The bot token is stored in Firestore (settings doc). It is only accessible to authenticated Firebase users per the Firestore security rules.
- The web app uses Firebase JS SDK v10 via CDN (no build step required).
- Bot commands (ping, restart, fetch channels) use `onSnapshot` listeners — zero polling reads. The bot responds by writing to Firestore and the UI updates instantly.
