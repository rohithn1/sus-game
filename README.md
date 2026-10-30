# SUS — real-life imposter game

Players scan a QR code and play in their phone's browser. There's no app to install and no accounts. The game runs on your laptop over your home Wi-Fi.

## One-time setup
1. Install **Node.js** (the LTS version) from https://nodejs.org
2. *(Optional, recommended)* Install **ffmpeg**: Mac `brew install ffmpeg`, Windows `winget install ffmpeg`. It converts iPhone videos so they also play on Android phones.

## Every game night
- **Mac:** double-click `start.command`. If it's blocked, right-click it, choose Open, then Open again.
- **Windows:** double-click `start.bat`
- **Or** in a terminal in this folder: `npm install` (first time only), then `npm start`

The window shows a QR code, the address, and the **host PIN**. Keep that window open while you play. The PIN is saved in `config.json`, and you can change it there.

## Hosts (you + your roommate)
1. On your phone, open the address (or scan the QR), tap **I'm a host**, and enter your name and the PIN. Your phone stays logged in as host.
2. Tap **+ New game lobby**. The **Host** tab shows a big QR code and a 4-letter code. Players scan it, type their name, and they're in the lobby chat.
3. Press **Start game** (3+ players). Each player gets a 5-second "hide your screen" countdown, then sees their role for 3 seconds.
4. When someone shows you a task photo, open **Players**, find them, and tap the task to mark it done.
5. During a vote you can press **End vote now** if someone's phone died.
6. After a game ends, press **Play again** or **Back to lobby** to let new people join.

Edit the task list on the host home screen, with one task per line. Each player gets a random set when the game starts (default 4, changeable per lobby).

## Rules the app enforces
- 5 or fewer players: 1 imposter. 6 or more: 2 imposters. Imposters see who their partner is.
- Imposters tap 📹, pick a victim, and record a ~5 second video. Everyone's phone then alarms with an **Emergency Meeting** that shows the video. Every crewmate's chat has the same 📹 button, so the button alone doesn't give anyone away.
- Everyone still in the game votes, imposters included. Votes can't be changed. The most votes is booted, and a tie boots nobody. The app announces whether the booted player was an imposter.
- Killed and voted-off players can read the chat but can't send messages or vote.
- The crew wins when every imposter is out or all crew tasks are done. Imposters' tasks are fake and don't count, and killed crewmates' tasks still count. Imposters win once they **equal or outnumber** the crew.
- Players can **hold "my role"** in the top bar to check their role again.

## Troubleshooting
- **Phones can't open the page:** they must be on the same Wi-Fi as the laptop. Guest networks often block this, so use the main network. Allow Node through the firewall if your laptop asks.
- **No alarm sound:** the page must be open on screen, the volume up, and on iPhone the silent switch off. Phones vibrate where supported. If a phone was locked during a meeting, the alarm plays when it's reopened.
- **The QR shows the wrong address:** start with `PUBLIC_URL=http://<laptop-ip>:3000 npm start`.
- Games survive a restart. Kill videos are saved in `data/uploads`.
# sus-game
