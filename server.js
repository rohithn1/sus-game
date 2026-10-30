// SUS — a real-life imposter game for your house.
// Run: npm install && npm start   (everyone must be on the same Wi-Fi)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
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
function loadTaskFile() {
  try {
    const lines = fs.readFileSync(TASKS_FILE, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.length) return lines;
  } catch {}
  return BUILTIN_TASKS;
}
const DEFAULT_TASKS = loadTaskFile();

// ---------- state (persisted to data/state.json) ----------
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let state = { games: {}, taskPool: DEFAULT_TASKS.slice() };
try {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...state, ...loaded, taskPool: DEFAULT_TASKS.slice() };
    for (const g of Object.values(state.games)) {
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
  }, 400);
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

function sysMsg(g, text, extra = {}) {
  g.messages.push({ id: id(4), type: 'system', text, ts: now(), ...extra });
  if (g.messages.length > 300) g.messages.splice(0, g.messages.length - 300);
}

function crewProgress(g) {
  let done = 0, total = 0;
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
  g.winner = winner;
  g.winReason = reason;
  sysMsg(g, winner === 'crew' ? `🎉 CREW WINS — ${reason}` : `🔪 IMPOSTERS WIN — ${reason}`);
  return true;
}

// ---------- game actions ----------
function startGame(g) {
  const ps = plist(g);
  if (ps.length < 3) throw new Error('Need at least 3 players to start.');
  const pool = state.taskPool.filter(Boolean);
  if (pool.length === 0) throw new Error('The task list is empty. Add tasks first.');
  const nImp = ps.length <= 5 ? 1 : 2;
  const order = shuffle(ps.map((p) => p.id));
  const imps = new Set(order.slice(0, nImp));
  const per = Math.max(1, Math.min(g.settings.tasksPerPlayer, pool.length));
  for (const p of ps) {
    p.role = imps.has(p.id) ? 'imposter' : 'crew';
    p.dead = false; p.ejected = false;
    p.tasks = shuffle(pool).slice(0, per).map((text) => ({ id: id(3), text, done: false }));
  }
  g.round = (g.round || 0) + 1;
  g.messages = [];
  g.meeting = null; g.lastResult = null; g.winner = null; g.winReason = '';
  g.status = 'reveal';
  g.revealStartedAt = now();
  sysMsg(g, `Game started with ${ps.length} players and ${nImp} imposter${nImp > 1 ? 's' : ''}. Split up and do your tasks! Show a host your photo to get a task approved.`);
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
function viewFor(g, who) {
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
    messages: g.messages, progress: crewProgress(g),
    settings: g.settings, winner: g.winner, winReason: g.winReason,
    lastResult: g.lastResult,
    joinUrl: `${BASE_URL}/?code=${g.code}`,
    serverNow: now(),
    revealAgoMs: g.status === 'reveal' ? now() - g.revealStartedAt : null,
    isHost,
  };
  if (g.meeting) {
    const m = g.meeting;
    const voters = Object.values(g.players).filter(isAlive);
    v.meeting = {
      id: m.id, victimId: m.victimId, victimName: g.players[m.victimId]?.name, video: m.video,
      votedIds: Object.keys(m.votes), voterCount: voters.length,
      myVote: me ? m.votes[me.id] || null : null,
    };
  }
  if (me) {
    const partners = me.role === 'imposter'
      ? Object.values(g.players).filter((p) => p.role === 'imposter' && p.id !== me.id).map((p) => p.name)
      : [];
    v.me = {
      id: me.id, name: me.name, role: g.status === 'lobby' ? null : me.role, partners,
      tasks: me.tasks || [], alive: isAlive(me), dead: !!me.dead, ejected: !!me.ejected,
    };
  }
  return v;
}

function gamesSummary() {
  return Object.values(state.games)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((g) => ({ code: g.code, status: g.status, players: Object.keys(g.players).length, createdAt: g.createdAt }));
}

// ---------- server ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.static(path.join(ROOT, 'public')));
// Secret host link: opens the normal page, which logs this phone in as a host.
app.get('/host/:key', (req, res) => {
  if (!isHostKey(req.params.key)) return res.redirect('/');
  res.set('Cache-Control', 'no-store').sendFile(path.join(ROOT, 'public', 'index.html'));
});
app.use('/uploads', express.static(UPLOAD_DIR));

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
    const p = spawn('ffmpeg', ['-y', '-i', input, '-t', '7', '-vf', 'scale=-2:min(720\\,ih)',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output], { stdio: 'ignore' });
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve(false); }, 45000);
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
    p.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

