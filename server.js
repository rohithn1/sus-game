// SUS — a real-life imposter game for your house.
// Run: npm install && npm start   (everyone must be on the same Wi-Fi)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const compression = require('compression');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// ---------- config ----------
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const CONFIG_FILE = path.join(ROOT, 'config.json');
if (!fs.existsSync(CONFIG_FILE)) {
  const hostKey = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ hostKey, port: 3000, defaultTasksPerPlayer: 4 }, null, 2));
}
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
// The secret in the host link (/host/<key>). On a cloud host, set HOST_KEY as an environment variable.
const HOST_KEY = String(process.env.HOST_KEY || config.hostKey || '');
if (HOST_KEY.length < 8) { console.error('HOST_KEY must be at least 8 characters.'); process.exit(1); }
const PORT = Number(process.env.PORT || config.port || 3000);
function isHostKey(k) {
  const a = Buffer.from(String(k || '')), b = Buffer.from(HOST_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Your task list lives in tasks.txt (one per line). In-app edits last until the server restarts.
// A line starting with [shared] is a shared task: one approved photo from anyone completes it for the group.
// Every other line is an "everyone" task: each player has to do it once.
const TASKS_FILE = path.join(ROOT, 'tasks.txt');
const BUILTIN_TASKS = [
  'Placeholder: Stack 5 cups into a pyramid in the kitchen',
  'Placeholder: Fold a towel and leave it on the couch',
  'Placeholder: Find the remote and put it on the TV stand',
  'Placeholder: Draw a smiley face on the whiteboard',
  'Placeholder: Turn on the porch light',
  'Placeholder: Line up 3 shoes by the front door',
  'Placeholder: Fill a glass of water and leave it on the counter',
  'Placeholder: Make a paper airplane',
  'Placeholder: Do 10 jumping jacks (filmed or witnessed)',
  'Placeholder: Write your name on a sticky note on the fridge',
  'Placeholder: Arrange the couch pillows by color',
  'Placeholder: Open the blinds in the living room',
];
const SHARED_TAG = /^\[shared\]\s*/i;
const tidy = (x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 140);
function parseTask(t) {
  if (t && typeof t === 'object') return { text: tidy(t.text), shared: !!t.shared };
  const line = String(t || '').trim();
  return { text: tidy(line.replace(SHARED_TAG, '')), shared: SHARED_TAG.test(line) };
}
function taskFileText(list) {
  return '# One task per line. Lines starting with # are ignored.\n' +
    '# Start a line with [shared] for a task that only one person needs to do. Other tasks must be done by everyone.\n' +
    list.map((t) => (t.shared ? '[shared] ' : '') + t.text).join('\n') + '\n';
}
function loadTaskFile() {
  try {
    const lines = fs.readFileSync(TASKS_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.length) return lines.map(parseTask).filter((t) => t.text);
  } catch {}
  return BUILTIN_TASKS.map(parseTask);
}
// ---------- state (persisted to data/state.json) ----------
const DEFAULT_TASKS = loadTaskFile();
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let state = { games: {}, taskPool: DEFAULT_TASKS.slice() };
try {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...state, ...loaded, taskPool: DEFAULT_TASKS.slice() };
    for (const g of Object.values(state.games)) {
      if (g.demo) { delete state.games[g.code]; continue; }
      if (g.status === 'reveal') g.status = 'playing';
      for (const p of Object.values(g.players)) p.connected = false;
    }
  }
} catch (e) { console.warn('Could not read saved state, starting fresh:', e.message); }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(state), () => {});
  }, 1500);
}

// ---------- helpers ----------
const id = (n = 8) => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();
const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const isAlive = (p) => !p.dead && !p.ejected;
const plist = (g) => Object.values(g.players).sort((a, b) => a.joinedAt - b.joinedAt);
const REVEAL_MS = 8000; // 5s countdown + 3s role flash

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do { code = Array.from({ length: 4 }, () => letters[crypto.randomInt(0, letters.length)]).join(''); }
  while (state.games[code]);
  return code;
}

function lanAddress() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) for (const n of list || []) {
    if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  }
  const rank = (ip) => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  ips.sort((a, b) => rank(a) - rank(b));
  return ips[0] || 'localhost';
}
const BASE_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://${lanAddress()}:${PORT}`).replace(/\/$/, '');
const HOST_URL = `${BASE_URL}/host/${HOST_KEY}`;

// Chat goes out as small add/update packets instead of resending the whole history to every phone.
const outbox = new Map(); // code -> { add: [], upd: [] }
function box(g) { if (!outbox.has(g.code)) outbox.set(g.code, { add: [], upd: [] }); return outbox.get(g.code); }
function pushMsg(g, m) {
  g.messages.push(m);
  if (g.messages.length > 300) g.messages.splice(0, g.messages.length - 300);
  box(g).add.push(m);
}
function updMsg(g, m) { if (g.messages.includes(m)) box(g).upd.push(m); }
function resetMsgs(g) { g.messages = []; g.msgEpoch = (g.msgEpoch || 0) + 1; outbox.delete(g.code); }
function sysMsg(g, text, extra = {}) {
  pushMsg(g, { id: id(4), type: 'system', text, ts: now(), ...extra });
}

function crewProgress(g) {
  // shared tasks count once for the group; "everyone" tasks count once per crewmate
  const shared = g.sharedTasks || [];
  let done = shared.filter((t) => t.done).length, total = shared.length;
  for (const p of Object.values(g.players)) {
    if (p.role !== 'crew') continue;
    total += p.tasks.length;
    done += p.tasks.filter((t) => t.done).length;
  }
  return { done, total };
}

