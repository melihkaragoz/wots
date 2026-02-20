'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const MM_W = 180, MM_H = 120;
const LERP_CAM  = 0.14;
const LOCAL_SPD = 6;     // must match server SW_SPEED
const CAM_LEAD  = 60;

// ── Default keybindings (KeyCode strings) ──────────────────────────────────
const DEFAULT_KB = {
  bomb:         'Space',
  invisibility: 'KeyQ',
  shield:       'KeyE',
  dash:         'KeyR',
  chat:         'Enter',
};

let kb = {};
function loadKB() {
  try { kb = { ...DEFAULT_KB, ...JSON.parse(localStorage.getItem('snakeKB') || '{}') }; }
  catch { kb = { ...DEFAULT_KB }; }
}
function saveKB() { localStorage.setItem('snakeKB', JSON.stringify(kb)); }
loadKB();

// ── DOM ───────────────────────────────────────────────────────────────────
const canvas    = document.getElementById('cvs');
const ctx       = canvas.getContext('2d');
const chatWrap  = document.getElementById('chat-input-wrap');
const chatInput = document.getElementById('chat-input');
const chatMsgs  = document.getElementById('chat-msgs');
const gameEl    = document.getElementById('game');

// ── State ─────────────────────────────────────────────────────────────────
let myId         = null;   // 'p_' + socket.id
let snakes       = [];
let fruits       = [];
let bombs        = [];
let mines        = [];
let cam          = { x: 0, y: 0 };
let camTarget    = { x: 0, y: 0 };
let mapW         = 5000, mapH = 5000;
let alive        = false;
let chatOpen     = false;
let currentRoomId   = null;
let currentRoomData = null;
let timeLeft     = 0;
let matchRunning = false;

// Client-side prediction
let predX = 0, predY = 0, predReady = false;

// Mouse
let mouseClientX = 0, mouseClientY = 0;
let mouseX = 0, mouseY = 0;
let boosting = false;

// Slingshot
let spaceHeld = false, spaceStartTime = 0;

// Effects
const hitFlashes = {};
const bombBlasts = [];

// ── Nick / animal persisted in localStorage ────────────────────────────────
let lobbyNick          = localStorage.getItem('snakeNick')   || '';
let lobbySelectedAnimal = localStorage.getItem('snakeAnimal') || 'snake';
let lobbyReady         = false;

// ── Canvas resize ─────────────────────────────────────────────────────────
function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
window.addEventListener('resize', resize);
resize();

// ── Socket ────────────────────────────────────────────────────────────────
const _savedToken = localStorage.getItem('snakeToken');
const socket = io('/snake', _savedToken ? { auth: { token: _savedToken } } : {});

// ── Screen management ─────────────────────────────────────────────────────
const ALL_SCREENS = ['rooms-screen', 'lobby-screen', 'countdown-screen', 'game', 'match-end'];
function showScreen(id) {
  ALL_SCREENS.forEach(sid => {
    const el = document.getElementById(sid);
    if (el) el.classList.add('hidden');
  });
  const target = document.getElementById(id);
  if (target) target.classList.remove('hidden');
}

// ── Game state reset ───────────────────────────────────────────────────────
function resetGameState() {
  snakes = []; fruits = []; bombs = []; mines = [];
  timeLeft = 0; matchRunning = false; alive = false;
  predReady = false; boosting = false; spaceHeld = false;
  Object.keys(hitFlashes).forEach(k => delete hitFlashes[k]);
  bombBlasts.length = 0;
}

// ── UI object (referenced from HTML onclick attrs) ─────────────────────────
const UI = {
  openCreateRoom() {
    SFX.uiOpen();
    document.getElementById('create-modal').classList.remove('hidden');
  },

  closeModal() {
    SFX.uiClose();
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
    listeningFor = null;
    document.querySelectorAll('.kb-key').forEach(k => k.classList.remove('listening'));
  },

  refreshRooms() {
    socket.emit('list_rooms');
  },

  createRoom() {
    const name     = document.getElementById('room-name').value.trim() || 'Oda';
    const cap      = parseInt(document.getElementById('room-cap').value) || 8;
    const pw       = document.getElementById('room-pw').value || null;
    const npcFill  = document.getElementById('room-npc').checked;
    const duration = parseInt(document.getElementById('room-duration').value) || 10;
    socket.emit('create_room', { name, capacity: cap, npcFill, password: pw || undefined, duration });
    UI.closeModal();
  },

  joinRoom(roomId, hasPassword) {
    if (hasPassword) {
      pendingJoinRoomId = roomId;
      document.getElementById('join-pw').value = '';
      document.getElementById('join-modal').classList.remove('hidden');
    } else {
      _doJoin(roomId, null);
    }
  },

  confirmJoin() {
    const pw = document.getElementById('join-pw').value;
    UI.closeModal();
    if (pendingJoinRoomId) _doJoin(pendingJoinRoomId, pw);
  },

  leaveRoom() {
    socket.emit('leave_room');
    currentRoomId = null;
    resetGameState();
    showScreen('rooms-screen');
    socket.emit('list_rooms');
  },

  toggleReady() {
    SFX.uiClick();
    lobbyReady = !lobbyReady;
    const btn = document.getElementById('ready-btn');
    if (btn) {
      btn.textContent = lobbyReady ? 'Hazır Değil' : 'Hazır';
      btn.classList.toggle('btn-ready-active', lobbyReady);
    }
    socket.emit('ready', { ready: lobbyReady });
  },

  openKeybindings() {
    renderKBList();
    document.getElementById('kb-modal').classList.remove('hidden');
  },

  backToRooms() {
    socket.emit('leave_room');
    currentRoomId = null;
    resetGameState();
    showScreen('rooms-screen');
    socket.emit('list_rooms');
  },

  rejoinRoom() {
    // Re-create a room with the same config as the last room
    if (currentRoomData) {
      socket.emit('create_room', {
        name:     currentRoomData.name     || 'Oda',
        capacity: currentRoomData.capacity || 8,
        npcFill:  currentRoomData.npcFill  !== false,
      });
    } else {
      UI.backToRooms();
    }
  },
};