// Kill: imposter uploads a ~5 second video of the victim.
app.post('/api/kill', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
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

    const type = String(req.get('content-type') || '');
    // iPhone .mov files are H.264 in a QuickTime box; labelling them .mp4 lets Android play them too.
    const ext = type.includes('webm') ? 'webm' : 'mp4';
    const base = `${code}-${now()}-${id(3)}`;
    const raw = path.join(UPLOAD_DIR, `${base}.${ext}`);
    fs.writeFileSync(raw, req.body);
    let file = `${base}.${ext}`;
    if (HAS_FFMPEG) {
      const out = path.join(UPLOAD_DIR, `${base}-web.mp4`);
      if (await transcode(raw, out)) file = `${base}-web.mp4`;
    }

    // re-check after the upload finished
    if (g.status !== 'playing' || !isAlive(victim) || !isAlive(killer)) {
      return res.status(409).json({ error: 'The game changed while uploading. Try again.' });
    }
    victim.dead = true;
    const video = `/uploads/${file}`;
    g.messages.push({ id: id(4), type: 'kill', video, victimId: victim.id, text: `💀 ${victim.name} was killed!`, ts: now() });
    if (!checkWin(g)) {
      g.status = 'meeting';
      g.meeting = { id: id(4), victimId: victim.id, killerId: killer.id, video, votes: {}, startedAt: now() };
      sysMsg(g, '🚨 EMERGENCY MEETING — everyone still alive must vote someone off.');
    }
    broadcast(g); save();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

// ---------- sockets ----------
function socketsIn(room) {
  const ids = io.sockets.adapter.rooms.get(room);
  return ids ? [...ids].map((sid) => io.sockets.sockets.get(sid)).filter(Boolean) : [];
}
function whoOf(socket) {
  if (socket.data.isHost) return { kind: 'host' };
  if (socket.data.playerId) return { kind: 'player', playerId: socket.data.playerId };
  return { kind: 'none' };
}
function broadcast(g) {
  for (const s of socketsIn('game:' + g.code)) {
    const who = whoOf(s);
    if (who.kind === 'player' && !g.players[who.playerId]) continue;
    s.emit('state', viewFor(g, who));
  }
  io.to('hosts').emit('games', gamesSummary());
}

function requireHost(socket) {
  if (!socket.data.isHost) throw new Error('Host login required.');
}
function gameOr(code) {
  const g = state.games[clean(code, 8).toUpperCase()];
  if (!g) throw new Error('No game with that code.');
  return g;
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
  if (p) { p.connected = val; broadcast(g); }
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
    broadcast(g);
    return { playerId: p.id };
  });

  on(socket, 'player:join', ({ code, name }) => {
    const g = gameOr(code);
    name = clean(name, 16);
    if (!name) throw new Error('Enter your name.');
    if (g.status !== 'lobby') throw new Error('That game already started. Wait for the next round.');
    if (Object.values(g.players).some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error('Someone already has that name.');
    if (Object.keys(g.players).length >= 30) throw new Error('Lobby is full.');
    const p = { id: id(5), token: id(16), name, joinedAt: now(), role: null, tasks: [], dead: false, ejected: false, connected: true };
    g.players[p.id] = p;
    socket.data.code = g.code; socket.data.playerId = p.id;
    socket.join('game:' + g.code);
    sysMsg(g, `${name} joined.`);
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
      g.messages.push({ id: id(4), type: 'chat', host: true, name: hostName(socket), text, ts: now() });
    } else if (who.kind === 'player' && socket.data.code === g.code) {
      const p = g.players[who.playerId];
      if (!p) throw new Error('Not in this game.');
      const inPlay = !['lobby', 'ended'].includes(g.status);
      if (inPlay && !isAlive(p)) throw new Error("You're out — you can read the chat but can't send messages.");
      g.messages.push({ id: id(4), type: 'chat', from: p.id, name: p.name, text, ts: now() });
    } else throw new Error('Not in this game.');
    if (g.messages.length > 300) g.messages.splice(0, g.messages.length - 300);
    broadcast(g); save();
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
    requireHost(socket);
    const g = gameOr(code);
    for (const room of socket.rooms) if (room.startsWith('game:')) socket.leave(room);
    socket.join('game:' + g.code);
    socket.emit('state', viewFor(g, { kind: 'host' }));
  });

  on(socket, 'host:leaveView', () => {
    for (const room of socket.rooms) if (room.startsWith('game:')) socket.leave(room);
  });

  on(socket, 'host:start', ({ code }) => {
    requireHost(socket);
    const g = gameOr(code);
    if (g.status !== 'lobby' && g.status !== 'ended') throw new Error('Game already running.');
    startGame(g);
    broadcast(g); save();
  });

  on(socket, 'host:toggleTask', ({ code, playerId, taskId }) => {
    requireHost(socket);
    const g = gameOr(code);
    if (!['playing', 'meeting', 'reveal'].includes(g.status)) throw new Error('Game is not running.');
    const p = g.players[playerId];
    const t = p && p.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error('Task not found.');
    t.done = !t.done;
    checkWin(g);
    broadcast(g); save();
  });

  on(socket, 'host:endVote', ({ code }) => {
    requireHost(socket);
    const g = gameOr(code);
    if (!g.meeting) throw new Error('No vote is happening.');
    resolveMeeting(g, true);
    broadcast(g); save();
  });

  on(socket, 'host:endGame', ({ code }) => {
    requireHost(socket);
    const g = gameOr(code);
    if (g.status === 'lobby') throw new Error('Game has not started.');
    g.status = 'ended'; g.meeting = null; g.winner = null; g.winReason = 'The host ended the game.';
    sysMsg(g, 'The host ended the game.');
    broadcast(g); save();
  });

  on(socket, 'host:toLobby', ({ code }) => {
    requireHost(socket);
    const g = gameOr(code);
    g.status = 'lobby'; g.meeting = null; g.lastResult = null; g.winner = null; g.winReason = '';
    for (const p of Object.values(g.players)) { p.role = null; p.tasks = []; p.dead = false; p.ejected = false; }
    g.messages = [];
    sysMsg(g, 'Back in the lobby. New players can join now.');
    broadcast(g); save();
  });

  on(socket, 'host:kick', ({ code, playerId }) => {
    requireHost(socket);
    const g = gameOr(code);
    const p = g.players[playerId];
    if (!p) throw new Error('Player not found.');
    if (g.status !== 'lobby' && g.status !== 'ended') throw new Error('You can only remove players in the lobby.');
    delete g.players[playerId];
    sysMsg(g, `${p.name} was removed by a host.`);
    for (const s of socketsIn('game:' + g.code)) if (s.data.playerId === playerId) { s.emit('kicked'); s.leave('game:' + g.code); s.data.playerId = null; }
    broadcast(g); save();
  });

  on(socket, 'host:deleteGame', ({ code }) => {
    requireHost(socket);
    const g = gameOr(code);
    for (const s of socketsIn('game:' + g.code)) { s.emit('kicked'); s.leave('game:' + g.code); }
    delete state.games[g.code];
    io.to('hosts').emit('games', gamesSummary());
    save();
  });

  on(socket, 'host:settings', ({ code, tasksPerPlayer }) => {
    requireHost(socket);
    const g = gameOr(code);
    g.settings.tasksPerPlayer = Math.max(1, Math.min(20, Number(tasksPerPlayer) || 4));
    broadcast(g); save();
  });

  on(socket, 'host:setTaskPool', ({ tasks }) => {
    requireHost(socket);
    const list = (Array.isArray(tasks) ? tasks : String(tasks || '').split('\n')).map((t) => clean(t, 140)).filter(Boolean).slice(0, 200);
    if (!list.length) throw new Error('Add at least one task.');
    state.taskPool = list;
    fs.writeFile(TASKS_FILE, '# One task per line. Lines starting with # are ignored.\n' + list.join('\n') + '\n', () => {});
    io.to('hosts').emit('taskPool', state.taskPool);
    save();
    return { count: list.length };
  });

  on(socket, 'host:logout', () => {
    socket.data.isHost = false;
    socket.leave('hosts');
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