function checkWin(g) {
  if (g.status !== 'playing' && g.status !== 'meeting' && g.status !== 'reveal') return false;
  const ps = Object.values(g.players);
  const aliveImp = ps.filter((p) => p.role === 'imposter' && isAlive(p)).length;
  const aliveCrew = ps.filter((p) => p.role === 'crew' && isAlive(p)).length;
  const prog = crewProgress(g);
  let winner = null, reason = '';
  if (aliveImp === 0) { winner = 'crew'; reason = 'Every imposter is out.'; }
  else if (aliveImp >= aliveCrew) { winner = 'imposters'; reason = 'The imposters now equal or outnumber the crew.'; }
  else if (prog.total > 0 && prog.done >= prog.total) { winner = 'crew'; reason = 'The crew finished every task.'; }
  if (!winner) return false;
  g.status = 'ended';
  g.meeting = null;
  g.pendingKills = [];
  g.winner = winner;
  g.winReason = reason;
  sysMsg(g, winner === 'crew' ? `🎉 CREW WINS — ${reason}` : `🔪 IMPOSTERS WIN — ${reason}`);
  return true;
}

// ---------- game actions ----------
function startGame(g, opts = {}) {
  const ps = plist(g);
  if (ps.length < 3) throw new Error('Need at least 3 players to start.');
  const pool = (opts.pool || state.taskPool).map(parseTask).filter((t) => t.text);
  if (pool.length === 0) throw new Error('The task list is empty. Add tasks first.');
  const everyone = pool.filter((t) => !t.shared);
  g.sharedTasks = pool.filter((t) => t.shared).map((t) => ({ id: 's' + id(3), text: t.text, shared: true, done: false, pending: null, pendingBy: null, doneBy: null }));
  const nImp = ps.length <= 9 ? 1 : 2; // 9 or fewer players: 1 imposter; 10 or more: 2
  const order = shuffle(ps.map((p) => p.id));
  const imps = new Set(opts.imposters || order.slice(0, nImp));
  for (const p of ps) {
    p.role = imps.has(p.id) ? 'imposter' : 'crew';
    p.dead = false; p.ejected = false;
    p.tasks = everyone.map((t) => ({ id: id(3), text: t.text, done: false, pending: null }));
  }
  g.round = (g.round || 0) + 1;
  resetMsgs(g);
  g.meeting = null; g.lastResult = null; g.winner = null; g.winReason = ''; g.pendingKills = [];
  g.status = 'reveal';
  g.revealStartedAt = now();
  if (g.demo) g.demo.startedAt = now();
  sysMsg(g, `Game started with ${ps.length} players and ${imps.size} imposter${imps.size > 1 ? 's' : ''}. Split up and do your tasks! When you finish one, tap 📸 Submit on your checklist to send the hosts a photo.`);
  const round = g.round;
  setTimeout(() => {
    if (g.status === 'reveal' && g.round === round) { g.status = 'playing'; broadcast(g); save(); }
  }, REVEAL_MS);
}

function resolveMeeting(g, forced) {
  const m = g.meeting;
  if (!m) return;
  const tally = {};
  for (const target of Object.values(m.votes)) tally[target] = (tally[target] || 0) + 1;
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const result = { id: id(4), meetingId: m.id, tally, forced: !!forced, ejectedId: null, wasImposter: false, tie: false };
  if (sorted.length === 0) {
    result.tie = true;
    sysMsg(g, '🗳️ Nobody voted. No one was voted off.');
  } else if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
    result.tie = true;
    sysMsg(g, '🗳️ It was a tie. No one was voted off.');
  } else {
    const p = g.players[sorted[0][0]];
    p.ejected = true;
    result.ejectedId = p.id;
    result.name = p.name;
    result.wasImposter = p.role === 'imposter';
    const left = Object.values(g.players).filter((x) => x.role === 'imposter' && isAlive(x)).length;
    result.impostersLeft = left;
    sysMsg(g, result.wasImposter
      ? `🚨 ${p.name} WAS an imposter! ${left} imposter${left === 1 ? '' : 's'} remain${left === 1 ? 's' : ''}.`
      : `😬 ${p.name} was NOT an imposter. You voted off an innocent person.`);
  }
  g.lastResult = result;
  g.meeting = null;
  g.status = 'playing';
  checkWin(g);
}

function maybeAutoResolve(g) {
  const m = g.meeting;
  if (!m) return;
  const voters = Object.values(g.players).filter(isAlive);
  if (voters.every((p) => m.votes[p.id])) resolveMeeting(g, false);
}

// ---------- views (each phone only gets what it may see) ----------
function viewFor(g, who, full) {
  const isHost = who.kind === 'host';
  const me = who.kind === 'player' ? g.players[who.playerId] : null;
  const ended = g.status === 'ended';
  const showRoles = isHost || ended;
  const players = plist(g).map((p) => ({
    id: p.id, name: p.name, alive: isAlive(p), dead: !!p.dead, ejected: !!p.ejected,
    connected: !!p.connected,
    role: showRoles ? p.role : undefined,
    tasks: isHost ? p.tasks : undefined,
  }));
  const v = {
    code: g.code, status: g.status, round: g.round || 0, players,
    imposterCount: Object.values(g.players).filter((p) => p.role === 'imposter').length,
    msgEpoch: g.msgEpoch || 0, progress: crewProgress(g), sharedTasks: g.sharedTasks || [],
    settings: g.settings, winner: g.winner, winReason: g.winReason,
    lastResult: g.lastResult,
    joinUrl: `${BASE_URL}/?code=${g.code}`,
    serverNow: now(),
    revealAgoMs: g.status === 'reveal' ? now() - g.revealStartedAt : null,
    isHost,
  };
  if (full) v.messages = g.messages;
  if (g.meeting) {
    const m = g.meeting;
    const voters = Object.values(g.players).filter(isAlive);
    v.meeting = {
      id: m.id, victimId: m.victimId, victimName: g.players[m.victimId]?.name, video: m.video,
      votedIds: Object.keys(m.votes), voterCount: voters.length,
      myVote: me ? m.votes[me.id] || null : null,
    };
  }
  const openKills = (g.pendingKills || []).filter((k) => k.status === 'processing' || k.status === 'pending');
  if (isHost) v.pendingKills = openKills;
  if (me) {
    const partners = me.role === 'imposter'
      ? Object.values(g.players).filter((p) => p.role === 'imposter' && p.id !== me.id).map((p) => p.name)
      : [];
    v.me = {
      id: me.id, name: me.name, role: g.status === 'lobby' ? null : me.role, partners,
      tasks: me.tasks || [], alive: isAlive(me), dead: !!me.dead, ejected: !!me.ejected,
    };
    if (me.role === 'imposter') {
      v.me.myKills = (g.pendingKills || []).filter((k) => k.killerId === me.id).map((k) => ({ id: k.id, status: k.status, victimName: k.victimName }));
    }
  }
  return v;
}