let pendingJoinRoomId = null;

function _doJoin(roomId, password) {
  socket.emit('join_room', {
    roomId,
    name:     lobbyNick || 'Oyuncu',
    animal:   lobbySelectedAnimal,
    password: password || undefined,
  });
}

// ── Lobby initialisation ───────────────────────────────────────────────────
function initLobby(roomState) {
  currentRoomData = roomState;
  document.getElementById('lobby-room-name').textContent = roomState.name || 'Oda';
  document.getElementById('lobby-cap').textContent       = `0/${roomState.capacity || '?'}`;
  document.getElementById('lobby-players').innerHTML     = '';
  document.getElementById('lobby-hint').textContent      = 'Hazır butonuna bas, oyun başlasın!';
  const lcMsgs = document.getElementById('lobby-chat-msgs');
  if (lcMsgs) lcMsgs.innerHTML = '';
  lobbyReady = false;
  const btn = document.getElementById('ready-btn');
  if (btn) { btn.textContent = 'Hazır'; btn.classList.remove('btn-ready-active'); }
  // Pre-fill nick from auth username if available and no saved nick
  if (Auth.isLoggedIn() && !lobbyNick) {
    lobbyNick = Auth.getUsername();
    localStorage.setItem('snakeNick', lobbyNick);
  }
  // Restore saved nick in the input
  const nickEl = document.getElementById('nick');
  if (nickEl) { nickEl.value = lobbyNick; }
  updateReadyBtn();
  showScreen('lobby-screen');
}

function updateReadyBtn() {
  const btn = document.getElementById('ready-btn');
  if (btn) btn.disabled = lobbyNick.length < 1;
}

// ── Hero card selection ────────────────────────────────────────────────────
document.querySelectorAll('.hero-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.hero-card').forEach(c => {
      c.classList.remove('selected');
      c.style.removeProperty('--sel-color');
    });
    card.classList.add('selected');
    card.style.setProperty('--sel-color', card.dataset.color);
    lobbySelectedAnimal = card.dataset.animal;
    localStorage.setItem('snakeAnimal', lobbySelectedAnimal);
  });
  // Restore previously selected animal
  if (card.dataset.animal === lobbySelectedAnimal) {
    card.classList.add('selected');
    card.style.setProperty('--sel-color', card.dataset.color);
  }
});

// Nick input
const nickInputEl = document.getElementById('nick');
if (nickInputEl) {
  nickInputEl.value = lobbyNick;
  nickInputEl.addEventListener('input', e => {
    lobbyNick = e.target.value.trim();
    localStorage.setItem('snakeNick', lobbyNick);
    updateReadyBtn();
  });
}

// ── Rooms list render ──────────────────────────────────────────────────────
function renderRooms(list) {
  const el = document.getElementById('rooms-list');
  if (!list || list.length === 0) {
    el.innerHTML = '<div class="rooms-empty">Aktif oda yok. İlk odayı sen oluştur!</div>';
    return;
  }
  const statusLabels = {
    waiting:   '<span class="room-status room-status-waiting">Beklemede</span>',
    countdown: '<span class="room-status room-status-countdown">Geri Sayım</span>',
    playing:   '<span class="room-status room-status-playing">Oyunda</span>',
    finished:  '<span class="room-status room-status-finished">Bitiyor</span>',
  };
  el.innerHTML = list.map(r => `
    <div class="room-card" onclick="UI.joinRoom('${r.id}',${!!r.hasPassword})">
      <span class="room-name">${escHtml(r.name)}${r.hasPassword ? ' 🔒' : ''}</span>
      <span class="room-info">
        ${statusLabels[r.status] || ''}
        <span class="cap-badge">${r.playerCount}/${r.capacity}</span>
        <span style="color:#888;font-size:.72rem">${r.duration || 10}dk</span>
        ${r.npcFill ? ' 🤖' : ''}
      </span>
    </div>
  `).join('');
}

// ── Lobby player list render ───────────────────────────────────────────────
function renderLobbyPlayers(players, capacity) {
  const el    = document.getElementById('lobby-players');
  const capEl = document.getElementById('lobby-cap');
  if (capEl) capEl.textContent = `${players.length}/${capacity}`;
  el.innerHTML = players.map(p => `
    <div class="lobby-player${p.socketId === socket.id ? ' lobby-player-me' : ''}${p.ready ? ' ready' : ''}">
      <span>${p.emoji || '🐍'}</span>
      <span style="flex:1">${escHtml(p.name)}${p.isHost ? ' 👑' : ''}</span>
      <span class="ready-dot"></span>
    </div>
  `).join('');
}

// ── Match end render ───────────────────────────────────────────────────────
function renderMatchEnd(leaderboard) {
  const lb     = document.getElementById('match-leaderboard');
  const rw     = document.getElementById('match-rewards');
  const medals = ['🥇', '🥈', '🥉'];
  lb.innerHTML = (leaderboard || []).map((e, i) => `
    <div class="lb-row${e.socketId === socket.id ? ' lb-row-me' : ''}">
      <span class="lb-rank">${medals[i] || (i + 1) + '.'}</span>
      <span class="lb-name">${escHtml(e.name || '')}${e.isNPC ? ' 🤖' : ''}</span>
      <span style="color:#ff6b6b;font-size:.85rem">⚔️ ${e.kills || 0}</span>
      <span class="lb-score">🏆 ${e.score || 0}</span>
    </div>
  `).join('');
  rw.innerHTML = '';
}

