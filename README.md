# SUS — real-life imposter game

Players scan a QR code and play in their phone's browser. No app, no accounts.

## Put it online for free (Render) — about 10 minutes, once

You need a free **GitHub** account and a free **Render** account. You don't need to install anything.

### 1. Put the code on GitHub
1. Unzip `sus-game.zip`.
2. Go to https://github.com/new, name the repository `sus-game`, and click **Create repository**.
3. On the new empty repo page, click **uploading an existing file**.
4. Open the unzipped `sus-game` folder. Select **everything inside it**, including the `public` folder, and drag it into the browser. Click **Commit changes**.
   - Check that the repo shows `server.js`, `render.yaml` and a `public` folder at the top level, not inside another `sus-game` folder.

### 2. Deploy on Render
1. Go to https://render.com and **sign up with GitHub**.
2. Click **New +** → **Blueprint**, connect your GitHub account, and pick the `sus-game` repo.
3. Click **Apply**. Render reads `render.yaml`, picks the **Free** plan, and creates a secret host key for you.
4. Wait 2–3 minutes for the first deploy. Your game's address appears at the top, something like `https://sus-game-ab12.onrender.com`.

### 3. Get your host link
Open the service in Render, go to **Environment**, and click to reveal **HOST_KEY**. Your host link is:

```
https://<your-address>.onrender.com/host/<HOST_KEY>
```

The **Logs** tab also prints the full host link every time the game starts.

Open the host link on your phone and type your name. That phone is now a host. Send the link to your roommate, or use **Copy host link** on the host screen. **Don't share it with players**: anyone who has it can run games.

## Playing
1. **Hosts:** the host link opens an inbox of **all games**. You're automatically a host in every game. Tap **+ New lobby** to get a QR code and 4-letter code (Host tab), and tap any game to jump into its chat.
2. Players scan the QR (cellular data or any Wi-Fi works) and type their name.
3. In the game, press **Start game** (3+ players). Everyone gets a 5-second countdown to hide their screen, then sees their role for 3 seconds.
4. Each player's tasks sit as a **checklist at the top of the chat**. When they finish one, they tap **📸 Submit**, take a photo, and send it. It posts in the chat tagged **@hosts**, and every host's phone gets pinged, even if they're in a different game.
5. Hosts tap **✓ Approve** or **✕ Reject** right on the photo. Approved tasks tick off the player's checklist. Rejected ones can be resubmitted.
6. During a vote, **End vote now** counts the votes so far, in case someone's phone died.

## How a game ends
- **Crew wins** when every imposter is out, or when every crew task is approved before the imposters reach 50/50.
- **Imposters win** the moment they equal the crew (50/50).

## Your task list
Edit `tasks.txt` on GitHub (open it, click the ✏️ pencil, put one task per line, then **Commit**). Render redeploys automatically in a couple of minutes. You can also edit tasks on the host screen, but on the free plan those edits are lost when the server restarts. `tasks.txt` is the permanent list.

## Free plan quirks (good to know)
- **It sleeps after 15 minutes with nobody on the page.** The first visit after that takes about a minute to wake up. Open your host link a few minutes before people arrive.
- **Sleeping or restarting wipes lobbies, chat and kill videos.** Just make a new lobby. While anyone has the game open, it stays awake.
- Each month includes 750 free hours, which is plenty for one game.

## Rules the app enforces
- 5 or fewer players get 1 imposter. 6 or more get 2, and imposters see who their partner is.
- Imposters tap 📹, pick a victim, and record a ~5 second video. Everyone's phone then alarms with an **Emergency Meeting** that shows the video. Every player has the 📹 button, so having it gives nobody away.
- Everyone still in the game votes, imposters included. Votes are final, the most votes is booted, and a tie boots nobody. The app announces whether the booted player was an imposter.
- Killed and voted-off players can read the chat but can't talk or vote.
- The crew wins when every imposter is out or all crew tasks are done. Imposters' tasks are fake and don't count. Imposters win once they equal or outnumber the crew.
- Players can **hold "my role"** in the top bar to check their role again.
- On the hosted version, phones keep their screen on during a game so the alarm isn't missed. Volume up, and on iPhone turn the silent switch off.

## Running it on your laptop instead (optional)
Install Node.js from https://nodejs.org, then double-click `start.command` (Mac) or `start.bat` (Windows). The window prints the QR and your host link. Everyone has to be on the same Wi-Fi, and guest networks often block this.