function preview(m) {
  if (!m) return '';
  if (m.type === 'chat') return `${m.name}: ${m.text}`;
  if (m.type === 'task') return `📸 ${m.name} submitted a task`;
  if (m.type === 'kill') return `🔪 Anonymous imposter: ${m.text}`;
  return m.text || '';
}
// The hosts' inbox: every game, most recent activity first, with how many task photos are waiting.
function summarize(g) {
  const last = g.messages[g.messages.length - 1];
  return {
    code: g.code, status: g.status, players: Object.keys(g.players).length, createdAt: g.createdAt,
    pending: g.messages.filter((m) => m.type === 'task' && m.status === 'pending').length,
    pendingKills: (g.pendingKills || []).filter((k) => k.status === 'processing' || k.status === 'pending').length,
    last: preview(last), lastTs: last ? last.ts : g.createdAt,
  };
}
function gamesSummary() {
  return Object.values(state.games).filter((g) => !g.demo).map(summarize).sort((a, b) => b.lastTs - a.lastTs);
}
// Real hosts get tagged for real games; a demo game only tags its own demo host.
const hostRoom = (g) => (g.demo ? 'demohost:' + g.code : 'hosts');

// ---------- server ----------
const app = express();
const server = http.createServer(app);
// Compress websocket traffic: game state is repetitive JSON and shrinks a lot.
const io = new Server(server, { maxHttpBufferSize: 1e6, perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 1, memLevel: 7 } } });

app.use(compression());
app.use(express.static(path.join(ROOT, 'public')));
// Secret host link: opens the normal page, which logs this phone in as a host.
app.get('/host/:key', (req, res) => {
  if (!isHostKey(req.params.key)) return res.redirect('/');
  res.set('Cache-Control', 'no-store').sendFile(path.join(ROOT, 'public', 'index.html'));
});
// Upload names are unique, so phones can cache photos and videos forever instead of re-downloading them.
// Demo links: /demo (pick one), /demo/imposter, /demo/crew, /demo/host
const sendPage = (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(ROOT, 'public', 'index.html'));
app.get('/demo', sendPage);
app.get('/demo/:kind', (req, res, next) => (DEMO_KINDS.includes(req.params.kind) ? sendPage(req, res) : next()));
app.use('/uploads', express.static(UPLOAD_DIR, { immutable: true, maxAge: '7d' }));