// ── Socket events ─────────────────────────────────────────────────────────
let authInited = false;
socket.on('connect', () => {
  myId = 'p_' + socket.id;
  if (currentRoomId) {
    // Re-join room after reconnect (e.g. after login)
    socket.emit('join_room', {
      roomId: currentRoomId,
      name: lobbyNick || 'Oyuncu',
      animal: lobbySelectedAnimal,
    });
  } else {
    socket.emit('list_rooms');
    showScreen('rooms-screen');
  }
  if (!authInited) {
    authInited = true;
    Auth.init();
  }
});

socket.on('rooms_list', (list) => {
  renderRooms(list);
});

socket.on('room_created', ({ roomId }) => {
  socket.emit('join_room', {
    roomId,
    name:   lobbyNick || 'Oyuncu',
    animal: lobbySelectedAnimal,
  });
});

socket.on('room_joined', ({ roomId, roomState }) => {
  currentRoomId = roomId;
  currentRoomData = roomState;
  if (roomState.status === 'playing') {
    // Mid-match join — match_start will be emitted by server for this socket
    resetGameState();
    matchRunning = true;
  } else {
    initLobby(roomState);
    if (roomState.players) renderLobbyPlayers(roomState.players, roomState.capacity);
  }
});

socket.on('room_state', (state) => {
  if (state.players) renderLobbyPlayers(state.players, state.capacity);
  if (state.name) {
    const nameEl = document.getElementById('lobby-room-name');
    if (nameEl) nameEl.textContent = state.name;
  }
  if (state.capacity && currentRoomData) currentRoomData.capacity = state.capacity;
});

socket.on('countdown', ({ seconds }) => {
  document.getElementById('countdown-num').textContent = seconds;
  showScreen('countdown-screen');
  if (seconds > 0) SFX.countdownTick();
  else SFX.countdownGo();
});

socket.on('countdown_cancelled', () => {
  showScreen('lobby-screen');
});

socket.on('match_start', ({ mapW: mW, mapH: mH }) => {
  mapW = mW || 5000; mapH = mH || 5000;
  resetGameState();
  matchRunning = true;
  const deadEl = document.getElementById('dead');
  if (deadEl) deadEl.classList.add('hidden');
  showScreen('game');
  SFX.matchStart();
});

let lastMyScore = 0;
let lastMyKills = 0;
socket.on('tick', (state) => {
  snakes = state.snakes || snakes;
  fruits = state.fruits || fruits;
  bombs  = state.bombs  || bombs;
  mines  = state.mines  || mines;
  if (state.mapW) { mapW = state.mapW; mapH = state.mapH; }
  if (state.timeLeft !== undefined) timeLeft = state.timeLeft;

  const me = snakes.find(s => s.id === myId);
  if (me) {
    if (!predReady) { predX = me.x; predY = me.y; predReady = true; }
    else {
      predX += (me.x - predX) * 0.25;
      predY += (me.y - predY) * 0.25;
    }
    // Detect score increase → fruit eat sound
    if (me.score > lastMyScore && lastMyScore > 0) {
      if (me.score - lastMyScore >= 5) SFX.eatSoul();
      else SFX.eatFruit();
    }
    // Detect kill
    if ((me.kills || 0) > lastMyKills && lastMyKills > 0) SFX.kill();
    lastMyScore = me.score;
    lastMyKills = me.kills || 0;

    const wasAlive = alive;
    alive = me.alive;
    // Death / respawn overlay + sounds
    const deadEl = document.getElementById('dead');
    if (wasAlive && !alive && deadEl) {
      SFX.death();
      document.getElementById('dead-score').textContent = `Skor: ${me.score || 0}`;
      deadEl.classList.remove('hidden');
    } else if (!wasAlive && alive && deadEl) {
      SFX.respawn();
      deadEl.classList.add('hidden');
    }
  }
});

socket.on('mineHit', ({ id, x, y, snakeId }) => {
  mines = mines.filter(m => m.id !== id);
  bombBlasts.push({ wx: x, wy: y, timer: 30, maxTimer: 30, radius: 120 });
  hitFlashes[snakeId] = 25;
  // Only play impact SFX if local player was hit
  if (snakeId === myId) SFX.mineHit();
});

socket.on('bombExplode', ({ x, y, hits, radius }) => {
  const r = radius || 375;
  const meHit = (hits || []).includes(myId);
  bombBlasts.push({ wx: x, wy: y, timer: 50, maxTimer: 50, radius: r, meHit });
  for (const id of (hits || [])) hitFlashes[id] = 20;
  // Only play explosion SFX if local player was hit or explosion is nearby
  const me = snakes.find(s => s.id === myId);
  const dist = me ? Math.hypot(me.x - x, me.y - y) : Infinity;
  if (meHit || dist < r * 2) SFX.bombExplode();
});

socket.on('match_end', ({ leaderboard, duration_sec }) => {
  matchRunning = false;
  SFX.matchEnd();
  const myEntry = (leaderboard || []).find(e => e.socketId === socket.id);
  renderMatchEnd(leaderboard);
  showScreen('match-end');
  // Claim rewards for logged-in users
  if (Auth.isLoggedIn() && myEntry) {
    const stats = {
      kills: myEntry.kills || 0,
      max_size: myEntry.maxSize || 0,
      duration_sec: duration_sec || 0,
      rank: myEntry.rank || 99,
    };
    Auth.claimMatchRewards(stats).then(result => {
      const rw = document.getElementById('match-rewards');
      if (rw) Auth.renderRewardsBox(rw, result);
      if (result && result.gold_earned > 0) SFX.goldEarned();
    });
  }
});

