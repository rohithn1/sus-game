/* SUS — phone client */
(() => {
  const socket = io({ transports: ['websocket', 'polling'] });
  const $ = (id) => document.getElementById(id);
  const LS = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
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
  let currentCode = null;
  let view = null;
  let tab = 'chat';
  let showRoles = false;
  let justOpened = false;
  let renderedKey = null;
  const renderedMsgIds = new Set();
  let shownMeetingId = null;
  let meetingHidden = false;
  let overlayBusy = false;
  let revealTimer = null;
  let unreadChat = false;

  const urlCode = (new URLSearchParams(location.search).get('code') || '').toUpperCase().slice(0, 4);
  if (urlCode) $('join-code').value = urlCode;
  if (player && urlCode && player.code !== urlCode && !host) { LS.del('sus:player'); player = null; }

  // ---------- screens ----------
  const SCREENS = ['join', 'hostlogin', 'hosthome', 'game'];
  function show(name) {
    for (const s of SCREENS) $('scr-' + s).classList.toggle('hidden', s !== name);
    if (name !== 'game') for (const o of ['ov-meeting', 'ov-result', 'ov-reveal', 'ov-kill', 'ov-peek']) $(o).classList.add('hidden');
  }
  let toastTimer;
  function toast(msg, ms = 2800) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
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

  socket.on('state', (v) => {
    if (v.code !== currentCode) return;
    const prev = view; view = v;
    render(prev);
  });
  socket.on('games', renderGames);
  socket.on('taskPool', (tasks) => { if (document.activeElement !== $('hh-tasks')) $('hh-tasks').value = tasks.join('\n'); });
  socket.on('kicked', () => {
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
  function renderGames(list) {
    const box = $('hh-games'); box.innerHTML = '';
    if (!list.length) box.appendChild(el('p', 'hint', 'No lobbies yet. Create one to get a code and QR.'));
    for (const g of list) {
      const b = el('button', 'gcard');
      b.appendChild(el('div', 'gcode', g.code));
      const meta = el('div', 'grow');
      meta.appendChild(el('div', 'gmeta', `${g.players} player${g.players === 1 ? '' : 's'}`));
      b.appendChild(meta);
      b.appendChild(el('span', 'pill' + (g.status === 'meeting' ? ' meeting' : g.status === 'playing' ? ' live' : ''), STATUS_TEXT[g.status]));
      b.onclick = () => openHostGame(g.code);
      box.appendChild(b);
    }
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
    for (const p of ['chat', 'tasks', 'players', 'control']) $('pane-' + p).classList.toggle('hidden', p !== t);
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
          'Kill crewmates without getting caught: post a ~5 second video of each kill with the 📹 button. Your tasks are fake — pretend to do them.',
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
    $('tab-tasks-btn').classList.toggle('hidden', isHost);
    $('tab-control-btn').classList.toggle('hidden', !isHost);
    if ((isHost && tab === 'tasks') || (!isHost && tab === 'control')) setTab('chat');

    renderBanner(v);
    renderMessages(v);

    // chat input lock
    const out = !isHost && me && inPlay && !me.alive;
    $('chat-form').classList.toggle('hidden', !!out);
    $('chat-locked').classList.toggle('hidden', !out);
    if (out) $('chat-locked').textContent = me.ejected
      ? "You were voted off. You can read the chat but can't send messages."
      : "You were killed. You can read the chat but can't send messages.";
    $('g-video').classList.toggle('hidden', isHost || !inPlay);

    renderTasks(v);
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
      d.appendChild(el('div', 'kill-title', m.text));
      const vid = document.createElement('video');
      vid.src = m.video; vid.controls = true; vid.playsInline = true; vid.preload = 'metadata'; vid.setAttribute('playsinline', '');
      d.appendChild(vid);
      return d;
    }
    const mine = !v.isHost ? m.from === myId : (m.host && host && m.name === host.name);
    const d = el('div', 'msg' + (mine ? ' mine' : '') + (m.host ? ' host' : ''));
    d.appendChild(el('div', 'who', m.host ? `${m.name} · HOST` : m.name));
    d.appendChild(el('div', 'bubble', m.text));
    return d;
  }
  function renderMessages(v) {
    const box = $('g-messages');
    const key = v.code + ':' + v.round;
    const overlap = v.messages.some((m) => renderedMsgIds.has(m.id));
    if (key !== renderedKey || (renderedMsgIds.size && !overlap)) {
      box.innerHTML = ''; renderedMsgIds.clear(); renderedKey = key;
    }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    let added = false;
    for (const m of v.messages) {
      if (renderedMsgIds.has(m.id)) continue;
      box.appendChild(msgEl(m, v)); renderedMsgIds.add(m.id); added = true;
    }
    if (added) {
      if (nearBottom) box.scrollTop = box.scrollHeight;
      if (tab !== 'chat') { unreadChat = true; updateChatBadge(); }
    }
  }

  function renderTasks(v) {
    const ul = $('g-tasks'); ul.innerHTML = '';
    const tasks = (v.me && v.me.tasks) || [];
    if (!tasks.length) { ul.appendChild(el('li', null, v.status === 'lobby' ? 'Your tasks will show up when the game starts.' : 'No tasks.')); return; }
    for (const t of tasks) {
      const li = el('li', t.done ? 'done' : '');
      li.appendChild(el('span', 'check', t.done ? '✓' : ''));
      li.appendChild(el('span', 't', t.text));
      ul.appendChild(li);
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
      shownMeetingId = m.id; meetingHidden = false;
      const box = $('mt-video'); box.innerHTML = '';
      const vid = document.createElement('video');
      vid.src = m.video; vid.controls = true; vid.autoplay = true; vid.muted = true; vid.loop = true; vid.playsInline = true; vid.setAttribute('playsinline', '');
      box.appendChild(vid);
      const seen = seenGet(v.code);
      if (seen.meeting !== m.id) {
        seenSet(v.code, { meeting: m.id });
        alarm();
        ov.classList.remove('flash'); void ov.offsetWidth; ov.classList.add('flash');
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
  $('g-video').onclick = () => {
    const v = view; if (!v || !v.me) return;
    if (v.status === 'meeting') return toast('Wait until the vote is over.');
    if (v.status !== 'playing') return toast('The game has not started yet.');
    if (v.me.role !== 'imposter') return toast('Only imposters can post kill videos.');
    if (!v.me.alive) return toast("You're out of the game.");
    openKill();
  };
  function openKill() {
    killVictim = null; killFile = null;
    $('kl-step1').classList.remove('hidden'); $('kl-step2').classList.add('hidden');
    const grid = $('kl-victims'); grid.innerHTML = '';
    const partners = new Set(view.me.partners);
    const targets = view.players.filter((p) => p.alive && p.id !== view.me.id && !partners.has(p.name));
    for (const p of targets) {
      const b = el('button', 'vote-btn', p.name);
      b.onclick = () => { killVictim = p; $('kl-vname').textContent = p.name; resetKillStep2(); $('kl-step1').classList.add('hidden'); $('kl-step2').classList.remove('hidden'); };
      grid.appendChild(b);
    }
    $('ov-kill').classList.remove('hidden');
  }
  function resetKillStep2() {
    killFile = null; $('kl-file').value = '';
    const pv = $('kl-preview'); pv.classList.add('hidden'); pv.removeAttribute('src');
    $('kl-info').textContent = ''; $('kl-send').classList.add('hidden'); $('kl-bar').classList.add('hidden'); $('kl-send').disabled = false;
  }
  $('kl-close').onclick = () => { $('ov-kill').classList.add('hidden'); resetKillStep2(); };
  $('kl-backstep').onclick = () => { resetKillStep2(); $('kl-step2').classList.add('hidden'); $('kl-step1').classList.remove('hidden'); };
  $('kl-file').onchange = (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    killFile = f;
    const pv = $('kl-preview'); pv.src = URL.createObjectURL(f); pv.classList.remove('hidden'); pv.play().catch(() => {});
    const mb = (f.size / 1048576).toFixed(1);
    $('kl-info').textContent = `${mb} MB`;
    $('kl-send').classList.remove('hidden');
    pv.onloadedmetadata = () => {
      const d = pv.duration;
      if (isFinite(d) && d > 9) {
        $('kl-info').textContent = `That's ${Math.round(d)} seconds — keep it to about 5. Tap Record video to try again.`;
        $('kl-send').classList.add('hidden'); killFile = null;
      } else if (isFinite(d)) $('kl-info').textContent = `${d.toFixed(1)} s · ${mb} MB`;
    };
  };
  $('kl-send').onclick = () => {
    if (!killFile || !killVictim) return;
    $('kl-send').disabled = true; $('kl-bar').classList.remove('hidden'); $('kl-bar-fill').style.width = '0%';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/kill?code=${encodeURIComponent(currentCode)}&victim=${encodeURIComponent(killVictim.id)}`);
    xhr.setRequestHeader('x-player-token', player.token);
    xhr.setRequestHeader('Content-Type', killFile.type || 'video/mp4');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) $('kl-bar-fill').style.width = Math.round((e.loaded / e.total) * 100) + '%'; };
    xhr.onload = () => {
      let r = {}; try { r = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200) { $('ov-kill').classList.add('hidden'); resetKillStep2(); toast('Kill posted. Act natural. 🤫'); }
      else { toast(r.error || 'Upload failed.'); $('kl-send').disabled = false; }
    };
    xhr.onerror = () => { toast('Upload failed — check the Wi-Fi.'); $('kl-send').disabled = false; };
    xhr.send(killFile);
  };

  // ---------- keep the screen awake during a game (needs https, e.g. the hosted version) ----------
  let wakeLock = null;
  async function keepAwake() {
    if (!('wakeLock' in navigator) || !currentCode || document.visibilityState !== 'visible' || wakeLock) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch {}
  }
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('pointerdown', keepAwake, { passive: true });

  // ---------- boot ----------
  if (!socket.connected) show(host ? (host.name ? 'hosthome' : 'hostlogin') : player ? 'game' : 'join');
  if (host) $('hh-name').textContent = host.name;
  if (player && !host) currentCode = player.code;
})();