app.get('/qr.svg', async (req, res) => {
  const code = clean(req.query.code, 8).toUpperCase();
  const url = code ? `${BASE_URL}/?code=${code}` : BASE_URL;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

app.get('/api/info', (req, res) => res.json({ baseUrl: BASE_URL }));

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
function transcode(input, output) {
  return new Promise((resolve) => {
    // Small cloud servers are slow, so keep it quick: 480p, ultrafast, give up after 20s and use the original.
    const p = spawn('ffmpeg', ['-y', '-i', input, '-t', '15', '-vf', 'scale=-2:min(360\\,ih)',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output], { stdio: 'ignore' });
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve(false); }, 120000);
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
    p.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

const HAS_FFPROBE = spawnSync('ffprobe', ['-version']).status === 0;
function videoSeconds(file) {
  if (!HAS_FFPROBE) return null;
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 10000 });
  const d = parseFloat(r.stdout);
  return Number.isFinite(d) ? d : null; // webm recorded on a phone often has no duration; the host checks it then
}
const MIN_KILL_SECONDS = 5;

// Kill: an imposter uploads a 5+ second video of the victim. It goes to the hosts first;
// only after a host approves does the victim die, the video post in the chat, and the meeting start.
app.post('/api/kill', express.raw({ type: () => true, limit: '60mb' }), async (req, res) => {
  try {
    const code = clean(req.query.code, 8).toUpperCase();
    const g = state.games[code];
    const token = req.get('x-player-token');
    const killer = g && Object.values(g.players).find((p) => p.token === token);
    const victim = g && g.players[clean(req.query.victim, 40)];
    if (!g || !killer) return res.status(403).json({ error: 'Not in this game.' });
    if (g.status !== 'playing') return res.status(400).json({ error: 'You can only post a kill while the game is running (not during a vote).' });
    if (killer.role !== 'imposter') return res.status(400).json({ error: 'Only imposters can post kill videos.' });
    if (!isAlive(killer)) return res.status(400).json({ error: "You're out of the game." });
    if (!victim || !isAlive(victim) || victim.role === 'imposter') return res.status(400).json({ error: 'Pick a crewmate who is still alive.' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'No video received.' });
    g.pendingKills = g.pendingKills || [];
    if (g.pendingKills.some((k) => k.killerId === killer.id && (k.status === 'processing' || k.status === 'pending'))) {
      return res.status(400).json({ error: 'Your last kill is still waiting for a host to approve it.' });
    }

    const type = String(req.get('content-type') || '');
    // iPhone .mov files are H.264 in a QuickTime box; labelling them .mp4 lets Android play them too.
    const ext = type.includes('webm') ? 'webm' : 'mp4';
    const base = `${code}-${now()}-${id(3)}`;
    const raw = path.join(UPLOAD_DIR, `${base}.${ext}`);
    fs.writeFileSync(raw, req.body);
    const size = req.body.length;
    const secs = videoSeconds(raw);
    // the phone re-records clips in real time, which can shave a few tenths off
    if (secs !== null && secs < MIN_KILL_SECONDS - 0.5) {
      fs.unlink(raw, () => {});
      return res.status(400).json({ error: `The video has to be at least ${MIN_KILL_SECONDS} seconds long. Record a longer one.` });
    }

    const kill = {
      id: id(4), killerId: killer.id, killerName: killer.name, victimId: victim.id, victimName: victim.name,
      video: null, seconds: secs, status: 'processing', ts: now(),
    };
    g.pendingKills.push(kill);
    if (g.pendingKills.length > 30) g.pendingKills.splice(0, g.pendingKills.length - 30);
    io.to(hostRoom(g)).emit('host:tag', { kind: 'kill', code, name: killer.name, victimName: victim.name });
    broadcast(g, 'hosts'); save();
    res.json({ ok: true });

    // Phones already shrink videos to small mp4s; only convert big or webm files (webm doesn't play on iPhones).
    let file = `${base}.${ext}`;
    if (HAS_FFMPEG && (ext === 'webm' || size > 3e6)) {
      const out = path.join(UPLOAD_DIR, `${base}-web.mp4`);
      if (await transcode(raw, out)) file = `${base}-web.mp4`;
    }
    kill.video = `/uploads/${file}`;
    if (kill.status === 'processing') kill.status = 'pending';
    if (g.demo) demoKillReady(g, kill);
    broadcast(g, 'hosts'); save();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

// Task photo: a player uploads a photo tagged with one of their tasks; every host gets pinged.
app.post('/api/task-photo', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
  try {
    const code = clean(req.query.code, 8).toUpperCase();
    const g = state.games[code];
    const token = req.get('x-player-token');
    const p = g && Object.values(g.players).find((x) => x.token === token);
    if (!g || !p) return res.status(403).json({ error: 'Not in this game.' });
    if (!['playing', 'meeting'].includes(g.status)) return res.status(400).json({ error: 'You can only submit tasks while the game is running.' });
    const tid = clean(req.query.task, 20);
    const t = (p.tasks || []).find((x) => x.id === tid) || (g.sharedTasks || []).find((x) => x.id === tid);
    if (!t) return res.status(400).json({ error: 'Pick one of your tasks.' });
    if (t.done) return res.status(400).json({ error: t.shared ? `${t.doneBy || 'Someone'} already finished that shared task.` : 'That task is already done.' });
    if (t.pending) return res.status(400).json({ error: t.shared ? 'Someone already sent a photo for that shared task. Waiting for a host.' : 'That task is already waiting for a host.' });
    const type = String(req.get('content-type') || '');
    if (!type.startsWith('image/')) return res.status(400).json({ error: 'That file is not a photo.' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'No photo received.' });
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const file = `${code}-task-${now()}-${id(3)}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), req.body);
    const msg = { id: id(4), type: 'task', from: p.id, name: p.name, taskId: t.id, taskText: t.text, shared: !!t.shared, photo: `/uploads/${file}`, status: 'pending', ts: now() };
    t.pending = msg.id;
    if (t.shared) t.pendingBy = p.id;
    pushMsg(g, msg);
    io.to(hostRoom(g)).emit('host:tag', { code, msgId: msg.id, name: p.name, taskText: t.text });
    if (g.demo) demoTaskSubmitted(g, msg);
    broadcast(g); save();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

function reviewTask(g, m, approve, reviewer) {
  if (!['playing', 'meeting', 'reveal'].includes(g.status)) throw new Error('The game is not running.');
  if (!m) throw new Error('Submission not found.');
  if (m.status !== 'pending') throw new Error(`Already ${m.status} by ${m.reviewer || 'a host'}.`);
  const p = g.players[m.from];
  const t = m.shared ? (g.sharedTasks || []).find((x) => x.id === m.taskId) : p && p.tasks.find((x) => x.id === m.taskId);
  m.status = approve ? 'approved' : 'rejected';
  m.reviewer = reviewer;
  updMsg(g, m);
  if (t) {
    t.pending = null; t.pendingBy = null;
    if (approve) { t.done = true; if (t.shared) t.doneBy = m.name; }
  }
  if (approve) checkWin(g);
  broadcast(g); save();
}
function reviewKill(g, k, approve, reviewer) {
  if (!k || (k.status !== 'pending' && k.status !== 'processing')) throw new Error('That kill was already handled.');
  if (!approve) {
    k.status = 'rejected'; k.reviewer = reviewer;
    broadcast(g); save();
    return;
  }
  if (k.status === 'processing') throw new Error('The video is still processing. Try again in a moment.');
  if (g.status === 'meeting') throw new Error('A vote is happening. Approve this after the vote ends.');
  if (g.status !== 'playing') throw new Error('The game is not running.');
  const killer = g.players[k.killerId], victim = g.players[k.victimId];
  if (!killer || !isAlive(killer) || !victim || !isAlive(victim)) {
    k.status = 'invalid';
    broadcast(g); save();
    throw new Error(`Can't approve: ${!killer || !isAlive(killer) ? k.killerName : k.victimName} is already out.`);
  }
  k.status = 'approved'; k.reviewer = reviewer;
  victim.dead = true;
  pushMsg(g, { id: id(4), type: 'kill', from: 'anonymous', video: k.video, victimId: victim.id, text: `💀 ${victim.name} was killed!`, ts: now() });
  if (!checkWin(g)) {
    g.status = 'meeting';
    g.meeting = { id: id(4), victimId: victim.id, killerId: killer.id, video: k.video, votes: {}, startedAt: now() };
    sysMsg(g, '🚨 EMERGENCY MEETING — everyone still alive must vote someone off.');
  }
  broadcast(g); save();
}

// ---------- demo mode: /demo/imposter, /demo/crew, /demo/host ----------
// Each visit creates a private throwaway game full of bots. Demo games never show up for real hosts.
const DEMO_KINDS = ['imposter', 'crew', 'host'];
const BOT_NAMES = ['Ana', 'Ben', 'Cat', 'Dev', 'Eli', 'Fay'];
const BOT_HOST = 'Host Bot';
const BOT_LINES = [
  'anyone in the kitchen?', "I'm doing the porch light one", 'where did everyone go lol', 'just finished one 💪',
  'I saw Cat near the stairs…', 'not me btw', 'this house is way too big', "who's upstairs?",
  'on my way to the living room', 'Ben is acting kinda sus', 'stay in pairs!!', 'my tasks are all downstairs ugh',
];
const MEETING_LINES = ['it was Dev, I saw him', 'I was with Ana the whole time', 'skip? idk', 'Eli was alone upstairs', 'trust me I was doing tasks'];
const DEMO_PHOTOS = ['/demo/task1.jpg', '/demo/task2.jpg', '/demo/task3.jpg'];
const DEMO_TASKS = [
  { text: 'Demo: Turn on the porch light', shared: true },
  { text: 'Demo: Stack 5 cups into a pyramid in the kitchen', shared: true },
  { text: 'Demo: Arrange the couch pillows by color', shared: true },
  { text: 'Demo: Write your name on a sticky note on the fridge', shared: false },
  { text: 'Demo: Do 10 jumping jacks', shared: false },
];
const DEMO_MAX = 30;
const pick = (a) => a[crypto.randomInt(0, a.length)];
const later = (g, ms, fn) => setTimeout(() => { if (state.games[g.code] === g) { try { fn(); } catch (e) { /* game moved on */ } } }, ms);

function endDemo(code) { delete state.games[code]; outbox.delete(code); sentEpoch.delete(code); }

function createDemo(kind) {
  const demos = Object.values(state.games).filter((x) => x.demo).sort((a, b) => a.createdAt - b.createdAt);
  while (demos.length >= DEMO_MAX) endDemo(demos.shift().code);
  const code = newCode();
  const g = {
    code, createdAt: now(), status: 'lobby', players: {}, messages: [], meeting: null, lastResult: null,
    settings: { tasksPerPlayer: 3 }, round: 0, winner: null, winReason: '',
    demo: { kind, hostToken: id(16), lastChat: now(), lastKill: now(), lastSubmit: now(), voteDelay: {}, said: 0 },
  };
  state.games[code] = g;
  const add = (name, bot) => {
    const p = { id: id(5), token: id(16), name, joinedAt: now() + Object.keys(g.players).length, role: null, tasks: [], dead: false, ejected: false, connected: true, bot };
    g.players[p.id] = p; return p;
  };
  let you = null;
  if (kind !== 'host') you = add('You', false);
  const bots = BOT_NAMES.slice(0, kind === 'host' ? 6 : 4).map((n) => add(n, true));
  // imposter demo: you are the imposter. crew + host demos: one bot imposter (under 10 players means 1 imposter).
  const imposters = kind === 'imposter' ? [you.id] : [pick(bots).id];
  startGame(g, { imposters, pool: DEMO_TASKS });
  return { g, you };
}

function demoTaskSubmitted(g, msg) {
  if (g.demo.kind === 'host') return; // in the host demo, you approve everything yourself
  later(g, 5000, () => { if (msg.status === 'pending') reviewTask(g, msg, true, BOT_HOST); });
}
function demoKillReady(g, k) {
  if (g.demo.kind === 'host') return;
  const tryApprove = (wait) => later(g, wait, () => {
    if (k.status !== 'pending') return;
    if (g.status === 'meeting') return tryApprove(3000); // the bot host waits for the current vote to finish
    try { reviewKill(g, k, true, BOT_HOST); } catch {}
  });
  tryApprove(5000);
}

function botTick(g) {
  const d = g.demo, t = now();
  const ps = Object.values(g.players);
  const bots = ps.filter((p) => p.bot && isAlive(p));
  if (g.status === 'playing') {
    // small talk
    if (t - d.lastChat > 16000 && d.said < 30 && bots.length && crypto.randomInt(0, 3) === 0) {
      const b = pick(bots); d.lastChat = t; d.said++;
      pushMsg(g, { id: id(4), type: 'chat', from: b.id, name: b.name, text: pick(BOT_LINES), ts: t });
      broadcast(g, 'msgs');
    }
    // bot crewmates submit task photos (slowly, so you have time to look around)
    const every = d.kind === 'host' ? 11000 : 22000;
    const waiting = g.messages.filter((m) => m.type === 'task' && m.status === 'pending').length;
    if (t - d.lastSubmit > every && t - d.startedAt > 9000 && waiting < 3) {
      const openShared = (g.sharedTasks || []).filter((x) => !x.done && !x.pending);
      const cands = ps.filter((p) => p.bot && p.role === 'crew' && (openShared.length || p.tasks.some((x) => !x.done && !x.pending)));
      if (cands.length) {
        const p = pick(cands);
        const mine = p.tasks.filter((x) => !x.done && !x.pending);
        const task = openShared.length && (!mine.length || crypto.randomInt(0, 2) === 0) ? pick(openShared) : pick(mine);
        d.lastSubmit = t;
        const msg = { id: id(4), type: 'task', from: p.id, name: p.name, taskId: task.id, taskText: task.text, shared: !!task.shared, photo: pick(DEMO_PHOTOS), status: 'pending', ts: t };
        task.pending = msg.id;
        if (task.shared) task.pendingBy = p.id;
        pushMsg(g, msg);
        io.to(hostRoom(g)).emit('host:tag', { code: g.code, msgId: msg.id, name: p.name, taskText: task.text });
        demoTaskSubmitted(g, msg);
        broadcast(g);
      }
    }
    // a bot imposter strikes now and then (crew + host demos)
    const killEvery = d.kind === 'host' ? 30000 : 45000;
    const killers = bots.filter((p) => p.role === 'imposter');
    const open = (g.pendingKills || []).some((k) => k.status === 'pending' || k.status === 'processing');
    if (killers.length && !open && t - d.lastKill > killEvery && t - d.startedAt > 20000) {
      const victims = ps.filter((p) => p.role === 'crew' && isAlive(p) && p.bot);
      if (victims.length) {
        const killer = pick(killers), victim = pick(victims);
        d.lastKill = t;
        const k = { id: id(4), killerId: killer.id, killerName: killer.name, victimId: victim.id, victimName: victim.name, video: '/demo/kill.mp4', seconds: 6, status: 'pending', ts: t };
        g.pendingKills = g.pendingKills || [];
        g.pendingKills.push(k);
        io.to(hostRoom(g)).emit('host:tag', { kind: 'kill', code: g.code, name: killer.name, victimName: victim.name });
        demoKillReady(g, k);
        broadcast(g, 'hosts');
      }
    }
  }
  if (g.status === 'meeting' && g.meeting) {
    const m = g.meeting;
    if (d.voteFor !== m.id) { d.voteFor = m.id; d.voteDelay = {}; d.meetingTalk = 0; }
    for (const b of bots) {
      if (m.votes[b.id]) continue;
      if (!d.voteDelay[b.id]) d.voteDelay[b.id] = m.startedAt + 4000 + crypto.randomInt(0, 9000);
      if (t < d.voteDelay[b.id]) continue;
      // bots never vote you out in the player demos, so you can keep testing
      const choices = ps.filter((p) => isAlive(p) && p.id !== b.id && (d.kind === 'host' || p.bot));
      if (!choices.length) continue;
      m.votes[b.id] = pick(choices).id;
    }
    if (d.meetingTalk < 2 && bots.length && t - m.startedAt > 2500 * (d.meetingTalk + 1)) {
      const b = pick(bots); d.meetingTalk++;
      pushMsg(g, { id: id(4), type: 'chat', from: b.id, name: b.name, text: pick(MEETING_LINES), ts: t });
    }
    // the bot host closes a vote you forgot about
    if (d.kind !== 'host' && t - m.startedAt > 60000) resolveMeeting(g, true);
    else maybeAutoResolve(g);
    broadcast(g); save();
  }
}
setInterval(() => {
  for (const g of Object.values(state.games)) {
    if (!g.demo) continue;
    if (now() - g.createdAt > 60 * 60 * 1000) { endDemo(g.code); continue; } // demos expire after an hour
    try { botTick(g); } catch (e) { console.error('demo bot', e.message); }
  }
}, 1500);

// ---------- sockets ----------
function socketsIn(room) {
  const ids = io.sockets.adapter.rooms.get(room);
  return ids ? [...ids].map((sid) => io.sockets.sockets.get(sid)).filter(Boolean) : [];
}
function whoOf(socket) {
  if (socket.data.isHost || socket.data.demoCode) return { kind: 'host' };
  if (socket.data.playerId) return { kind: 'player', playerId: socket.data.playerId };
  return { kind: 'none' };
}
// Changes are batched (~60ms) so a burst of votes or messages becomes one update per phone.
// 'all'   = game state changed: every phone gets fresh state (plus any new chat)
// 'hosts' = only host screens need refreshing (someone's connection dropped/returned)
// 'msgs'  = only new/changed chat messages: one small packet to the room, no state resend
const pendingFlush = new Map(); // code -> Set of levels
const sentEpoch = new Map();    // code -> msgEpoch every phone has
function broadcast(g, level = 'all') {
  let set = pendingFlush.get(g.code);
  if (!set) { set = new Set(); pendingFlush.set(g.code, set); setTimeout(() => flush(g.code), 60); }
  set.add(level);
}
function flush(code) {
  const levels = pendingFlush.get(code) || new Set();
  pendingFlush.delete(code);
  const g = state.games[code];
  if (!g) return;
  const room = 'game:' + code;
  const epoch = g.msgEpoch || 0;
  const full = sentEpoch.get(code) !== epoch; // chat history was reset: everyone gets the full chat once
  const toAll = levels.has('all') || full;
  if (toAll || levels.has('hosts')) {
    for (const s of socketsIn(room)) {
      const who = whoOf(s);
      if (!toAll && who.kind !== 'host') continue;
      if (who.kind === 'player' && !g.players[who.playerId]) continue;
      s.emit('state', viewFor(g, who, full));
    }
  }
  if (toAll) sentEpoch.set(code, epoch);
  const b = outbox.get(code);
  if (b && (b.add.length || b.upd.length)) {
    if (!full) io.to(room).emit('msgs', { code, epoch, add: b.add, upd: b.upd });
    outbox.delete(code);
  }
  if (g.demo) io.to(hostRoom(g)).emit('games', [summarize(g)]);
  else io.to('hosts').emit('games', gamesSummary());
}
function sendFull(socket, g) { socket.emit('state', viewFor(g, whoOf(socket), true)); }

function requireHost(socket) {
  if (!socket.data.isHost) throw new Error('Host login required.');
}
function gameOr(code) {
  const g = state.games[clean(code, 8).toUpperCase()];
  if (!g) throw new Error('No game with that code.');
  return g;
}
// Real hosts can run any game; a demo host can only run their own demo game.
function hostGame(socket, code) {
  const g = gameOr(code);
  if (socket.data.isHost || (socket.data.demoCode && socket.data.demoCode === g.code)) return g;
  throw new Error('Host login required.');
}
function hostName(socket) { return socket.data.hostName || 'Host'; }

function on(socket, event, fn) {
  socket.on(event, (payload, ack) => {
    try {
      const r = fn(payload || {});
      if (typeof ack === 'function') ack({ ok: true, ...(r || {}) });
    } catch (e) {
      if (typeof ack === 'function') ack({ ok: false, error: e.message });
    }
  });
}

function setConnected(socket, val) {
  const g = socket.data.code && state.games[socket.data.code];
  const p = g && g.players[socket.data.playerId];
  if (p) { p.connected = val; broadcast(g, 'hosts'); }
}

io.on('connection', (socket) => {
  // ---- identity ----
  on(socket, 'host:login', ({ key, name }) => {
    if (!isHostKey(key)) throw new Error('That host link is not valid anymore.');
    socket.data.isHost = true;
    socket.data.hostName = clean(name, 20) || 'Host';
    socket.join('hosts');
    socket.emit('games', gamesSummary());
    socket.emit('taskPool', state.taskPool);
    return { name: socket.data.hostName };
  });

  on(socket, 'player:resume', ({ code, token }) => {
    const g = gameOr(code);
    const p = Object.values(g.players).find((x) => x.token === token);
    if (!p) throw new Error('Not in this game anymore.');
    socket.data.code = g.code; socket.data.playerId = p.id;
    socket.join('game:' + g.code);
    p.connected = true;
    sendFull(socket, g);
    broadcast(g, 'hosts');
    return { playerId: p.id };
  });

  on(socket, 'player:join', ({ code, name }) => {
    const g = gameOr(code);
    name = clean(name, 16);
    if (!name) throw new Error('Enter your name.');
    if (g.status !== 'lobby') throw new Error('That game already started. Wait for the next round.');
    if (Object.values(g.players).some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error('Someone already has that name.');
    if (Object.keys(g.players).length >= 150) throw new Error('Lobby is full.');
    const p = { id: id(5), token: id(16), name, joinedAt: now(), role: null, tasks: [], dead: false, ejected: false, connected: true };
    g.players[p.id] = p;
    socket.data.code = g.code; socket.data.playerId = p.id;
    socket.join('game:' + g.code);
    sysMsg(g, `${name} joined.`);
    sendFull(socket, g);
    broadcast(g); save();
    return { token: p.token, playerId: p.id, code: g.code };
  });

  on(socket, 'player:leave', () => {
    const g = state.games[socket.data.code];
    const p = g && g.players[socket.data.playerId];
    if (!p) return;
    if (g.status !== 'lobby' && g.status !== 'ended') throw new Error("You can't leave mid-game.");
    delete g.players[p.id];
    sysMsg(g, `${p.name} left.`);
    socket.leave('game:' + g.code);
    socket.data.code = null; socket.data.playerId = null;
    broadcast(g); save();
  });

  // ---- chat & voting ----
  on(socket, 'chat', ({ code, text }) => {
    const g = gameOr(code || socket.data.code);
    text = clean(text, 400);
    if (!text) return;
    const who = whoOf(socket);
    if (who.kind === 'host') {
      pushMsg(g, { id: id(4), type: 'chat', host: true, name: hostName(socket), text, ts: now() });
    } else if (who.kind === 'player' && socket.data.code === g.code) {
      const p = g.players[who.playerId];
      if (!p) throw new Error('Not in this game.');
      const inPlay = !['lobby', 'ended'].includes(g.status);
      if (inPlay && !isAlive(p)) throw new Error("You're out — you can read the chat but can't send messages.");
      pushMsg(g, { id: id(4), type: 'chat', from: p.id, name: p.name, text, ts: now() });
    } else throw new Error('Not in this game.');
    broadcast(g, 'msgs'); save();
  });

  on(socket, 'vote', ({ targetId }) => {
    const g = gameOr(socket.data.code);
    const p = g.players[socket.data.playerId];
    if (!g.meeting) throw new Error('No vote is happening.');
    if (!p || !isAlive(p)) throw new Error("You're out, so you can't vote.");
    if (g.meeting.votes[p.id]) throw new Error('You already voted.');
    const t = g.players[targetId];
    if (!t || !isAlive(t)) throw new Error('Pick someone still in the game.');
    if (t.id === p.id) throw new Error("You can't vote for yourself.");
    g.meeting.votes[p.id] = t.id;
    maybeAutoResolve(g);
    broadcast(g); save();
  });

  // ---- host controls ----
  on(socket, 'host:createGame', () => {
    requireHost(socket);
    const code = newCode();
    state.games[code] = {
      code, createdAt: now(), status: 'lobby', players: {}, messages: [], meeting: null, lastResult: null,
      settings: { tasksPerPlayer: Number(config.defaultTasksPerPlayer) || 4 }, round: 0, winner: null, winReason: '',
    };
    sysMsg(state.games[code], `Lobby ${code} created. Scan the QR code or enter the code to join.`);
    io.to('hosts').emit('games', gamesSummary());
    save();
    return { code };
  });

  on(socket, 'host:view', ({ code }) => {
    const g = hostGame(socket, code);
    for (const room of socket.rooms) if (room.startsWith('game:')) socket.leave(room);
    socket.join('game:' + g.code);
    socket.emit('state', viewFor(g, { kind: 'host' }, true));
  });

  on(socket, 'host:leaveView', () => {
    for (const room of socket.rooms) if (room.startsWith('game:')) socket.leave(room);
  });

  on(socket, 'host:start', ({ code }) => {
    const g = hostGame(socket, code);
    if (g.status !== 'lobby' && g.status !== 'ended') throw new Error('Game already running.');
    startGame(g);
    broadcast(g); save();
  });

  on(socket, 'host:toggleTask', ({ code, playerId, taskId }) => {
    const g = hostGame(socket, code);
    if (!['playing', 'meeting', 'reveal'].includes(g.status)) throw new Error('Game is not running.');
    const p = g.players[playerId];
    const t = playerId ? p && p.tasks.find((x) => x.id === taskId) : (g.sharedTasks || []).find((x) => x.id === taskId);
    if (!t) throw new Error('Task not found.');
    t.done = !t.done;
    if (t.shared) t.doneBy = t.done ? hostName(socket) + ' (host)' : null;
    if (t.pending) {
      const m = g.messages.find((x) => x.id === t.pending);
      if (m && t.done) { m.status = 'approved'; m.reviewer = hostName(socket); updMsg(g, m); if (t.shared) t.doneBy = m.name; }
      t.pending = null; t.pendingBy = null;
    }
    checkWin(g);
    broadcast(g); save();
  });

  on(socket, 'host:review', ({ code, msgId, approve }) => {
    const g = hostGame(socket, code);
    if (!['playing', 'meeting', 'reveal'].includes(g.status)) throw new Error('The game is not running.');
    const m = g.messages.find((x) => x.id === msgId && x.type === 'task');
    reviewTask(g, m, approve, hostName(socket));
  });

  on(socket, 'host:reviewKill', ({ code, killId, approve }) => {
    const g = hostGame(socket, code);
    const k = (g.pendingKills || []).find((x) => x.id === killId);
    reviewKill(g, k, approve, hostName(socket));
  });

  on(socket, 'host:endVote', ({ code }) => {
    const g = hostGame(socket, code);
    if (!g.meeting) throw new Error('No vote is happening.');
    resolveMeeting(g, true);
    broadcast(g); save();
  });

  on(socket, 'host:endGame', ({ code }) => {
    const g = hostGame(socket, code);
    if (g.status === 'lobby') throw new Error('Game has not started.');
    g.status = 'ended'; g.meeting = null; g.winner = null; g.winReason = 'The host ended the game.'; g.pendingKills = [];
    sysMsg(g, 'The host ended the game.');
    broadcast(g); save();
  });

  on(socket, 'host:toLobby', ({ code }) => {
    const g = hostGame(socket, code);
    g.status = 'lobby'; g.meeting = null; g.lastResult = null; g.winner = null; g.winReason = ''; g.pendingKills = [];
    for (const p of Object.values(g.players)) { p.role = null; p.tasks = []; p.dead = false; p.ejected = false; }
    g.sharedTasks = [];
    resetMsgs(g);
    sysMsg(g, 'Back in the lobby. New players can join now.');
    broadcast(g); save();
  });

  on(socket, 'host:kick', ({ code, playerId }) => {
    const g = hostGame(socket, code);
    const p = g.players[playerId];
    if (!p) throw new Error('Player not found.');
    if (g.status !== 'lobby' && g.status !== 'ended') throw new Error('You can only remove players in the lobby.');
    delete g.players[playerId];
    sysMsg(g, `${p.name} was removed by a host.`);
    for (const s of socketsIn('game:' + g.code)) if (s.data.playerId === playerId) { s.emit('kicked'); s.leave('game:' + g.code); s.data.playerId = null; }
    broadcast(g); save();
  });

  on(socket, 'host:deleteGame', ({ code }) => {
    const g = hostGame(socket, code);
    for (const s of socketsIn('game:' + g.code)) { s.emit('kicked'); s.leave('game:' + g.code); }
    delete state.games[g.code];
    io.to('hosts').emit('games', gamesSummary());
    save();
  });

  on(socket, 'host:settings', ({ code, tasksPerPlayer }) => {
    const g = hostGame(socket, code);
    g.settings.tasksPerPlayer = Math.max(1, Math.min(20, Number(tasksPerPlayer) || 4));
    broadcast(g); save();
  });

  on(socket, 'host:setTaskPool', ({ tasks }) => {
    requireHost(socket);
    const list = (Array.isArray(tasks) ? tasks : String(tasks || '').split('\n')).map(parseTask).filter((t) => t.text).slice(0, 200);
    if (!list.length) throw new Error('Add at least one task.');
    state.taskPool = list;
    fs.writeFile(TASKS_FILE, taskFileText(list), () => {});
    io.to('hosts').emit('taskPool', state.taskPool);
    save();
    return { count: list.length, shared: list.filter((t) => t.shared).length };
  });

  on(socket, 'host:logout', () => {
    socket.data.isHost = false;
    socket.leave('hosts');
  });

  // ---- demo mode ----
  on(socket, 'demo:start', ({ kind }) => {
    if (!DEMO_KINDS.includes(kind)) throw new Error('Unknown demo.');
    const { g, you } = createDemo(kind);
    if (kind === 'host') {
      socket.data.demoCode = g.code; socket.data.hostName = 'You';
      socket.join(hostRoom(g));
      socket.emit('games', [summarize(g)]);
      broadcast(g);
      return { kind, code: g.code, demoToken: g.demo.hostToken };
    }
    socket.data.code = g.code; socket.data.playerId = you.id;
    socket.join('game:' + g.code);
    sendFull(socket, g);
    return { kind, code: g.code, token: you.token, playerId: you.id };
  });
  on(socket, 'demo:hostResume', ({ code, demoToken }) => {
    const g = gameOr(code);
    if (!g.demo || g.demo.hostToken !== demoToken) throw new Error('That demo has ended.');
    socket.data.demoCode = g.code; socket.data.hostName = 'You';
    socket.join(hostRoom(g));
    socket.emit('games', [summarize(g)]);
    return { code: g.code };
  });
  on(socket, 'demo:end', ({ code, token, demoToken }) => {
    const g = state.games[clean(code, 8).toUpperCase()];
    if (!g || !g.demo) return;
    const you = Object.values(g.players).find((p) => !p.bot);
    if ((demoToken && demoToken === g.demo.hostToken) || (token && you && token === you.token)) endDemo(g.code);
  });

  // A phone that missed an update (or saw a history reset) asks for the full chat again.
  on(socket, 'resync', () => {
    const g = state.games[socket.data.code] || ((socket.data.isHost || socket.data.demoCode) && [...socket.rooms].find((r) => r.startsWith('game:')) && state.games[[...socket.rooms].find((r) => r.startsWith('game:')).slice(5)]);
    if (g) sendFull(socket, g);
  });

  socket.on('disconnect', () => setConnected(socket, false));
});

server.listen(PORT, '0.0.0.0', async () => {
  const qr = await QRCode.toString(BASE_URL, { type: 'terminal', small: true });
  console.log('\n  SUS — real-life imposter game is running!\n');
  console.log(qr);
  console.log(`  Players: scan the QR or open  ${BASE_URL}`);
  console.log(`  Host link (keep it secret — share only with hosts):\n  ${HOST_URL}\n`);
  console.log(`  Video conversion: ${HAS_FFMPEG ? 'ON (ffmpeg found)' : 'off — install ffmpeg so iPhone videos play on Android too'}`);
  if (!process.env.RENDER) console.log('  Everyone must be on the same Wi-Fi. Keep this window open while you play.\n');
});