socket.on('room_closed', () => {
  resetGameState();
  currentRoomId = null;
  showScreen('rooms-screen');
  socket.emit('list_rooms');
});

socket.on('room_reset', () => {
  resetGameState();
  lobbyReady = false;
  const btn = document.getElementById('ready-btn');
  if (btn) { btn.textContent = 'Hazır'; btn.classList.remove('btn-ready-active'); }
  showScreen('lobby-screen');
});

socket.on('you_are_host', () => {
  // Server broadcasts room_state after host change, so no extra action needed
});

socket.on('player_invisible', ({ id }) => {
  const s = snakes.find(x => x.id === id);
  if (s) s.invisible = true;
});

socket.on('player_shielded', ({ id }) => {
  const s = snakes.find(x => x.id === id);
  if (s) s.shielded = true;
});

socket.on('chatMsg', ({ name, emoji, msg }) => {
  addChatMsg(name, emoji, msg);
  addLobbyChatMsg(name, emoji, msg);
  SFX.chat();
});

socket.on('error', ({ msg }) => {
  SFX.error();
  console.warn('Server error:', msg);
  const old = document.getElementById('sw-err-toast');
  if (old) old.remove();
  const toast = document.createElement('div');
  toast.id = 'sw-err-toast';
  toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);' +
    'background:#e84040;color:#fff;padding:10px 22px;border-radius:8px;z-index:9999;font-size:.9rem';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
});

// ── Chat ──────────────────────────────────────────────────────────────────
function addChatMsg(name, emoji, msg) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = `<span class="cm-who">${emoji} ${escHtml(name)}:</span>${escHtml(msg)}`;
  chatMsgs.appendChild(el);
  while (chatMsgs.children.length > 10) chatMsgs.removeChild(chatMsgs.firstChild);
  setTimeout(() => el.remove(), 10000);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function openChat() {
  chatOpen = true;
  chatWrap.classList.remove('hidden');
  chatInput.value = '';
  chatInput.focus();
}
function closeChat() {
  chatOpen = false;
  chatWrap.classList.add('hidden');
  chatInput.blur();
}
function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) { closeChat(); return; }
  socket.emit('chat', { msg });
  chatInput.value = '';
  closeChat();
}

// Lobby chat
function addLobbyChatMsg(name, emoji, msg) {
  const el = document.getElementById('lobby-chat-msgs');
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'lobby-chat-msg';
  div.innerHTML = `<span class="lcm-who">${emoji} ${escHtml(name)}:</span>${escHtml(msg)}`;
  el.appendChild(div);
  while (el.children.length > 30) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function sendLobbyChat() {
  const input = document.getElementById('lobby-chat-input');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chat', { msg });
  input.value = '';
}

chatInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter')  { e.preventDefault(); sendChat(); }
  if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
});

// ── Input ─────────────────────────────────────────────────────────────────
document.addEventListener('mousemove', e => {
  mouseClientX = e.clientX; mouseClientY = e.clientY;
  mouseX = e.clientX - canvas.width  / 2;
  mouseY = e.clientY - canvas.height / 2;
});

document.addEventListener('touchmove', e => {
  e.preventDefault();
  const t = e.touches[0];
  mouseClientX = t.clientX; mouseClientY = t.clientY;
  mouseX = t.clientX - canvas.width  / 2;
  mouseY = t.clientY - canvas.height / 2;
}, { passive: false });

document.addEventListener('touchstart', e => {
  const t = e.touches[0];
  mouseClientX = t.clientX; mouseClientY = t.clientY;
  mouseX = t.clientX - canvas.width  / 2;
  mouseY = t.clientY - canvas.height / 2;
}, { passive: false });

canvas.addEventListener('mousedown', e => {
  if (e.button !== 0 || !matchRunning || !alive) return;
  boosting = true;
  SFX.boostOn();
  socket.emit('boost', { on: true });
});
document.addEventListener('mouseup', e => {
  if (e.button !== 0 || !boosting) return;
  boosting = false;
  SFX.boostOff();
  socket.emit('boost', { on: false });
});
document.addEventListener('mouseleave', () => {
  if (boosting) { boosting = false; socket.emit('boost', { on: false }); }
});

// ── Keyboard ──────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (listeningFor) return;  // captured by rebind listener
  if (chatOpen) return;
  if (gameEl.classList.contains('hidden')) return;

  if (e.code === kb.chat || e.key === 'Enter') {
    e.preventDefault(); openChat(); return;
  }
  if (e.code === kb.bomb && alive && !spaceHeld) {
    e.preventDefault();
    spaceHeld = true; spaceStartTime = Date.now(); return;
  }
  if (alive) {
    if (e.code === kb.invisibility) { e.preventDefault(); SFX.invisibility(); socket.emit('use_active', { type: 'invisibility' }); }
    if (e.code === kb.shield)       { e.preventDefault(); SFX.shield(); socket.emit('use_active', { type: 'shield' }); }
    if (e.code === kb.dash)         { e.preventDefault(); SFX.dash(); socket.emit('use_active', { type: 'dash' }); }
  }
});

document.addEventListener('keyup', e => {
  if (e.code === kb.bomb && spaceHeld) {
    e.preventDefault();
    spaceHeld = false;
    if (!alive || !matchRunning) return;
    const charge = Math.min(1, (Date.now() - spaceStartTime) / 2000);
    if (charge > 0.05) {
      SFX.bombThrow();
      const snakeSX = predX - cam.x, snakeSY = predY - cam.y;
      socket.emit('throwBomb', {
        dir:   Math.atan2(mouseClientY - snakeSY, mouseClientX - snakeSX),
        power: charge,
      });
    }
  }
});

