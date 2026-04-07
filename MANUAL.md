# Pitboss — User Manual

_Last updated: March 27, 2026 (quota incident + stability fixes)_

---

## What Is Pitboss?

Pitboss is a Discord bot management dashboard for the **Shadow Spade Lounge** poker group. It has two parts that work together:

- **Web App** — hosted on Firebase, accessible at `https://pitboss-92bba.web.app`. This is where you do everything.
- **Bot Process** — a Node.js app running on your VPS at `76.13.107.170`. It watches for jobs and commands written by the web app and executes them in Discord.

They communicate through **Firestore** (Firebase's database). The web app writes jobs → the bot reads and executes them. Neither talks to the other directly.

---

## Accessing the App

```
https://pitboss-92bba.web.app
```

Log in with the email/password you created in Firebase Console (Authentication → Users). You are the only user.

---

## Managing the Bot on Your VPS

### SSH In
```bash
ssh park@76.13.107.170
```

### Check Bot Status
```bash
pm2 status
```
Look for `pitboss` with status `online`. If it shows `errored` or `stopped`, see Troubleshooting.

### View Live Logs
```bash
pm2 logs pitboss
```
Press `Ctrl+C` to stop tailing.

### View Last 50 Log Lines
```bash
pm2 logs pitboss --lines 50
```

### Restart the Bot
```bash
pm2 restart pitboss
```

### Stop / Start the Bot
```bash
pm2 stop pitboss
pm2 start /home/park/pitboss-bot/index.js --name pitboss
```

### Bot Files Location
```
/home/park/pitboss-bot/
  index.js             # main bot entry point
  scheduler.js         # job execution loop (checks every 30s)
  .env                 # your secrets (token, Firebase path)
  serviceAccount.json  # Firebase admin credentials
```

### Update Bot Code from Mac
When bot files change, copy them over and restart:
```bash
scp ~/pitboss/bot/index.js park@76.13.107.170:~/pitboss-bot/index.js
scp ~/pitboss/bot/scheduler.js park@76.13.107.170:~/pitboss-bot/scheduler.js
```
Then on your VPS:
```bash
pm2 restart pitboss
```

---

## Deploying Web App Updates

```bash
cd ~/pitboss
firebase deploy --only hosting       # web app only
firebase deploy --only firestore:rules  # rules only
firebase deploy                      # everything
```

---

## The Web App — Page by Page

### Login Page
Email/password login. To reset your password:
Firebase Console → pitboss-92bba → Authentication → Users → your email → Reset Password.

---

### Nav Status Bar (top of every page)

Embedded in the navigation bar, right-aligned. Shows live stats at a glance:

| Stat | What it shows |
|------|--------------|
| CT | Live clock in Central Time, ticks every second |
| Bot | Bot tag with a colored dot — 🟢 green = online (seen <150s), 🟡 yellow = idle (<6min), 🔴 red = offline |
| Online | Members currently online in your Discord server |
| Queued | Pending scheduled items waiting to be sent |

---

### Dashboard — 3 Columns + Queue Panel

The three columns sit at the top. Below them, a full-width **Upcoming Queue** panel shows every pending scheduled item (broadcasts, polls, reminders, and announcements) color-coded in a responsive grid.

#### 📣 Column 1: Broadcast (Message Composer)

Send or schedule any message to any channel.

1. Type in the text area — Discord markdown supported:
   - `**bold**`, `*italic*`, `__underline__`, `~~strikethrough~~`
   - `` `code` ``, ` ```code block``` `, `> quote`
2. Toolbar buttons insert formatting at cursor position
3. **Preview** panel shows how it renders in Discord
4. Emoji button opens a picker — click to insert at cursor
5. Select a **Channel** from the dropdown
6. Action buttons:
   - **🧪 Test** — sends to test channel, does not clear the form
   - **⚡ Send Now** — sends immediately to selected channel
   - **📅 Schedule** — reveals 12-hour CT date/time picker

---

#### 🗳️ Column 2: Poll Generator

Generates and sends the monthly poker night vote poll.

1. Select **Month** and **Year** — defaults to next calendar month
2. Click **Generate Poll** — calls OpenRouter AI to produce:
   - Title: `🎃 October 2026 Monthly Poker Night Vote 🎃` (month-thematic emoji each side)
   - One option per Thursday: `Thurs (10/02) @ 7:30 PM CT 🍂`
   - Holiday-aware emojis per Thursday, with holiday callouts
   - Multi-select enabled, 7-day duration
3. Edit the generated poll in the preview (title and options are editable)
4. Action buttons: **🧪 Test** | **⚡ Send Now** | **📅 Schedule**

Poll generation errors appear in the preview area AND are logged to the Activity Log.

---

#### 📣 Column 3: Announce & ⏰ Remind

Two sections share the poker night date picker at the top.

**Shared date field:** Enter the **Next Poker Night** date and time (CT) — both the Announcement Generator and Reminder Generator use this value.

---

##### 📣 Announcement Generator

Builds a formatted announcement post for your poker night.

1. Enter the **Next Poker Night** date at the top of the column
2. (Optional) Enter an **Image URL** — if provided, the bot posts the image 1–2 seconds before the announcement text
3. Select a **Channel** from the channel dropdown
4. Click **📣 Generate Announcement** — builds a formatted post including:
   - Month-themed emojis (e.g., 🎃 for October, ❄️ for January) flanking the title
   - Date, time (7:30 PM CT), platform, buy-in, blinds
   - A random month-appropriate deposit memo word (e.g., `pumpkinpatch` in October, `snowflake` in January)
   - `@everyone` ping and a ✅ / ❌ RSVP prompt
5. Edit the announcement text in the preview textarea
6. Action buttons:
   - **🧪 Test** — posts to the test channel immediately
   - **⚡ Send Now** — posts to the selected channel immediately
   - **📅 Schedule** — reveals a CT date/time picker; confirm to queue for future delivery

**After posting:** The bot automatically reacts to the announcement message with ✅ and ❌ so members can RSVP directly in Discord.

---

##### ⏰ Reminders

Auto-generates the three standard poker night reminders.

1. Enter the **Next Poker Night** date at the top of the column (shared with Announcement)
2. Click **⏰ Generate Reminders** — creates three reminder cards:
   - **24 hours before** — "Poker night is tomorrow at 7:30 PM CT!"
   - **Day-of at 12:00 PM CT** — "Poker is tonight at 7:30 PM CT!"
   - **Day-of at 6:30 PM CT** — "One hour to go! Tables open at 7:30 PM CT!"
3. Each reminder card has:
   - Editable message text
   - Its own **Channel** dropdown — select independently per reminder
   - **🧪 Test** | **⚡ Send Now** | **📅 Schedule** buttons
4. **📅 Schedule All 3** — validates that all three cards have a channel selected, then schedules all three in one click using each card's individually chosen channel

---

---

##### 🃏 Join The Table

Posts the table-live link, moves the join-the-game channel from hidden to visible, all on a schedule.

1. Enter the **PokerNow Table URL** (paste it game night)
2. **Post Time** defaults to 7:00 PM CT today — adjust if needed
3. A preview of the message appears as you type the URL:
   ```
   The Table is LIVE: https://www.pokernow.com/games/...
   ⚠️   Starting in: 30 min

   @everyone
   ```
4. **🧪 Test** — posts the message to the test channel only (no channel move)
5. **📅 Schedule** — queues the job; when it fires the bot:
   - Moves the join-the-game channel from the **Inactive Table** category to **The Pit** category (making it visible to members)
   - Posts the table link message in that channel

**Requires** Join-the-Table settings configured in Settings → 🃏 Join The Table. The tool will show a warning if not configured.

---

#### 📅 Upcoming Queue (full-width panel below columns)

A single consolidated panel showing every pending scheduled job across all types. Items appear in a responsive card grid sorted by scheduled time (soonest first).

Each card shows:
- **Type badge** — color-coded by type:
  - 🔵 BROADCAST (blue)
  - 🟣 POLL (purple)
  - 🟡 REMINDER (amber)
  - 🟨 ANNOUNCE (gold)
  - 🟨 TABLE LIVE (gold)
- Scheduled time in CT
- Channel name
- Message preview (first 100 characters)
- 🗑 delete button to cancel the job

The panel header shows a count badge (e.g., "4 items") when the queue is non-empty.

---

### Settings Page

All left-column panels are **collapsible** — click the header to toggle. Collapsed panels show a status badge (Online / Connected / N channels / Custom / etc.).

#### 🤖 Discord Bot
- **Bot Token** → **Save & Connect** — saves the token and immediately sends a restart command. Shows a live 60-second countdown waiting for the bot to reconnect.
- **Discord Server ID** → **Fetch Channels** — asks the bot to pull all text channels from your server and auto-populate the channels list.
- **Test Channel** → **Save** — sets the channel used by all 🧪 Test buttons site-wide.

#### 🧠 OpenRouter
- **API Key** → **Save** — saves key independently.
- **Model** → **Save** — saves model selection independently. Options grouped by provider (Google Gemini, OpenAI, Anthropic, Meta Llama, Mistral).
- **🔌 Test Connection** — verifies the key works against the OpenRouter API and logs the result.

Default model: `google/gemini-2.0-flash-lite-001` (fast and cheap).

#### 📺 Channels
Add Discord channel name → ID pairs. These populate all channel dropdowns across the app.
- Get a Channel ID: right-click the channel in Discord → Copy Channel ID (requires Developer Mode on in Discord settings).
- Use **Fetch Channels** in the Discord Bot panel to auto-populate instead of adding manually.

#### 🃏 Join The Table
Configure the channel reveal system for game night.

- **Join-the-Game Channel** → **Save** — select which channel gets moved and posted in when the table is live
- **📂 Fetch Categories from Server** — asks the bot to pull all Discord category names and IDs from your server
- **Inactive Category** → **Save** — the category the join channel normally lives in (hidden from members, e.g. "Inactive Table")
- **Active Category** → **Save** — the category the join channel moves to when the table is live (visible to members, e.g. "The Pit")
- Badge shows **Configured** (green) once both channel and active category are set

**Discord setup required:** The "Inactive Table" category should have `@everyone View Channel` permission **denied**. The "The Pit" category should have it **allowed**. The bot needs Administrator or Manage Channels permission to move channels between categories.

#### 🎭 Pitboss Personality
The system prompt used when Pitboss replies to @mentions in Discord.
- Edit the prompt in the textarea and click **Save Personality**
- **Reset to Default** restores the original gruff casino enforcer prompt
- Badge shows **Custom** when modified, **Default** when using the built-in prompt
- The **capabilities reference card** at the bottom lists everything Pitboss can do

#### 🎮 Bot Controls
Four action buttons on the right side of settings:

| Button | What it does |
|--------|-------------|
| 🏓 Ping Bot | Measures round-trip response time. Logs result. Times out at 12s. |
| 📤 Test Send | Sends a test message to the configured test channel |
| 🔄 Restart Bot | Sends restart command → PM2 restarts the bot → polls for 60s until back online |
| 📡 Force Status | Returns bot tag, server count, and uptime |

**Last seen** — top-right of controls panel shows how long ago the bot sent its last heartbeat. The counter ticks locally every second — no Firestore reads involved.

#### 📋 Activity Log
Real-time Firestore-backed feed of everything the bot does.

| Badge | Meaning |
|-------|---------|
| ✅ SUCCESS | Action completed successfully |
| 📤 SENT | Message, poll, or reminder sent to Discord |
| 📅 SCHEDULED | Item queued for future delivery |
| ⚠️ WARNING | Non-fatal issue (restart triggered, ping timeout, etc.) |
| ❌ ERROR | Something failed — check the message for details |
| 🔌 CONNECTION | Bot connected, disconnected, or restarted |

**Auto-ping** — dropdown in the log header. Set an interval (1m / 5m / 10m / 15m / 30m / 60m) and Pitboss automatically pings the bot on schedule and logs the response time. Shows `● Auto-pinging every Xm` badge when active. Set to **Off** to stop.

**Clear** — deletes all log entries from Firestore. Cannot be undone.

---

### Pitboss @Mention Replies

When anyone tags `@Pitboss` in Discord, the bot:
1. Reads the personality prompt from Firestore
2. Calls OpenRouter with the message
3. Replies in character (gruff underground casino enforcer — roasts people, occasional poker wisdom, keeps it under 300 characters)
4. Logs every reply to the Activity Log

**10-second cooldown per user** to prevent spam. Requires:
- OpenRouter key configured in Settings
- **Message Content Intent** enabled in Discord Developer Portal (Bot → Privileged Gateway Intents)

---

## Troubleshooting

### Bot shows "errored" in PM2

```bash
pm2 logs pitboss --lines 30
```

**`.env` missing or empty:**
```bash
cat ~/pitboss-bot/.env
```
Should show all three vars. If not:
```bash
cat > ~/pitboss-bot/.env << 'EOF'
DISCORD_TOKEN=your_token_here
FIREBASE_SERVICE_ACCOUNT=/home/park/pitboss-bot/serviceAccount.json
FIREBASE_PROJECT_ID=pitboss-92bba
EOF
pm2 restart pitboss
```

**Service account file missing:**
```bash
ls -la ~/pitboss-bot/serviceAccount.json
```
If missing, re-download from Firebase Console → Project Settings → Service Accounts → Generate New Private Key, then:
```bash
scp ~/Downloads/pitboss-92bba-firebase-adminsdk-*.json park@76.13.107.170:~/pitboss-bot/serviceAccount.json
```

---

### Bot online in PM2 but status dot shows red

Wait 90 seconds (heartbeat writes every 60s — the dot stays green for up to 150s after the last beat). If still red after 2 minutes:
```bash
pm2 restart pitboss
pm2 logs pitboss --lines 20
```
Check for Firebase connection errors in the output. If you see `resource-exhausted: Quota exceeded`, see **Firestore Quota Exhausted** below.

---

### Poll generation fails

- Check Activity Log for the exact error message
- Go to Settings → OpenRouter → **🔌 Test Connection**
- If model error (404), go to Settings → OpenRouter → change Model → Save
- Confirmed working default: `google/gemini-2.0-flash-lite-001`

---

### @mention replies not working

1. Check that **Message Content Intent** is enabled in Discord Developer Portal → Bot → Privileged Gateway Intents
2. Check OpenRouter key is saved and tested in Settings
3. Check Activity Log for `❌ ERROR` entries about mention replies
4. Try `pm2 restart pitboss` after enabling the intent

---

### Fetch Channels returns nothing

- Make sure the bot is in your Discord server (invite it if not)
- Confirm the Server ID is correct (right-click server name → Copy Server ID)
- Make sure the bot is online (green dot in status bar)

---

### Messages scheduled but never sent

The scheduler checks every 30 seconds. If jobs stay pending:
```bash
pm2 status
pm2 logs pitboss --lines 30
```
If bot is online with no errors, the scheduled time may not have passed — check the Upcoming Queue card for the exact CT time.

---

### Firestore Quota Exhausted (everything stops working)

**Symptoms:** Activity log frozen, commands don't respond, status stuck, browser console shows `resource-exhausted: Quota exceeded`.

**Cause:** Firebase Spark (free) plan allows 50,000 reads and 20,000 writes per day. Quota resets at midnight UTC (6:00 PM CT / 7:00 PM CT during DST).

**Immediate actions:**
1. Nothing will work until quota resets — don't keep clicking buttons (each click tries to write and fails, making things worse)
2. Open Firebase Console → Firestore → Data → delete the entire `bot_commands` collection (accumulated stale docs are a major read driver on startup)
3. Wait for midnight UTC

**After quota resets:**
- Deploy web app: `firebase deploy --only hosting`
- Push bot and restart: `scp ~/pitboss/bot/index.js park@76.13.107.170:~/pitboss-bot/index.js` then `pm2 restart pitboss`
- On first restart the bot will auto-clean old commands and logs

**Current daily read budget (after March 27 fixes):**
- Heartbeat `onSnapshot`: ~1,440 reads/day (fires when bot writes, 60s interval)
- Log query on page load: 50 reads per load
- No polling intervals — status display is fully local
- Well under the 50k limit for normal use

---

### Can't log in to the web app

Firebase Console → pitboss-92bba → Authentication → Users → your email → three-dot menu → Reset Password.

---

### Full bot restart from scratch

```bash
pm2 delete pitboss
cd ~/pitboss-bot
pm2 start index.js --name pitboss
pm2 save
```

---

## Quick Reference

| Task | Command |
|------|---------|
| SSH into server | `ssh park@76.13.107.170` |
| Check bot status | `pm2 status` |
| View bot logs | `pm2 logs pitboss` |
| View last 50 lines | `pm2 logs pitboss --lines 50` |
| Restart bot | `pm2 restart pitboss` |
| Stop bot | `pm2 stop pitboss` |
| View .env | `cat ~/pitboss-bot/.env` |
| Check service account | `ls -la ~/pitboss-bot/serviceAccount.json` |
| Copy bot index.js to VPS | `scp ~/pitboss/bot/index.js park@76.13.107.170:~/pitboss-bot/index.js` |
| Deploy web app | `cd ~/pitboss && firebase deploy --only hosting` |
| Deploy everything | `cd ~/pitboss && firebase deploy` |
