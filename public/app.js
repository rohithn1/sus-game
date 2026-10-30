/* SUS — phone client */
(() => {
  const socket = io({ transports: ['websocket', 'polling'] });
  const $ = (id) => document.getElementById(id);
  // Demo links (/demo, /demo/imposter, /demo/crew, /demo/host) run throwaway bot games
  // and never touch this phone's real host or player session.
  const demoMatch = location.pathname.match(/^\/demo(?:\/(imposter|crew|host))?\/?$/);
  const demoPicker = !!demoMatch && !demoMatch[1];
  const demoKind = demoMatch ? demoMatch[1] || null : null;
  const LOCKED = demoMatch ? new Set(['sus:player', 'sus:host']) : new Set();
  const LS = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { if (LOCKED.has(k)) return; try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { if (LOCKED.has(k)) return; try { localStorage.removeItem(k); } catch {} },
  };
  let demo = null; // { kind, code, token, playerId } or { kind: 'host', code, demoToken }
  if (demoKind) {
    try { demo = JSON.parse(sessionStorage.getItem('sus:demo')); } catch {}
    if (demo && demo.kind !== demoKind) { socket.emit('demo:end', demo); demo = null; }
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  let host = LS.get('sus:host');          // { key, name }
  if (host && !host.key) { LS.del('sus:host'); host = null; }
  // Arriving through the secret host link: remember the key, then hide it from the address bar.
  const hostPath = location.pathname.match(/^\/host\/([^/?#]+)/);
  if (hostPath) {
    host = { key: decodeURIComponent(hostPath[1]), name: (host && host.name) || '' };
    LS.set('sus:host', host);
    history.replaceState(null, '', '/');
  }
  let player = LS.get('sus:player');      // { code, token, playerId }
  if (demoMatch) { host = null; player = null; document.body.classList.add('demo'); }
  let currentCode = null;
  let view = null;
  let tab = 'chat';
  let showRoles = false;
  let justOpened = false;
  let renderedKey = null;
  const rendered = new Map();            // message id -> { node, sig }
  let gamesList = [];
  let checklistOpen = LS.get('sus:clOpen') !== false;
  let shownMeetingId = null;
  let shownMeetingVideo;
  let meetingHidden = false;
  let overlayBusy = false;
  let revealTimer = null;
  let unreadChat = false;

  const urlCode = (new URLSearchParams(location.search).get('code') || '').toUpperCase().slice(0, 4);
  if (urlCode) $('join-code').value = urlCode;
  if (player && urlCode && player.code !== urlCode && !host) { LS.del('sus:player'); player = null; }

  // ---------- screens ----------
  const SCREENS = ['join', 'hostlogin', 'hosthome', 'game', 'demo'];
  function show(name) {
    for (const s of SCREENS) $('scr-' + s).classList.toggle('hidden', s !== name);
    if (name !== 'game') for (const o of ['ov-meeting', 'ov-result', 'ov-reveal', 'ov-kill', 'ov-peek']) $(o).classList.add('hidden');
  }
  let toastTimer;
  function toast(msg, ms = 2800, onClick) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    t.classList.toggle('clickable', !!onClick);
    t.onclick = () => { t.classList.add('hidden'); if (onClick) onClick(); };
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }
  const call = (event, payload) => new Promise((res) => socket.emit(event, payload, (r) => res(r || { ok: false, error: 'No response' })));

  // ---------- sound + vibration ----------
  let actx = null;
  function unlockAudio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  function alarm() {
    try { navigator.vibrate && navigator.vibrate([500, 150, 500, 150, 900]); } catch {}
    if (!actx) return;
    try {
      const t0 = actx.currentTime + 0.02;
      const o = actx.createOscillator(); const g = actx.createGain();
      o.type = 'square'; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.05);
      for (let i = 0; i < 6; i++) { o.frequency.setValueAtTime(900, t0 + i * 0.4); o.frequency.linearRampToValueAtTime(450, t0 + i * 0.4 + 0.38); }
      g.gain.setValueAtTime(0.3, t0 + 2.3); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.5);
      o.start(t0); o.stop(t0 + 2.6);
    } catch {}
  }
  function chime() {
    if (!actx) return;
    try {
      const t0 = actx.currentTime + 0.02;
      [523, 659, 784].forEach((f, i) => {
        const o = actx.createOscillator(); const g = actx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0.0001, t0 + i * 0.12); g.gain.exponentialRampToValueAtTime(0.2, t0 + i * 0.12 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.4);
        o.start(t0 + i * 0.12); o.stop(t0 + i * 0.12 + 0.45);
      });
    } catch {}
  }

  // remembered "already seen" per game so alerts don't repeat after a refresh
  const seenKey = (code) => 'sus:seen:' + code;
  const seenGet = (code) => LS.get(seenKey(code)) || {};
  const seenSet = (code, patch) => LS.set(seenKey(code), { ...seenGet(code), ...patch });

  // ---------- connection ----------
  socket.on('connect', async () => {
    if (demoMatch) return bootDemo(false);
    if (host) {
      if (!host.name) { show('hostlogin'); return; }
      const r = await call('host:login', { key: host.key, name: host.name });
      if (!r.ok) { host = null; LS.del('sus:host'); toast(r.error); return bootPlayer(); }
      if (currentCode) socket.emit('host:view', { code: currentCode });
      else { $('hh-name').textContent = host.name; show('hosthome'); }
      return;
    }
    bootPlayer();
  });
  async function bootPlayer() {
    if (!player) { if (!currentCode) show('join'); return; }
    const r = await call('player:resume', { code: player.code, token: player.token });
    if (!r.ok) {
      LS.del('sus:player'); player = null; currentCode = null; view = null;
      show('join'); toast(r.error);
      return;
    }
    if (currentCode !== player.code) { currentCode = player.code; justOpened = true; }
    show('game');
  }
  socket.on('disconnect', () => { if (currentCode) toast('Reconnecting…', 1500); });

  // ---------- demo mode ----------
  const DEMO_DESC = {
    imposter: 'Imposter demo · Host Bot approves kills in 5s',
    crew: 'Crewmate demo · Host Bot approves tasks in 5s',
    host: 'Host demo · bots submit, you approve',
  };
  async function bootDemo(fresh) {
    if (demoPicker) { show('demo'); return; }
    if (demo && !fresh) {
      const r = demo.kind === 'host'
        ? await call('demo:hostResume', { code: demo.code, demoToken: demo.demoToken })
        : await call('player:resume', { code: demo.code, token: demo.token });
      if (r.ok) return enterDemo(false);
    }
    const r = await call('demo:start', { kind: demoKind });
    if (!r.ok) { toast(r.error); show('demo'); return; }
    demo = r;
    try { sessionStorage.setItem('sus:demo', JSON.stringify(r)); } catch {}
    enterDemo(true);
  }
  function enterDemo(isNew) {
    for (const b of document.querySelectorAll('.demo-desc')) b.textContent = DEMO_DESC[demo.kind];
    for (const b of document.querySelectorAll('.demo-bar')) b.classList.remove('hidden');
    $('hh-create').classList.add('hidden');
    $('hh-settings').classList.add('hidden');
    if (demo.kind === 'host') {
      host = { demo: true, name: 'You' }; player = null;
      $('hh-name').textContent = 'You (demo)';
      if (isNew || !currentCode) openHostGame(demo.code);
      else socket.emit('host:view', { code: currentCode });
      return;
    }
    host = null;
    player = { code: demo.code, token: demo.token, playerId: demo.playerId };
    if (currentCode !== demo.code) { currentCode = demo.code; justOpened = true; }
    show('game');
    socket.emit('resync'); // the first state can arrive before we knew which game to show
  }
  function resetGameScreen() {
    clearInterval(revealTimer); overlayBusy = false;
    for (const o of ['ov-meeting', 'ov-result', 'ov-reveal', 'ov-kill', 'ov-peek', 'ov-task', 'ov-actions']) $(o).classList.add('hidden');
    view = null; msgs = []; msgCode = null; msgEpoch = null; renderedKey = null; rendered.clear();
    $('g-messages').innerHTML = ''; $('g-killq').innerHTML = ''; killCards.clear();
    shownMeetingId = null; meetingHidden = false;
  }
  async function restartDemo() {
    if (demo) socket.emit('demo:end', demo);
    try { sessionStorage.removeItem('sus:demo'); } catch {}
    demo = null; currentCode = null; resetGameScreen();
    toast('Starting a fresh demo…', 1500);
    bootDemo(true);
  }
  for (const b of document.querySelectorAll('.demo-restart')) b.onclick = restartDemo;
  async function useSample(url, name, type) {
    const blob = await (await fetch(url)).blob();
    try { return new File([blob], name, { type }); } catch { return blob; }
  }

  // Chat history is kept on the phone: the full list arrives once, then only small add/update packets.
  let msgs = [], msgEpoch = null, msgCode = null;
  socket.on('state', (v) => {
    if (v.code !== currentCode) return;
    if (v.messages) { msgs = v.messages.slice(); msgEpoch = v.msgEpoch; msgCode = v.code; }
    else if (msgCode !== v.code || msgEpoch !== v.msgEpoch) socket.emit('resync');
    const prev = view; view = v;
    render(prev);
  });
  socket.on('msgs', (d) => {
    if (d.code !== currentCode || !view) return;
    if (d.epoch !== msgEpoch || msgCode !== d.code) { socket.emit('resync'); return; }
    const have = new Map(msgs.map((m, i) => [m.id, i]));
    for (const m of d.add) if (!have.has(m.id)) { have.set(m.id, msgs.length); msgs.push(m); }
    for (const m of d.upd) { const i = have.get(m.id); if (i != null) msgs[i] = m; }
    if (msgs.length > 300) msgs.splice(0, msgs.length - 300);
    renderMessages(view);
  });
  socket.on('games', renderGames);
  // A player submitted a task photo: every host gets pinged, wherever they are in the app.
  socket.on('host:tag', (t) => {
    if (!host) return;
    chime();
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {}
    const text = t.kind === 'kill'
      ? `🔪 @hosts — kill to approve in ${t.code}: ${t.name} says they got ${t.victimName}. Tap to open.`
      : `📸 @hosts — ${t.name} in ${t.code} wants approval: "${t.taskText}". Tap to open.`;
    toast(text, 8000, () => {
      if (currentCode !== t.code) openHostGame(t.code); else setTab('chat');
    });
  });
  socket.on('taskPool', (tasks) => { if (document.activeElement !== $('hh-tasks')) $('hh-tasks').value = tasks.join('\n'); });
  socket.on('kicked', () => {
    if (demo) { restartDemo(); return; }
    if (host) { currentCode = null; view = null; $('hh-name').textContent = host.name; show('hosthome'); toast('That lobby was deleted.'); return; }
    LS.del('sus:player'); player = null; currentCode = null; view = null;
    show('join'); toast('You were removed from the lobby.');
  });

  // ---------- join / host login ----------
  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault(); unlockAudio();
    const code = $('join-code').value.trim().toUpperCase();
    const name = $('join-name').value.trim();
    const r = await call('player:join', { code, name });
    if (!r.ok) return toast(r.error);
    player = { code: r.code, token: r.token, playerId: r.playerId };
    LS.set('sus:player', player);
    currentCode = r.code; justOpened = true; tab = 'chat';
    show('game');
  });
  $('host-form').addEventListener('submit', async (e) => {
    e.preventDefault(); unlockAudio();
    const r = await call('host:login', { key: host.key, name: $('host-name').value.trim() });
    if (!r.ok) { host = null; LS.del('sus:host'); show('join'); return toast(r.error); }
    host.name = r.name; LS.set('sus:host', host);
    LS.del('sus:player'); player = null;
    $('hh-name').textContent = host.name;
    show('hosthome');
  });

  // ---------- host home ----------
  const STATUS_TEXT = { lobby: 'Lobby', reveal: 'Starting', playing: 'Live', meeting: 'Voting', ended: 'Game over' };
  const pillCls = (s) => (s === 'meeting' ? ' meeting' : s === 'playing' ? ' live' : '');
  function timeAgo(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return 'now';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }
  function renderGames(list) {
    gamesList = list; updateBackBadge();
    const box = $('hh-games'); box.innerHTML = '';
    if (!list.length) box.appendChild(el('p', 'hint', 'No games yet. Tap "+ New lobby" to get a code and QR.'));
    for (const g of list) {
      const b = el('button', 'inbox-row' + (g.pending || g.pendingKills ? ' has-pending' : ''));
      const top = el('div', 'inbox-top');
      top.appendChild(el('span', 'gcode', g.code));
      top.appendChild(el('span', 'pill' + pillCls(g.status), STATUS_TEXT[g.status]));
      top.appendChild(el('span', 'inbox-meta grow', `${g.players} player${g.players === 1 ? '' : 's'}`));
      top.appendChild(el('span', 'inbox-time', timeAgo(g.lastTs)));
      b.appendChild(top);
      const bottom = el('div', 'inbox-bottom');
      bottom.appendChild(el('span', 'inbox-last grow', g.last || 'No messages yet'));
      if (g.pendingKills) bottom.appendChild(el('span', 'pending-badge kill', `🔪 ${g.pendingKills} kill${g.pendingKills > 1 ? 's' : ''}`));
      if (g.pending) bottom.appendChild(el('span', 'pending-badge', `📸 ${g.pending} to approve`));
      b.appendChild(bottom);
      b.onclick = () => openHostGame(g.code);
      box.appendChild(b);
    }
  }
  // On a game screen, the back arrow shows how many photos are waiting in the hosts' other games.
  function updateBackBadge() {
    const back = $('g-back');
    const n = host ? gamesList.filter((g) => g.code !== currentCode).reduce((a, g) => a + g.pending + (g.pendingKills || 0), 0) : 0;
    back.innerHTML = '←' + (n ? `<span class="back-badge">${n}</span>` : '');
  }
  function openHostGame(code) {
    currentCode = code; view = null; justOpened = true; tab = 'chat';
    socket.emit('host:view', { code });
    show('game');
  }
  $('hh-create').onclick = async () => {
    const r = await call('host:createGame');
    if (!r.ok) return toast(r.error);
    openHostGame(r.code);
  };
  $('hh-save-tasks').onclick = async () => {
    const r = await call('host:setTaskPool', { tasks: $('hh-tasks').value });
    toast(r.ok ? `Saved ${r.count} tasks.` : r.error);
  };
  $('hh-copy-link').onclick = async () => {
    const link = `${location.origin}/host/${encodeURIComponent(host.key)}`;
    try { await navigator.clipboard.writeText(link); toast('Host link copied. Send it only to your co-host.'); }
    catch { prompt('Copy this host link:', link); }
  };
  $('hh-logout').onclick = async () => {
    if (!confirm('Stop being a host on this phone? You can come back with the host link.')) return;
    await call('host:logout'); host = null; LS.del('sus:host'); show('join');
  };

  // ---------- game screen ----------
  $('g-back').onclick = async () => {
    if (demo && !host) { location.href = '/demo'; return; }
    if (host) {
      socket.emit('host:leaveView'); currentCode = null; view = null;
      $('hh-name').textContent = host.name; show('hosthome'); return;
    }
    if (view && !['lobby', 'ended'].includes(view.status)) return toast("You can't leave in the middle of a game.");
    if (!confirm('Leave this game?')) return;
    await call('player:leave');
    LS.del('sus:player'); player = null; currentCode = null; view = null; show('join');
  };

  document.querySelectorAll('#g-tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  function setTab(t) {
    tab = t;
    if (t === 'chat') unreadChat = false;
    document.querySelectorAll('#g-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    for (const p of ['chat', 'players', 'control']) $('pane-' + p).classList.toggle('hidden', p !== t);
    if (t === 'chat') { const box = $('g-messages'); box.scrollTop = box.scrollHeight; }
    updateChatBadge();
  }
  function updateChatBadge() {
    const b = document.querySelector('#g-tabs button[data-tab="chat"]');
    b.innerHTML = 'Chat' + (unreadChat && tab !== 'chat' ? '<span class="badge"></span>' : '');
  }

  $('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chat-input'); const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const r = await call('chat', { code: currentCode, text });
    if (!r.ok) { toast(r.error); input.value = text; }
    else { const box = $('g-messages'); box.scrollTop = box.scrollHeight; }
  });

  const imposterCount = (v) => (v.players.length <= 5 ? 1 : 2);
  function roleText(v) {
    const me = v.me; const n = imposterCount(v);
    if (!me || !me.role) return null;
    if (me.role === 'imposter') {
      return {
        cls: 'imposter', big: 'IMPOSTER',
        sub: (me.partners.length ? `Your fellow imposter: ${me.partners.join(', ')}. ` : '') +
          'Kill crewmates without getting caught: one at a time. Film it, then tap ＋ → Post a kill, upload the video (at least 5 seconds), and tag who is in it. A host approves it, then it posts from Anonymous imposter and everyone is alerted. Your tasks are fake — pretend to do them.',
      };
    }
    return { cls: 'crew', big: 'CREWMATE', sub: `Finish your tasks and vote out the imposter${n > 1 ? 's' : ''}. There ${n > 1 ? 'are 2 imposters' : 'is 1 imposter'}.` };
  }

  function render(prev) {
    const v = view; if (!v) return;
    const isHost = v.isHost;
    const me = v.me;
    const inPlay = ['reveal', 'playing', 'meeting'].includes(v.status);

    if (justOpened) { justOpened = false; setTab(isHost && v.status === 'lobby' ? 'control' : 'chat'); }

    // header
    $('g-code').textContent = v.code;
    const st = $('g-status');
    st.textContent = STATUS_TEXT[v.status];
    st.className = 'pill' + (v.status === 'meeting' ? ' meeting' : v.status === 'playing' ? ' live' : '');
    $('g-peek').classList.toggle('hidden', isHost || !me || !me.role);

    // progress
    const showProg = v.status !== 'lobby' && v.progress.total > 0;
    $('g-progress-wrap').classList.toggle('hidden', !showProg);
    const pct = v.progress.total ? Math.round((v.progress.done / v.progress.total) * 100) : 0;
    $('g-progress').style.width = pct + '%';
    $('g-progress-label').textContent = `Tasks ${pct}%`;

    // tabs
    $('tab-control-btn').classList.toggle('hidden', !isHost);
    if (!isHost && tab === 'control') setTab('chat');
    updateBackBadge();

    renderBanner(v);
    renderMessages(v);

    // chat input lock
    const out = !isHost && me && inPlay && !me.alive;
    $('chat-form').classList.toggle('hidden', !!out);
    $('chat-locked').classList.toggle('hidden', !out);
    if (out) $('chat-locked').textContent = me.ejected
      ? "You were voted off. You can read the chat but can't send messages."
      : "You were killed. You can read the chat but can't send messages.";
    $('g-plus').classList.toggle('hidden', isHost || !inPlay);

    renderChecklist(v);
    renderKillQueue(v);
    reviewToasts(prev, v);
    renderPlayers(v);
    if (isHost) renderControl(v);

    maybeReveal(v);
    renderMeeting(v);
    queueOverlays(v);
  }

  function renderBanner(v) {
    const b = $('g-banner'); b.className = 'banner'; b.innerHTML = '';
    const me = v.me;
    if (v.meeting && meetingHidden) {
      b.classList.add('win-imp');
      b.appendChild(el('div', null, '🚨 A vote is happening. '));
      const btn = el('button', 'btn small danger', 'Open the vote'); btn.onclick = () => { meetingHidden = false; renderMeeting(view); };
      b.appendChild(btn); return;
    }
    if (v.status === 'lobby') {
      const n = v.players.length;
      b.textContent = v.isHost
        ? `Lobby open with ${n} player${n === 1 ? '' : 's'}. Show the QR in the Host tab, then press Start (3+ players).`
        : `You're in! ${n} player${n === 1 ? '' : 's'} here. Waiting for a host to start the game…`;
      return;
    }
    if (v.status === 'ended') {
      b.classList.add(v.winner === 'imposters' ? 'win-imp' : 'win-crew');
      const title = v.winner === 'crew' ? '🎉 Crew wins!' : v.winner === 'imposters' ? '🔪 Imposters win!' : 'Game over';
      const t = el('div'); t.appendChild(el('b', null, title + ' ')); t.appendChild(document.createTextNode(v.winReason || ''));
      b.appendChild(t);
      const imps = v.players.filter((p) => p.role === 'imposter').map((p) => p.name);
      if (imps.length) b.appendChild(el('div', null, `Imposter${imps.length > 1 ? 's' : ''}: ${imps.join(' & ')}`));
      if (!v.isHost) b.appendChild(el('div', 'hint', 'Waiting for a host to start the next round.'));
      return;
    }
    b.classList.add('hidden');
  }

  function msgEl(m, v) {
    const myId = v.me && v.me.id;
    if (m.type === 'system') return el('div', 'msg system', m.text);
    if (m.type === 'kill') {
      const d = el('div', 'msg kill');
      d.appendChild(el('div', 'who imp-who', '🔪 Anonymous imposter'));
      d.appendChild(el('div', 'kill-title', m.text));
      if (!m.video) { d.appendChild(el('div', 'video-wait', '🎬 Video is processing…')); return d; }
      const vid = document.createElement('video');
      vid.src = m.video; vid.controls = true; vid.playsInline = true; vid.preload = 'metadata'; vid.setAttribute('playsinline', '');
      d.appendChild(vid);
      return d;
    }
    if (m.type === 'task') return taskEl(m, v);
    const mine = !v.isHost ? m.from === myId : (m.host && host && m.name === host.name);
    const d = el('div', 'msg' + (mine ? ' mine' : '') + (m.host ? ' host' : ''));
    d.appendChild(el('div', 'who', m.host ? `${m.name} · HOST` : m.name));
    d.appendChild(el('div', 'bubble', m.text));
    return d;
  }
  const canReview = (v) => v.isHost && ['playing', 'meeting', 'reveal'].includes(v.status);
  function taskEl(m, v) {
    const mine = !v.isHost && v.me && m.from === v.me.id;
    const d = el('div', 'msg task' + (mine ? ' mine' : ''));
    const head = el('div', 'task-head');
    head.appendChild(el('span', 'grow', `📸 ${mine ? 'You' : m.name} submitted a task`));
    head.appendChild(el('span', 'tag-hosts', '@hosts'));
    d.appendChild(head);
    d.appendChild(el('div', 'task-text', m.taskText));
    if (v.isHost || mine) {
      const img = document.createElement('img');
      img.className = 'task-photo'; img.src = m.photo; img.alt = 'Task photo'; img.loading = 'lazy';
      img.onclick = () => { $('ph-img').src = m.photo; $('ov-photo').classList.remove('hidden'); };
      d.appendChild(img);
    }
    const txt = m.status === 'pending' ? '⏳ Waiting for a host'
      : m.status === 'approved' ? `✅ Approved by ${m.reviewer || 'a host'}`
      : `❌ Not accepted by ${m.reviewer || 'a host'} — try again`;
    d.appendChild(el('div', 'task-status ' + m.status, txt));
    if (m.status === 'pending' && canReview(v)) {
      const row = el('div', 'task-actions');
      const yes = el('button', 'btn primary', '✓ Approve');
      const no = el('button', 'btn ghost', '✕ Reject');
      const review = async (approve, btn) => {
        yes.disabled = no.disabled = true;
        const r = await call('host:review', { code: v.code, msgId: m.id, approve });
        if (!r.ok) { toast(r.error); yes.disabled = no.disabled = false; }
      };
      yes.onclick = () => review(true);
      no.onclick = () => { if (confirm(`Reject ${m.name}'s photo? They can submit a new one.`)) review(false); };
      row.appendChild(yes); row.appendChild(no);
      d.appendChild(row);
    }
    return d;
  }
  const sigOf = (m, v) => (m.type === 'task' ? m.status + (canReview(v) ? ':r' : '') : m.type === 'kill' ? (m.video ? 'v' : 'p') : '');
  function renderMessages(v) {
    const box = $('g-messages');
    const list = msgCode === v.code ? msgs : [];
    const key = v.code + ':' + msgEpoch;
    const overlap = list.some((m) => rendered.has(m.id));
    if (key !== renderedKey || (rendered.size && !overlap)) {
      box.innerHTML = ''; rendered.clear(); renderedKey = key;
    }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    let added = false;
    const live = new Set();
    for (const m of list) {
      live.add(m.id);
      const sig = sigOf(m, v);
      const r = rendered.get(m.id);
      if (r) {
        if (r.sig !== sig) { const n = msgEl(m, v); r.node.replaceWith(n); rendered.set(m.id, { node: n, sig }); }
        continue;
      }
      const n = msgEl(m, v); box.appendChild(n); rendered.set(m.id, { node: n, sig }); added = true;
    }
    for (const [mid, r] of rendered) if (!live.has(mid)) { r.node.remove(); rendered.delete(mid); }
    if (added) {
      if (nearBottom) box.scrollTop = box.scrollHeight;
      if (tab !== 'chat') { unreadChat = true; updateChatBadge(); }
    }
  }

  // Each player's own tasks, pinned at the top of the chat as a checklist.
  function renderChecklist(v) {
    const box = $('g-checklist');
    const tasks = (v.me && v.me.tasks) || [];
    const visible = !v.isHost && tasks.length > 0 && v.status !== 'lobby';
    box.classList.toggle('hidden', !visible);
    if (!visible) return;
    const done = tasks.filter((t) => t.done).length;
    $('cl-title').textContent = `✅ Your tasks · ${done}/${tasks.length} done`;
    $('cl-caret').textContent = checklistOpen ? '▾' : '▸';
    const ul = $('g-tasks'); ul.classList.toggle('hidden', !checklistOpen); ul.innerHTML = '';
    const canSubmit = ['playing', 'meeting'].includes(v.status);
    for (const t of tasks) {
      const li = el('li', t.done ? 'done' : t.pending ? 'pending' : '');
      li.appendChild(el('span', 'check', t.done ? '✓' : t.pending ? '⏳' : ''));
      li.appendChild(el('span', 't grow', t.text));
      if (!t.done && !t.pending && canSubmit) {
        const b = el('button', 'btn small primary', '📸 Submit');
        b.onclick = () => openTaskSheet(t);
        li.appendChild(b);
      } else if (t.pending) li.appendChild(el('span', 'tag-state', 'with hosts'));
      ul.appendChild(li);
    }
  }
  $('cl-head').onclick = () => { checklistOpen = !checklistOpen; LS.set('sus:clOpen', checklistOpen); if (view) renderChecklist(view); };

  // Hosts: kill videos waiting for approval, pinned above the chat. Nobody else ever sees these.
  const killCards = new Map(); // kill id -> { node, sig }
  function renderKillQueue(v) {
    const box = $('g-killq');
    const list = (v.isHost && v.pendingKills) || [];
    box.classList.toggle('hidden', !list.length);
    const ids = new Set(list.map((k) => k.id));
    for (const [kid, c] of killCards) if (!ids.has(kid)) { c.node.remove(); killCards.delete(kid); }
    for (const k of list) {
      const sig = k.status + ':' + (k.video || '') + ':' + v.status;
      const have = killCards.get(k.id);
      if (have && have.sig === sig) continue;
      const card = el('div', 'kill-card');
      card.appendChild(el('div', 'kill-card-head', `🔪 Kill to approve · ${k.killerName} (imposter) says they got ${k.victimName}`));
      if (!k.video) card.appendChild(el('div', 'video-wait', '🎬 Video is processing…'));
      else {
        const vid = document.createElement('video');
        vid.src = k.video; vid.controls = true; vid.muted = true; vid.loop = true; vid.autoplay = true; vid.playsInline = true; vid.setAttribute('playsinline', '');
        card.appendChild(vid);
      }
      if (k.seconds) card.appendChild(el('div', 'hint', `${k.seconds.toFixed(1)} seconds`));
      const row = el('div', 'task-actions');
      const yes = el('button', 'btn danger', v.status === 'meeting' ? 'Approve after the vote' : '✓ Approve kill');
      const no = el('button', 'btn ghost', '✕ Reject');
      yes.disabled = !k.video || v.status !== 'playing';
      yes.onclick = async () => {
        if (!confirm(`Approve? ${k.victimName} dies, the video posts to everyone, and a vote starts.`)) return;
        yes.disabled = no.disabled = true;
        const r = await call('host:reviewKill', { code: v.code, killId: k.id, approve: true });
        if (!r.ok) { toast(r.error); yes.disabled = no.disabled = false; }
      };
      no.onclick = async () => {
        if (!confirm(`Reject this kill video? ${k.killerName} can record a new one.`)) return;
        const r = await call('host:reviewKill', { code: v.code, killId: k.id, approve: false });
        if (!r.ok) toast(r.error);
      };
      row.appendChild(yes); row.appendChild(no);
      card.appendChild(row);
      if (have) have.node.replaceWith(card); else box.appendChild(card);
      killCards.set(k.id, { node: card, sig });
    }
  }

  function reviewToasts(prev, v) {
    if (!prev || !prev.me || !v.me || prev.round !== v.round || prev.code !== v.code) return;
    for (const k of v.me.myKills || []) {
      const before = (prev.me.myKills || []).find((x) => x.id === k.id);
      if (before && before.status !== k.status && k.status === 'rejected') toast(`❌ The hosts rejected your kill video of ${k.victimName}. Upload a new one if you want.`, 5000);
      if (before && before.status !== k.status && k.status === 'invalid') toast(`Your kill of ${k.victimName} couldn't be approved — they're already out.`, 5000);
    }
    for (const t of v.me.tasks) {
      const before = prev.me.tasks.find((x) => x.id === t.id);
      if (!before) continue;
      if (!before.done && t.done) { toast(`✅ Approved: ${t.text}`); chime(); }
      else if (before.pending && !t.pending && !t.done) toast(`❌ A host didn't accept your photo for "${t.text}". Try again.`, 4500);
    }
  }

  function stateLabel(p) { return p.dead ? '💀 killed' : p.ejected ? '🚫 voted off' : ''; }
  function renderPlayers(v) {
    const box = $('g-players'); box.innerHTML = '';
    $('roles-toggle-wrap').classList.toggle('hidden', !v.isHost || v.status === 'lobby' || v.status === 'ended');
    const players = v.players.slice();
    if (v.isHost) players.sort((a, b) => a.name.localeCompare(b.name));
    if (!players.length) box.appendChild(el('p', 'hint', 'No players yet.'));
    for (const p of players) {
      const c = el('div', 'pcard');
      const head = el('div', 'pcard-head');
      head.appendChild(el('span', 'dot' + (p.connected ? ' on' : '')));
      head.appendChild(el('span', 'pcard-name grow', p.name + (v.me && v.me.id === p.id ? ' (you)' : '')));
      const sl = stateLabel(p); if (sl) head.appendChild(el('span', 'tag-state', sl));
      if (p.role && (showRoles || v.status === 'ended')) head.appendChild(el('span', 'tag-role ' + p.role, p.role === 'imposter' ? 'Imposter' : 'Crew'));
      if (v.isHost && (v.status === 'lobby' || v.status === 'ended')) {
        const k = el('button', 'btn small ghost', 'Remove');
        k.onclick = async () => { if (confirm(`Remove ${p.name}?`)) { const r = await call('host:kick', { code: v.code, playerId: p.id }); if (!r.ok) toast(r.error); } };
        head.appendChild(k);
      }
      c.appendChild(head);
      if (v.isHost && p.tasks && p.tasks.length && v.status !== 'lobby') {
        const list = el('div', 'ptasks');
        for (const t of p.tasks) {
          const b = el('button', 'ptask' + (t.done ? ' done' : ''));
          b.appendChild(el('span', 'check', t.done ? '✓' : ''));
          b.appendChild(el('span', 'grow', t.text));
          b.disabled = v.status === 'ended';
          b.onclick = async () => { const r = await call('host:toggleTask', { code: v.code, playerId: p.id, taskId: t.id }); if (!r.ok) toast(r.error); };
          list.appendChild(b);
        }
        c.appendChild(list);
      }
      box.appendChild(c);
    }
  }
  $('roles-toggle').onchange = (e) => { showRoles = e.target.checked; if (view) renderPlayers(view); };

  function renderControl(v) {
    const qr = $('c-qr');
    const src = '/qr.svg?code=' + v.code;
    if (qr.getAttribute('src') !== src) qr.setAttribute('src', src);
    $('c-code').textContent = v.code;
    $('c-url').textContent = v.joinUrl;
    if (document.activeElement !== $('c-tpp')) $('c-tpp').value = v.settings.tasksPerPlayer;
    const s = v.status;
    $('c-start').classList.toggle('hidden', !(s === 'lobby' || s === 'ended'));
    $('c-start').textContent = s === 'ended' ? 'Play again (same players)' : `Start game (${v.players.length} players)`;
    $('c-endvote').classList.toggle('hidden', s !== 'meeting');
    $('c-lobby').classList.toggle('hidden', s === 'lobby');
    $('c-endgame').classList.toggle('hidden', !['reveal', 'playing', 'meeting'].includes(s));
  }
  $('c-tpp').onchange = async (e) => { const r = await call('host:settings', { code: currentCode, tasksPerPlayer: e.target.value }); if (!r.ok) toast(r.error); };
  $('c-start').onclick = async () => {
    const r = await call('host:start', { code: currentCode });
    if (!r.ok) return toast(r.error);
    setTab('players');
  };
  const endVote = async () => { if (!confirm('End the vote now and count the votes so far?')) return; const r = await call('host:endVote', { code: currentCode }); if (!r.ok) toast(r.error); };
  $('c-endvote').onclick = endVote;
  $('mt-endvote').onclick = endVote;
  $('c-lobby').onclick = async () => { if (!confirm('Send everyone back to the lobby? This clears the current game.')) return; const r = await call('host:toLobby', { code: currentCode }); if (!r.ok) toast(r.error); };
  $('c-endgame').onclick = async () => { if (!confirm('End this game for everyone?')) return; const r = await call('host:endGame', { code: currentCode }); if (!r.ok) toast(r.error); };
  $('c-delete').onclick = async () => {
    if (!confirm('Delete this lobby? Everyone in it gets kicked.')) return;
    const r = await call('host:deleteGame', { code: currentCode });
    if (!r.ok) return toast(r.error);
    currentCode = null; view = null; show('hosthome');
  };

  // ---------- role reveal ----------
  function maybeReveal(v) {
    if (v.isHost || v.status !== 'reveal' || !v.me || !v.me.role) return;
    const seen = seenGet(v.code);
    if ((seen.round || 0) >= v.round) return;
    seenSet(v.code, { round: v.round });
    runReveal(v.revealAgoMs || 0);
  }
  function runReveal(agoMs) {
    clearInterval(revealTimer);
    overlayBusy = true;
    const ov = $('ov-reveal');
    const start = performance.now() - agoMs;
    ov.className = 'overlay';
    $('rv-count').classList.remove('hidden'); $('rv-role').classList.add('hidden');
    let lastNum = null;
    const tick = () => {
      const t = performance.now() - start;
      if (t < 5000) {
        const n = Math.ceil((5000 - t) / 1000);
        if (n !== lastNum) { lastNum = n; $('rv-num').textContent = n; try { navigator.vibrate && navigator.vibrate(60); } catch {} }
      } else if (t < 8000) {
        if (!$('rv-count').classList.contains('hidden')) {
          const r = roleText(view);
          $('rv-count').classList.add('hidden'); $('rv-role').classList.remove('hidden');
          ov.className = 'overlay ' + (r.cls === 'imposter' ? 'imp' : 'crw');
          $('rv-big').textContent = r.big; $('rv-big').className = 'rv-big ' + r.cls;
          $('rv-sub').textContent = r.sub;
        }
      } else {
        clearInterval(revealTimer); ov.className = 'overlay hidden'; overlayBusy = false;
        if (view) { renderMeeting(view); queueOverlays(view); }
      }
    };
    tick(); revealTimer = setInterval(tick, 100);
  }

  // hold-to-peek at your role
  const peek = $('g-peek');
  function peekOn(e) {
    e.preventDefault();
    const r = view && roleText(view); if (!r) return;
    const ov = $('ov-peek'); ov.className = 'overlay peek ' + (r.cls === 'imposter' ? 'imp' : 'crw');
    $('pk-big').textContent = r.big; $('pk-big').className = 'rv-big ' + r.cls; $('pk-sub').textContent = r.sub;
  }
  function peekOff() { $('ov-peek').className = 'overlay peek hidden'; }
  peek.addEventListener('pointerdown', peekOn);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => peek.addEventListener(ev, peekOff));
  $('ov-peek').addEventListener('pointerup', peekOff);
  peek.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- meeting / voting ----------
  function renderMeeting(v) {
    const ov = $('ov-meeting');
    const m = v.meeting;
    if (!m) { ov.classList.add('hidden'); shownMeetingId = null; meetingHidden = false; $('mt-video').innerHTML = ''; return; }
    if (overlayBusy) return; // role reveal is on screen; show the meeting right after
    if (m.id !== shownMeetingId) {
      shownMeetingId = m.id; meetingHidden = false; shownMeetingVideo = undefined;
      const seen = seenGet(v.code);
      if (seen.meeting !== m.id) {
        seenSet(v.code, { meeting: m.id });
        alarm();
        ov.classList.remove('flash'); void ov.offsetWidth; ov.classList.add('flash');
      }
    }
    if (m.video !== shownMeetingVideo) {
      shownMeetingVideo = m.video;
      const box = $('mt-video'); box.innerHTML = '';
      if (!m.video) box.appendChild(el('div', 'video-wait', '🎬 Kill video is processing…'));
      else {
        const vid = document.createElement('video');
        vid.src = m.video; vid.controls = true; vid.autoplay = true; vid.muted = true; vid.loop = true; vid.playsInline = true; vid.setAttribute('playsinline', '');
        box.appendChild(vid);
      }
    }
    ov.classList.toggle('hidden', meetingHidden);
    $('mt-sub').textContent = `💀 ${m.victimName || 'Someone'} was killed!`;
    $('mt-status').textContent = `${m.votedIds.length} of ${m.voterCount} votes in. Most votes gets booted — a tie means nobody goes.`;
    $('mt-endvote').classList.toggle('hidden', !v.isHost);

    const grid = $('mt-votes'); grid.innerHTML = '';
    const me = v.me;
    const canVote = !v.isHost && me && me.alive && !m.myVote;
    if (!v.isHost && me && !me.alive) grid.appendChild(el('p', 'hint', "You're out, so you can't vote. Watch the chat."));
    for (const p of v.players.filter((x) => x.alive)) {
      if (me && p.id === me.id) continue;
      const b = el('button', 'vote-btn' + (m.myVote === p.id ? ' picked' : ''), p.name);
      if (m.votedIds.includes(p.id)) b.appendChild(el('span', 'voted-mark', '✓ voted'));
      b.disabled = !canVote;
      b.onclick = async () => {
        if (!confirm(`Vote to boot ${p.name}? You can't change it.`)) return;
        const r = await call('vote', { targetId: p.id });
        if (!r.ok) toast(r.error);
      };
      grid.appendChild(b);
    }
    if (m.myVote) {
      const target = v.players.find((p) => p.id === m.myVote);
      $('mt-status').textContent = `You voted for ${target ? target.name : '?'}. ${m.votedIds.length} of ${m.voterCount} votes in…`;
    }
  }
  $('mt-hide').onclick = () => { meetingHidden = true; $('ov-meeting').classList.add('hidden'); if (view) renderBanner(view); setTab('chat'); };

  // ---------- result + game over popups ----------
  function queueOverlays(v) {
    if (overlayBusy || !$('ov-result').classList.contains('hidden')) return;
    if (v.status === 'reveal') return;
    const seen = seenGet(v.code);
    const r = v.lastResult;
    if (r && seen.result !== r.id) {
      seenSet(v.code, { result: r.id });
      const names = Object.fromEntries(v.players.map((p) => [p.id, p.name]));
      if (r.tie) {
        showResult('🤷', 'Nobody was voted off', 'It was a tie (or no votes).', r.tally, names, '');
      } else if (r.wasImposter) {
        showResult('🚨', `${r.name} WAS an imposter!`, r.impostersLeft ? `${r.impostersLeft} imposter${r.impostersLeft > 1 ? 's' : ''} still out there.` : '', r.tally, names, 'imp');
      } else {
        showResult('😬', `${r.name} was NOT an imposter`, 'You voted off an innocent person.', r.tally, names, '');
      }
      return;
    }
    if (v.status === 'ended' && v.winner && seen.ended !== v.round) {
      seenSet(v.code, { ended: v.round });
      chime();
      const meWon = v.me && ((v.winner === 'crew' && v.me.role === 'crew') || (v.winner === 'imposters' && v.me.role === 'imposter'));
      const imps = v.players.filter((p) => p.role === 'imposter').map((p) => p.name).join(' & ');
      showResult(v.winner === 'crew' ? '🎉' : '🔪', v.winner === 'crew' ? 'CREW WINS' : 'IMPOSTERS WIN',
        `${v.winReason} ${v.me ? (meWon ? 'You won!' : 'You lost.') : ''} Imposter${imps.includes('&') ? 's' : ''}: ${imps}.`, null, null, v.winner === 'crew' ? '' : 'imp');
    }
  }
  function showResult(emoji, title, sub, tally, names, cls) {
    $('rs-emoji').textContent = emoji;
    $('rs-title').textContent = title; $('rs-title').className = 'res-title ' + (cls || '');
    $('rs-sub').textContent = sub;
    const t = $('rs-tally'); t.innerHTML = '';
    if (tally) for (const [pid, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
      const row = el('div'); row.appendChild(el('span', null, names[pid] || '?')); row.appendChild(el('b', null, `${n} vote${n > 1 ? 's' : ''}`)); t.appendChild(row);
    }
    $('ov-result').classList.remove('hidden');
  }
  $('rs-ok').onclick = () => { $('ov-result').classList.add('hidden'); if (view) queueOverlays(view); };

  // ---------- kill video ----------
  let killVictim = null, killFile = null;
  const closeActions = () => $('ov-actions').classList.add('hidden');
  $('g-plus').onclick = () => $('ov-actions').classList.remove('hidden');
  $('act-cancel').onclick = closeActions;
  $('ov-actions').addEventListener('click', (e) => { if (e.target.id === 'ov-actions') closeActions(); });
  $('act-task').onclick = () => { closeActions(); openTaskSheet(null); };
  $('ov-photo').onclick = () => $('ov-photo').classList.add('hidden');

  // ---------- task photo ----------
  let tkTask = null, tkBlob = null;
  function resetTk() {
    tkBlob = null; $('tk-file').value = '';
    $('tk-preview').classList.add('hidden'); $('tk-preview').removeAttribute('src');
    $('tk-send').classList.add('hidden'); $('tk-send').disabled = false; $('tk-bar').classList.add('hidden');
  }
  function pickTk(t) {
    tkTask = t; $('tk-name').textContent = t.text; resetTk();
    $('tk-step1').classList.add('hidden'); $('tk-step2').classList.remove('hidden');
  }
  function openTaskSheet(task) {
    const v = view; if (!v || !v.me) return;
    if (!['playing', 'meeting'].includes(v.status)) return toast('You can submit tasks once the game is running.');
    const open = v.me.tasks.filter((t) => !t.done && !t.pending);
    if (!open.length) return toast('Nothing left to submit — every task is done or waiting for a host.');
    const list = $('tk-list'); list.innerHTML = '';
    for (const t of open) {
      const b = el('button', 'btn task-pick', t.text);
      b.onclick = () => pickTk(t);
      list.appendChild(b);
    }
    if (task) pickTk(task); else { $('tk-step1').classList.remove('hidden'); $('tk-step2').classList.add('hidden'); }
    $('ov-task').classList.remove('hidden');
  }
  async function shrinkPhoto(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.75));
      return blob || file;
    } catch { return file; }
  }
  $('tk-close').onclick = () => { $('ov-task').classList.add('hidden'); resetTk(); };
  $('tk-backstep').onclick = () => { resetTk(); $('tk-step2').classList.add('hidden'); $('tk-step1').classList.remove('hidden'); };
  $('tk-sample').onclick = async () => handleTaskFile(await useSample(pick(['/demo/task1.jpg', '/demo/task2.jpg', '/demo/task3.jpg']), 'sample.jpg', 'image/jpeg'));
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  $('tk-file').onchange = (e) => handleTaskFile(e.target.files && e.target.files[0]);
  async function handleTaskFile(f) {
    if (!f) return;
    tkBlob = await shrinkPhoto(f);
    const pv = $('tk-preview'); pv.src = URL.createObjectURL(tkBlob); pv.classList.remove('hidden');
    $('tk-send').classList.remove('hidden');
  }
  $('tk-send').onclick = () => {
    if (!tkBlob || !tkTask) return;
    $('tk-send').disabled = true; $('tk-bar').classList.remove('hidden'); $('tk-bar-fill').style.width = '0%';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/task-photo?code=${encodeURIComponent(currentCode)}&task=${encodeURIComponent(tkTask.id)}`);
    xhr.setRequestHeader('x-player-token', player.token);
    xhr.setRequestHeader('Content-Type', tkBlob.type || 'image/jpeg');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) $('tk-bar-fill').style.width = Math.round((e.loaded / e.total) * 100) + '%'; };
    xhr.onload = () => {
      let r = {}; try { r = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200) { $('ov-task').classList.add('hidden'); resetTk(); toast('Sent! The hosts have been tagged.'); }
      else { toast(r.error || 'Upload failed.'); $('tk-send').disabled = false; }
    };
    xhr.onerror = () => { toast('Upload failed — check your connection.'); $('tk-send').disabled = false; };
    xhr.send(tkBlob);
  };

  // ---------- kill video ----------
  $('act-kill').onclick = () => {
    closeActions();
    const v = view; if (!v || !v.me) return;
    if (v.status === 'meeting') return toast('Wait until the vote is over.');
    if (v.status !== 'playing') return toast('The game has not started yet.');
    if (v.me.role !== 'imposter') return toast('Only imposters can post kill videos.');
    if (!v.me.alive) return toast("You're out of the game.");
    openKill();
  };
  // One video, one tagged person: the imposter picks exactly one player from the dropdown.
  let killVideoOk = false;
  function updateKillSend() {
    const sel = $('kl-victim');
    killVictim = sel.value ? view.players.find((p) => p.id === sel.value) || null : null;
    $('kl-send').disabled = !(killFile && killVideoOk && killVictim);
    $('kl-send').textContent = killVictim ? `Post kill of ${killVictim.name}` : 'Post kill';
  }
  function openKill() {
    resetKillStep2();
    const sel = $('kl-victim'); sel.innerHTML = '';
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Tag one person…'; sel.appendChild(ph);
    const partners = new Set(view.me.partners);
    const targets = view.players.filter((p) => p.alive && p.id !== view.me.id && !partners.has(p.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const p of targets) {
      const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o);
    }
    updateKillSend();
    $('ov-kill').classList.remove('hidden');
  }
  function resetKillStep2() {
    killFile = null; killVideoOk = false; killVictim = null; $('kl-file').value = '';
    const pv = $('kl-preview'); pv.classList.add('hidden'); pv.removeAttribute('src');
    $('kl-info').textContent = ''; $('kl-bar').classList.add('hidden');
    $('kl-send').disabled = true; $('kl-send').textContent = 'Post kill';
  }
  $('kl-victim').onchange = updateKillSend;
  $('kl-close').onclick = () => { $('ov-kill').classList.add('hidden'); resetKillStep2(); };
  $('kl-sample').onclick = async () => handleKillFile(await useSample('/demo/kill.mp4', 'sample.mp4', 'video/mp4'));
  $('kl-file').onchange = (e) => handleKillFile(e.target.files && e.target.files[0]);
  function handleKillFile(f) {
    if (!f) return;
    killFile = f;
    const pv = $('kl-preview'); pv.src = URL.createObjectURL(f); pv.classList.remove('hidden'); pv.play().catch(() => {});
    const mb = (f.size / 1048576).toFixed(1);
    $('kl-info').textContent = 'Checking video length…';
    killVideoOk = false; updateKillSend();
    // Kill videos must be at least 5 seconds (and at most 15, to keep downloads small for everyone).
    pv.onloadedmetadata = () => {
      const d = pv.duration;
      if (isFinite(d) && d < 4.9) {
        $('kl-info').textContent = `That's only ${d.toFixed(1)} seconds. Kill videos have to be at least 5 seconds — choose a different video.`;
        killFile = null; updateKillSend();
      } else if (isFinite(d) && d > 15) {
        $('kl-info').textContent = `That's ${Math.round(d)} seconds — keep it between 5 and 15. Choose a different video.`;
        killFile = null; updateKillSend();
      } else {
        $('kl-info').textContent = isFinite(d) ? `✓ ${d.toFixed(1)} s · ${mb} MB` : `${mb} MB`;
        killVideoOk = true; updateKillSend();
      }
    };
    pv.onerror = () => { $('kl-info').textContent = `${mb} MB`; killVideoOk = true; updateKillSend(); };
  }
  // Re-record the clip at 360p on the phone (about 0.4 MB instead of ~10 MB) so 100 phones can download it.
  function shrinkVideo(file, onProgress) {
    const mime = window.MediaRecorder && HTMLCanvasElement.prototype.captureStream &&
      ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) return Promise.resolve(file);
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.src = URL.createObjectURL(file);
      let done = false;
      const finish = (blob) => { if (done) return; done = true; clearTimeout(timer); resolve(blob && blob.size > 20000 && blob.size < file.size ? blob : file); };
      const timer = setTimeout(() => finish(null), 25000);
      v.onerror = () => finish(null);
      v.onloadedmetadata = async () => {
        const scale = Math.min(1, 360 / Math.min(v.videoWidth || 360, v.videoHeight || 360));
        const c = document.createElement('canvas');
        c.width = Math.round(((v.videoWidth || 640) * scale) / 2) * 2; c.height = Math.round(((v.videoHeight || 480) * scale) / 2) * 2;
        const ctx = c.getContext('2d');
        let rec;
        try { rec = new MediaRecorder(c.captureStream(24), { mimeType: mime, videoBitsPerSecond: 500000 }); } catch { return finish(null); }
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = () => finish(new Blob(chunks, { type: mime.split(';')[0] }));
        v.onended = () => { try { rec.stop(); } catch { finish(null); } };
        const draw = () => {
          if (done || v.ended) return;
          ctx.drawImage(v, 0, 0, c.width, c.height);
          if (onProgress && v.duration) onProgress(v.currentTime / v.duration);
          requestAnimationFrame(draw);
        };
        rec.start(250);
        try { await v.play(); } catch { try { rec.stop(); } catch {} return finish(null); }
        draw();
      };
    });
  }

  $('kl-send').onclick = async () => {
    if (!killFile || !killVictim || !killVideoOk) return toast('Choose a 5+ second video and tag who is in it.');
    $('kl-send').disabled = true; $('kl-bar').classList.remove('hidden'); $('kl-bar-fill').style.width = '0%';
    $('kl-info').textContent = 'Shrinking video…';
    // small clips are already cheap to send; only shrink big camera-roll videos
    const upload = killFile.size < 2.5e6 ? killFile : await shrinkVideo(killFile, (f) => { $('kl-bar-fill').style.width = Math.round(f * 50) + '%'; });
    $('kl-info').textContent = `Uploading ${(upload.size / 1048576).toFixed(1)} MB…`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/kill?code=${encodeURIComponent(currentCode)}&victim=${encodeURIComponent(killVictim.id)}`);
    xhr.setRequestHeader('x-player-token', player.token);
    xhr.setRequestHeader('Content-Type', upload.type || 'video/mp4');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) $('kl-bar-fill').style.width = (50 + Math.round((e.loaded / e.total) * 50)) + '%'; };
    xhr.onload = () => {
      let r = {}; try { r = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200) { $('ov-kill').classList.add('hidden'); resetKillStep2(); toast('Sent to the hosts. Once a host approves it, everyone gets the alert. Act natural. 🤫', 4500); }
      else { toast(r.error || 'Upload failed.'); $('kl-send').disabled = false; }
    };
    xhr.onerror = () => { toast('Upload failed — check the Wi-Fi.'); $('kl-send').disabled = false; };
    xhr.send(upload);
  };

  // ---------- keep the screen awake during a game (needs https, e.g. the hosted version) ----------
  let wakeLock = null;
  async function keepAwake() {
    if (!('wakeLock' in navigator) || (!currentCode && !host) || document.visibilityState !== 'visible' || wakeLock) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch {}
  }
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('pointerdown', keepAwake, { passive: true });

  // ---------- boot ----------
  if (demoMatch) show(demoPicker ? 'demo' : 'game');
  else if (!socket.connected) show(host ? (host.name ? 'hosthome' : 'hostlogin') : player ? 'game' : 'join');
  if (host) $('hh-name').textContent = host.name;
  if (player && !host) currentCode = player.code;
})();