// Direction sending
let lastDirSent = 0;
function maybeSendDir() {
  if (!myId || !alive || !matchRunning) return;
  const snakeSX = predX - cam.x, snakeSY = predY - cam.y;
  const dx = mouseClientX - snakeSX, dy = mouseClientY - snakeSY;
  const dist = Math.hypot(dx, dy);
  if (dist < 8) return;
  const now = Date.now();
  if (now - lastDirSent > 16) {
    socket.emit('dir', { dir: Math.atan2(dy, dx) });
    lastDirSent = now;
  }
}

// ── Keybindings UI ────────────────────────────────────────────────────────
const KB_LABELS = {
  bomb:         '💣 Bomba at',
  invisibility: '👻 Görünmezlik',
  shield:       '🛡️ Kalkan',
  dash:         '💨 Dash',
  chat:         '💬 Sohbet',
};
let listeningFor = null;

function codeToDisplay(code) {
  if (!code) return '?';
  const map = { Space:'Space', Enter:'Enter', Escape:'Esc',
    ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→' };
  return map[code] || code.replace(/^Key/, '').replace(/^Digit/, '');
}

function renderKBList() {
  const list = document.getElementById('kb-list');
  list.innerHTML = Object.entries(KB_LABELS).map(([action, label]) => `
    <div class="kb-row">
      <span class="kb-label">${label}</span>
      <button class="kb-key" id="kbkey-${action}" onclick="startListening('${action}')">
        ${codeToDisplay(kb[action])}
      </button>
    </div>
  `).join('');
}

function startListening(action) {
  listeningFor = action;
  document.querySelectorAll('.kb-key').forEach(k => k.classList.remove('listening'));
  const btn = document.getElementById('kbkey-' + action);
  if (btn) { btn.classList.add('listening'); btn.textContent = '…'; }
}

// Capture phase — fires before the regular keydown handler
document.addEventListener('keydown', e => {
  if (!listeningFor) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.code === 'Escape') { listeningFor = null; renderKBList(); return; }
  kb[listeningFor] = e.code;
  saveKB();
  listeningFor = null;
  renderKBList();
}, true);

function resetKeybindings() {
  kb = { ...DEFAULT_KB };
  saveKB();
  renderKBList();
}

// ── Volume toggle ─────────────────────────────────────────────────────────
function toggleVolBtn() {
  const muted = SFX.toggleMute();
  const btn = document.getElementById('vol-btn');
  if (btn) btn.textContent = muted ? '🔇' : '🔊';
}

// ── Helpers ───────────────────────────────────────────────────────────────
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y,      x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x,      y + h, x,      y + h - r);
  ctx.lineTo(x, y + r);     ctx.quadraticCurveTo(x,      y,      x + r,  y);
  ctx.closePath();
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

