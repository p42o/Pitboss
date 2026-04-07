# WHAT TO DO WHEN YOU WAKE UP

---

## Step 1 — Delete stale Firestore documents (do this FIRST)

Open Firebase Console → **pitboss-92bba** → **Firestore Database** → **Data**

1. Click the `bot_commands` collection → Select all → Delete
2. Click the `logs` collection → Select all → Delete
   - Old log entries are cached by the browser — deleting from Firestore plus a hard reload clears them for good

---

## Step 2 — Deploy the updated web app

```bash
cd ~/pitboss
firebase deploy --only hosting
```

Wait for "Deploy complete!" before continuing.

---

## Step 3 — Push the updated bot and restart it

```bash
scp ~/pitboss/bot/index.js park@76.13.107.170:~/pitboss-bot/index.js
```

Then SSH in and restart:

```bash
ssh park@76.13.107.170
pm2 restart pitboss
pm2 logs pitboss --lines 30
```

**What you should see in the logs:**
```
[Pitboss] Bot online as Pitboss#XXXX
[Pitboss] Marked X stale pending command(s).
[Pitboss] Cleaned up X old commands and X old logs.
```

If you see errors instead, check the **Troubleshooting** section in MANUAL.md.

---

## Step 4 — Hard-clear your browser cache

**Do this every time before verifying** — stale Firestore cache in the browser can show old logs and old status even after you've deleted documents.

In Chrome/Edge/Firefox: press **Ctrl+Shift+R** (Windows) or **Cmd+Shift+R** (Mac) on the pitboss tab.

Or manually: DevTools (F12) → Network tab → check "Disable cache" → reload.

---

## Step 5 — Verify in the web app

1. Open **https://pitboss-92bba.web.app**
2. Navigate to **Settings**
3. The status dot in the nav bar should turn 🟢 green within 90 seconds
4. Click **🏓 Ping Bot** — should respond in 1–2 seconds
5. Check the **Activity Log** — should show today's startup entry only

If the ping times out, wait 60 more seconds and try again. If it still fails, run `pm2 logs pitboss` and look for errors.

---

## You're good if:
- [ ] Nav bar shows 🟢 green bot dot
- [ ] Ping responds in < 3 seconds
- [ ] Activity log shows today's startup entry (no old stale entries)
- [ ] No errors in browser console (F12) — specifically no `resource-exhausted` or `Listen/channel` errors

---

## About the "Fetch API cannot load ...Listen/channel" error

This was a WebChannel CORS error in the Firestore SDK. It's fixed. The app now uses `experimentalAutoDetectLongPolling` which automatically falls back from WebChannel (streaming XHR) to long-polling when the WebChannel transport is blocked. You should no longer see this error.

If you do see it after a deploy: hard-clear the browser cache (Step 4) — the old cached JS may still be using the WebChannel transport.

---

## About the "still showing old logs" problem

This was a Firestore local cache issue. The fix:
1. Delete the `logs` collection in Firebase Console (Step 1)
2. Hard-clear your browser cache (Step 4)

The app now also detects when it's serving cached data and re-renders cleanly when the server responds.

---

## Quota / billing reminder

You're on the **Blaze pay-as-you-go plan** now. The app is designed to stay within the free tier daily limits:
- `onSnapshot` listeners on 4 docs/queries (heartbeat, presence, scheduled_jobs, logs) — these are persistent, not polling
- Bot commands use real-time listeners instead of per-second polling — ~2 reads per command instead of 25
- Token save/restart waits for the heartbeat listener to fire instead of polling 60 times

If costs spike, check Firebase Console → Usage → Firestore for which collection is generating reads.