// ── Render loop ───────────────────────────────────────────────────────────
function render() {
  requestAnimationFrame(render);
  if (gameEl.classList.contains('hidden')) return;

  const W = canvas.width, H = canvas.height;

  // Client-side position prediction
  if (predReady && alive) {
    const snakeSX = predX - cam.x, snakeSY = predY - cam.y;
    const dx = mouseClientX - snakeSX, dy = mouseClientY - snakeSY;
    const dist = Math.hypot(dx, dy);
    if (dist > 8) {
      const dir = Math.atan2(dy, dx);
      const spd = LOCAL_SPD * (boosting ? 3 : 1);
      predX += Math.cos(dir) * spd;
      predY += Math.sin(dir) * spd;
      predX = Math.max(12, Math.min(mapW - 12, predX));
      predY = Math.max(12, Math.min(mapH - 12, predY));
      const lead = Math.min(dist / 200, 1) * CAM_LEAD;
      camTarget.x = predX - W / 2 + Math.cos(dir) * lead;
      camTarget.y = predY - H / 2 + Math.sin(dir) * lead;
    } else {
      camTarget.x = predX - W / 2;
      camTarget.y = predY - H / 2;
    }
  }

  cam.x += (camTarget.x - cam.x) * LERP_CAM;
  cam.y += (camTarget.y - cam.y) * LERP_CAM;
  cam.x = Math.max(0, Math.min(mapW - W, cam.x));
  cam.y = Math.max(0, Math.min(mapH - H, cam.y));

  maybeSendDir();

  // ── Background ──────────────────────────────────────────────────────────
  ctx.fillStyle = '#07071e';
  ctx.fillRect(0, 0, W, H);

  const G = 80;
  ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 1;
  const ox = ((-cam.x) % G + G) % G, oy = ((-cam.y) % G + G) % G;
  for (let x = ox; x < W; x += G) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = oy; y < H; y += G) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  ctx.strokeStyle = 'rgba(255,80,80,0.5)'; ctx.lineWidth = 5;
  ctx.strokeRect(-cam.x, -cam.y, mapW, mapH);

  // ── Fruits ──────────────────────────────────────────────────────────────
  const now = Date.now();
  for (const f of fruits) {
    const sx = f.x - cam.x, sy = f.y - cam.y;
    if (sx < -80 || sx > W + 80 || sy < -80 || sy > H + 80) continue;

    if (f.soul) {
      const pulse = 1 + 0.22 * Math.sin(now / 280 + f.x * 0.005);
      const r = f.radius * pulse;
      for (let gi = 3; gi >= 1; gi--) {
        const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * gi * 1.4);
        gr.addColorStop(0, f.color + (gi === 1 ? '55' : gi === 2 ? '33' : '18'));
        gr.addColorStop(1, 'transparent');
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(sx, sy, r * gi * 1.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = f.color; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
      const angle = now / 600;
      ctx.strokeStyle = f.color + 'cc'; ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        const a = angle + i * Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(a) * (r + 3),  sy + Math.sin(a) * (r + 3));
        ctx.lineTo(sx + Math.cos(a) * (r + 10), sy + Math.sin(a) * (r + 10));
        ctx.stroke();
      }
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r * 0.75)}px Arial`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('✨', sx, sy);
    } else {
      const pulse = 1 + 0.12 * Math.sin(now / 400 + f.x);
      const r = f.radius * pulse;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 2.5);
      g.addColorStop(0, f.color + '44'); g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, r * 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = f.color; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  // ── Bombs ───────────────────────────────────────────────────────────────
  for (const b of bombs) {
    const sx = b.x - cam.x, sy = b.y - cam.y;
    if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) continue;
    const frac = b.t / 120;
    const pulse = 1 + 0.3 * Math.sin(now / 120);
    const bR = 14 * (frac < 0.2 ? pulse : 1);
    const intensity = Math.max(0.3, 1 - frac);
    const gl = ctx.createRadialGradient(sx, sy, 0, sx, sy, bR * 3);
    gl.addColorStop(0, `rgba(255,50,30,${0.5 * intensity})`);
    gl.addColorStop(1, 'transparent');
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(sx, sy, bR * 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(sx, sy, bR, 0, Math.PI * 2);
    ctx.fillStyle = '#111'; ctx.fill();
    ctx.strokeStyle = `rgba(255,80,30,${0.6 + 0.4 * intensity})`; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.font = `${Math.round(bR * 1.1)}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('💣', sx, sy);
    ctx.beginPath();
    ctx.arc(sx, sy, bR + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.strokeStyle = frac < 0.25 ? '#ff2200' : '#ffaa00'; ctx.lineWidth = 2; ctx.stroke();
  }

  // ── Bomb blast effects ───────────────────────────────────────────────────
  for (let i = bombBlasts.length - 1; i >= 0; i--) {
    const bl = bombBlasts[i]; bl.timer--;
    if (bl.timer <= 0) { bombBlasts.splice(i, 1); continue; }
    const sx = bl.wx - cam.x, sy = bl.wy - cam.y;
    const prog = 1 - bl.timer / bl.maxTimer, alpha = bl.timer / bl.maxTimer;
    const r = bl.radius * prog;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,160,30,${alpha * 0.9})`; ctx.lineWidth = 12 * (1 - prog) + 2; ctx.stroke();
    if (prog > 0.2) {
      const r2 = bl.radius * 0.55 * prog;
      ctx.beginPath(); ctx.arc(sx, sy, r2, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,220,80,${alpha * 0.6})`; ctx.lineWidth = 6 * (1 - prog) + 1; ctx.stroke();
    }
    if (prog < 0.5) {
      const fb = bl.radius * 0.35 * (0.5 - prog) / 0.5;
      const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, fb);
      grd.addColorStop(0, `rgba(255,240,120,${alpha})`);
      grd.addColorStop(0.5, `rgba(255,100,20,${alpha * 0.7})`);
      grd.addColorStop(1, 'transparent');
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(sx, sy, fb, 0, Math.PI * 2); ctx.fill();
    }
    if (bl.timer > bl.maxTimer * 0.75 && bl.meHit) {
      ctx.fillStyle = `rgba(255,120,0,${alpha * 0.18})`; ctx.fillRect(0, 0, W, H);
    }
  }

  // ── Mines ───────────────────────────────────────────────────────────────
  for (const m of mines) {
    const sx = m.x - cam.x, sy = m.y - cam.y;
    if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) continue;
    const pulse = 1 + 0.08 * Math.sin(now / 700 + m.x * 0.02);
    const r = 11 * pulse;
    const gl = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 3);
    gl.addColorStop(0, 'rgba(200,20,20,0.35)'); gl.addColorStop(1, 'transparent');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(sx, sy, r * 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#1c0808'; ctx.fill();
    ctx.strokeStyle = '#bb1111'; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = '#cc2222'; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r);
      ctx.lineTo(sx + Math.cos(a) * (r + 7), sy + Math.sin(a) * (r + 7));
      ctx.stroke();
    }
    ctx.font = `${Math.round(r * 1.1)}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('💀', sx, sy);
  }

  // ── Snakes ──────────────────────────────────────────────────────────────
  const sorted = [...snakes].sort((a, b) => (+a.alive) - (+b.alive));
  for (const s of sorted) drawSnake(s);

  // ── Slingshot rubber band ────────────────────────────────────────────────
  if (spaceHeld && alive && predReady) {
    const charge = Math.min(1, (Date.now() - spaceStartTime) / 2000);
    const snakeSX = predX - cam.x, snakeSY = predY - cam.y;
    const throwDir = Math.atan2(mouseClientY - snakeSY, mouseClientX - snakeSX);
    const pullDist = 30 + charge * 80;
    const pullX = snakeSX - Math.cos(throwDir) * pullDist;
    const pullY = snakeSY - Math.sin(throwDir) * pullDist;
    const me2 = snakes.find(s => s.id === myId);
    const bodyR2 = me2 ? Math.max(6, Math.min(22, 6 + me2.len / 40)) : 10;
    const perpX = -Math.sin(throwDir) * (bodyR2 + 6);
    const perpY =  Math.cos(throwDir) * (bodyR2 + 6);
    const cr = Math.round(charge * 255), cg = Math.round((1 - charge) * 200);
    const bandColor = `rgb(${cr},${cg},30)`;
    ctx.save();
    ctx.setLineDash([7, 7]);
    ctx.strokeStyle = `rgba(${cr},${cg},30,0.55)`; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(snakeSX, snakeSY);
    ctx.lineTo(snakeSX + Math.cos(throwDir) * (120 + charge * 450),
               snakeSY + Math.sin(throwDir) * (120 + charge * 450));
    ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = bandColor; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(snakeSX + perpX, snakeSY + perpY); ctx.lineTo(pullX, pullY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(snakeSX - perpX, snakeSY - perpY); ctx.lineTo(pullX, pullY); ctx.stroke();
    ctx.font = `${Math.round(16 + charge * 8)}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('💣', pullX, pullY);
    ctx.beginPath();
    ctx.arc(snakeSX, snakeSY, bodyR2 + 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * charge);
    ctx.strokeStyle = bandColor; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  }

  drawMinimap(W, H);
  drawHUD(W, H);

  for (const id of Object.keys(hitFlashes)) {
    hitFlashes[id]--;
    if (hitFlashes[id] <= 0) delete hitFlashes[id];
  }
}

function drawSnake(s) {
  const body = s.body;
  if (!body || body.length < 2) return;
  const W = canvas.width, H = canvas.height;
  const isMe  = s.id === myId;
  const flash = hitFlashes[s.id] > 0;
  const bodyR = Math.max(6, Math.min(22, 6 + s.len / 40));
  const hx = s.x - cam.x, hy = s.y - cam.y;

  // Bounding-box cull
  let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
  for (const p of body) {
    const px = p.x - cam.x, py = p.y - cam.y;
    if (px < bMinX) bMinX = px; if (px > bMaxX) bMaxX = px;
    if (py < bMinY) bMinY = py; if (py > bMaxY) bMaxY = py;
  }
  const mg = bodyR + 10;
  if (bMaxX < -mg || bMinX > W + mg || bMaxY < -mg || bMinY > H + mg) return;

  ctx.save();
  if (s.invisible) {
    if (!isMe) { ctx.restore(); return; }
    ctx.globalAlpha = 0.25;
  } else {
    ctx.globalAlpha = s.alive ? 1 : 0.2;
  }

  // Shield glow
  if (s.shielded) {
    const shieldGlow = ctx.createRadialGradient(hx, hy, bodyR, hx, hy, bodyR * 3.5);
    shieldGlow.addColorStop(0, 'rgba(80,160,255,0.5)');
    shieldGlow.addColorStop(1, 'transparent');
    ctx.fillStyle = shieldGlow;
    ctx.beginPath(); ctx.arc(hx, hy, bodyR * 3.5, 0, Math.PI * 2); ctx.fill();
  }

  // Body
  ctx.beginPath();
  ctx.moveTo(body[0].x - cam.x, body[0].y - cam.y);
  for (let i = 1; i < body.length; i++) ctx.lineTo(body[i].x - cam.x, body[i].y - cam.y);
  ctx.strokeStyle = flash ? '#ffffff' : s.bodyColor;
  ctx.lineWidth = bodyR * 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();

  // Boost speed lines
  if (s.boosting) {
    const behind = s.dir + Math.PI;
    for (let i = 0; i < 5; i++) {
      const lineDir = behind + (i - 2) * 0.28;
      const len = (25 + Math.random() * 30) * (isMe ? 1 : 0.7);
      const lx = hx + Math.cos(lineDir) * (bodyR + 4);
      const ly = hy + Math.sin(lineDir) * (bodyR + 4);
      ctx.beginPath(); ctx.moveTo(lx, ly);
      ctx.lineTo(lx + Math.cos(lineDir) * len, ly + Math.sin(lineDir) * len);
      ctx.strokeStyle = `rgba(255,220,80,${0.6 - Math.abs(i - 2) * 0.15})`;
      ctx.lineWidth = 2 - Math.abs(i - 2) * 0.4; ctx.lineCap = 'round'; ctx.stroke();
    }
  }

  // Head glow (player only)
  if (isMe) {
    const glowColor = s.boosting ? '#ffdd44' : s.headColor;
    const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, bodyR * (s.boosting ? 4 : 2.8));
    glow.addColorStop(0, glowColor + '66'); glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(hx, hy, bodyR * (s.boosting ? 4 : 2.8), 0, Math.PI * 2); ctx.fill();
  }

  // Head circle
  const hR = bodyR + 4;
  ctx.beginPath(); ctx.arc(hx, hy, hR, 0, Math.PI * 2);
  ctx.fillStyle = flash ? '#ffffff' : s.headColor; ctx.fill();
  ctx.strokeStyle = isMe ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)';
  ctx.lineWidth = isMe ? 2.5 : 1.5; ctx.stroke();

  // Eyes
  const eOff = hR * 0.55;
  for (const side of [-1, 1]) {
    const ex = hx + Math.cos(s.dir + side * 0.52) * eOff;
    const ey = hy + Math.sin(s.dir + side * 0.52) * eOff;
    const eR = hR * 0.3;
    ctx.beginPath(); ctx.arc(ex, ey, eR, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(
      ex + Math.cos(s.dir) * eR * 0.5, ey + Math.sin(s.dir) * eR * 0.5, eR * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = '#111'; ctx.fill();
  }

  // Name tag
  if (hx > -150 && hx < W + 150 && hy > -80 && hy < H + 80) {
    const fontSize = Math.max(11, Math.min(15, 11 + s.len / 60));
    ctx.font = `bold ${fontSize}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const label = `${s.emoji} ${s.name}`;
    const tagY = hy - hR - 4;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillText(label, hx + 1, tagY + 1);
    ctx.fillStyle = isMe ? '#ffd700' : '#fff'; ctx.fillText(label, hx, tagY);
  }

  ctx.restore();
}

function drawMinimap(W, H) {
  const MX = 12, MY = H - MM_H - 12;
  ctx.fillStyle = 'rgba(4,4,18,0.85)';
  roundRect(MX, MY, MM_W, MM_H, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(80,80,160,0.45)'; ctx.lineWidth = 1;
  roundRect(MX, MY, MM_W, MM_H, 8); ctx.stroke();
  ctx.save(); roundRect(MX, MY, MM_W, MM_H, 8); ctx.clip();

  const scX = MM_W / mapW, scY = MM_H / mapH;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  for (const f of fruits) {
    ctx.beginPath(); ctx.arc(MX + f.x * scX, MY + f.y * scY, 1.5, 0, Math.PI * 2); ctx.fill();
  }
  for (const m of mines) {
    ctx.beginPath(); ctx.arc(MX + m.x * scX, MY + m.y * scY, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#cc2222'; ctx.fill();
  }
  for (const b of bombs) {
    ctx.beginPath(); ctx.arc(MX + b.x * scX, MY + b.y * scY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4422'; ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
  ctx.strokeRect(MX + cam.x * scX, MY + cam.y * scY, canvas.width * scX, canvas.height * scY);
  for (const s of snakes) {
    if (!s.alive) continue;
    const isMe = s.id === myId;
    ctx.beginPath(); ctx.arc(MX + s.x * scX, MY + s.y * scY, isMe ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = s.headColor; ctx.fill();
    if (isMe) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = '8px Arial'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('MİNİHARİTA', MX + 5, MY + 4);
}

function drawHUD(W, H) {
  const me = snakes.find(s => s.id === myId);

  // Match timer — top centre
  if (matchRunning && timeLeft > 0) {
    const urgent = timeLeft <= 30;
    ctx.font = `bold ${urgent ? 22 : 18}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = urgent ? '#ff4444' : 'rgba(255,255,255,0.9)';
    ctx.fillText(`⏱ ${formatTime(timeLeft)}`, W / 2, 12);
  }

  // Player info — top left
  let topTxt = me
    ? `${me.emoji} ${me.name}  |  Skor: ${me.score}  |  Boy: ${me.len}`
    : 'Bağlanılıyor…';
  if (me && Auth.isLoggedIn()) {
    const gold = document.getElementById('header-gold')?.textContent || '0';
    topTxt += `  |  💰 ${gold}`;
  }
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.font = 'bold 15px Arial'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(topTxt, 14, 14);

  const bombKey  = codeToDisplay(kb.bomb);
  const canBomb  = me && me.alive && me.len >= 45;
  const bombTxt  = canBomb
    ? `💣 [${bombKey}] Bomba at (−40 boy)`
    : me && me.len < 45
      ? `💣 Bomba için ${45 - me.len} daha gerek`
      : '';
  if (bombTxt) {
    ctx.font = '12px Arial';
    ctx.fillStyle = canBomb ? '#ffcc44' : 'rgba(255,255,255,0.35)';
    ctx.fillText(bombTxt, 14, 34);
  }

  ctx.font = '11px Arial';
  ctx.fillStyle = me && me.boosting ? '#ffdd44' : 'rgba(255,255,255,0.3)';
  ctx.fillText(me && me.boosting ? '🚀 BOOST aktif — boy eriyor!' : '🖱️ [Sol Tık] Boost (boy harcar)', 14, 54);

  let hintY = 70;
  if (me && me.alive) {
    const abilities = [
      { code: kb.invisibility, icon: '👻', name: 'Görünmezlik' },
      { code: kb.shield,       icon: '🛡️', name: 'Kalkan' },
      { code: kb.dash,         icon: '💨', name: 'Dash' },
    ];
    ctx.fillStyle = 'rgba(180,180,255,0.35)';
    for (const ab of abilities) {
      ctx.fillText(`${ab.icon} [${codeToDisplay(ab.code)}] ${ab.name}`, 14, hintY);
      hintY += 16;
    }
  }
  ctx.fillStyle = 'rgba(180,180,255,0.35)';
  ctx.fillText(`💬 [${codeToDisplay(kb.chat)}] Sohbet`, 14, hintY);

  // Leaderboard — top right
  const aliveSnakes = [...snakes].filter(s => s.alive).sort((a, b) => b.len - a.len).slice(0, 6);
  const lbW = 200, lbH = 22 + aliveSnakes.length * 22 + 6;
  const lbX = W - lbW - 14, lbY = 14;
  ctx.fillStyle = 'rgba(4,4,20,0.72)';
  roundRect(lbX, lbY, lbW, lbH, 8); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = 'bold 10px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('🏆 LİDERLER', lbX + lbW / 2, lbY + 5);
  for (let i = 0; i < aliveSnakes.length; i++) {
    const s    = aliveSnakes[i];
    const isMe = s.id === myId;
    const y    = lbY + 22 + i * 22;
    ctx.font      = isMe ? 'bold 12px Arial' : '11px Arial';
    ctx.fillStyle = isMe ? '#ffd700' : 'rgba(255,255,255,0.8)';
    ctx.textAlign = 'left';
    ctx.fillText(`${i + 1}. ${s.emoji} ${s.name}${s.isNPC ? ' 🤖' : ''}`, lbX + 10, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = isMe ? '#ffd700' : 'rgba(255,255,255,0.5)';
    ctx.fillText(`${s.len}`, lbX + lbW - 8, y);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
showScreen('rooms-screen');
render();
