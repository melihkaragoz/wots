'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const MM_W = 180, MM_H = 120;
const LERP_CAM   = 0.14;   // camera smoothing
const LOCAL_SPD  = 6;      // must match server SW_SPEED
const CAM_LEAD   = 60;     // px look-ahead in movement direction

// ── DOM ───────────────────────────────────────────────────────────────────
const selEl      = document.getElementById('selection');
const gameEl     = document.getElementById('game');
const canvas     = document.getElementById('cvs');
const ctx        = canvas.getContext('2d');
const deadEl     = document.getElementById('dead');
const deadScore  = document.getElementById('dead-score');
const respawnBtn = document.getElementById('respawn-btn');
const nickInput  = document.getElementById('nick');
const playBtn    = document.getElementById('play-btn');
const heroCards  = document.querySelectorAll('.hero-card');
const chatWrap   = document.getElementById('chat-input-wrap');
const chatInput  = document.getElementById('chat-input');
const chatMsgs   = document.getElementById('chat-msgs');

// ── State ─────────────────────────────────────────────────────────────────
let myId         = null;
let snakes       = [];
let fruits       = [];
let bombs        = [];
let cam          = { x: 0, y: 0 };
let camTarget    = { x: 0, y: 0 };
let mapW         = 5000, mapH = 5000;
let alive        = false;
let selectedAnimal = null;
let chatOpen     = false;

// Client-side predicted head position (smooth movement)
let predX = 0, predY = 0;
let predReady = false;

// Mouse — absolute client coords
let mouseClientX = 0, mouseClientY = 0;
// Keep centre-relative aliases used elsewhere
let mouseX = 0, mouseY = 0;
let boosting = false;

// Slingshot state
let spaceHeld = false;
let spaceStartTime = 0;

// Hit flash effect
const hitFlashes = {};  // snakeId → timer

// Bomb visual effects
const bombBlasts = [];

// ── Canvas ────────────────────────────────────────────────────────────────
function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
window.addEventListener('resize', resize);
resize();

// ── Socket ────────────────────────────────────────────────────────────────
const socket = io('/snake');

socket.on('joined', (data) => {
  myId   = data.id;
  mapW   = data.mapW;
  mapH   = data.mapH;
  alive  = true;
  predReady = false;
  selEl.style.display  = 'none';
  gameEl.classList.remove('hidden');
  deadEl.classList.add('hidden');
});

socket.on('tick', (state) => {
  snakes = state.snakes || snakes;
  fruits = state.fruits || fruits;
  bombs  = state.bombs  || bombs;
  if (state.mapW) { mapW = state.mapW; mapH = state.mapH; }

  const me = snakes.find(s => s.id === myId);
  if (me) {
    // Sync prediction with authoritative server position
    if (!predReady) { predX = me.x; predY = me.y; predReady = true; }
    else {
      // Gentle correction (don't snap)
      predX += (me.x - predX) * 0.25;
      predY += (me.y - predY) * 0.25;
    }

    if (!me.alive && alive) {
      alive = false;
      deadScore.textContent = me.score;
      deadEl.classList.remove('hidden');
    }
  }
});

socket.on('bombExplode', ({ x, y, hits, radius }) => {
  bombBlasts.push({ wx: x, wy: y, timer: 50, maxTimer: 50, radius: radius || 750 });
  for (const id of (hits || [])) hitFlashes[id] = 20;
});

socket.on('respawned', () => {
  alive = true;
  predReady = false;
  deadEl.classList.add('hidden');
});

socket.on('chatMsg', ({ name, emoji, msg }) => {
  addChatMsg(name, emoji, msg);
});

// ── Hero selection ─────────────────────────────────────────────────────────
heroCards.forEach(card => {
  card.addEventListener('click', () => {
    heroCards.forEach(c => { c.classList.remove('selected'); c.style.removeProperty('--sel-color'); });
    card.classList.add('selected');
    card.style.setProperty('--sel-color', card.dataset.color);
    selectedAnimal = card.dataset.animal;
    checkReady();
  });
});
nickInput.addEventListener('input', checkReady);
function checkReady() {
  playBtn.disabled = !selectedAnimal || nickInput.value.trim().length < 1;
}
playBtn.addEventListener('click', () => {
  socket.emit('join', { name: nickInput.value.trim() || 'Oyuncu', animal: selectedAnimal });
});

respawnBtn.addEventListener('click', () => socket.emit('respawn'));

// ── Chat ──────────────────────────────────────────────────────────────────
function addChatMsg(name, emoji, msg) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = `<span class="cm-who">${emoji} ${escHtml(name)}:</span>${escHtml(msg)}`;
  chatMsgs.appendChild(el);
  // Keep last 10 visible
  while (chatMsgs.children.length > 10) chatMsgs.removeChild(chatMsgs.firstChild);
  // Auto-remove after 10s
  setTimeout(() => el.remove(), 10000);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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

// ── Input ─────────────────────────────────────────────────────────────────
document.addEventListener('mousemove', e => {
  mouseClientX = e.clientX;
  mouseClientY = e.clientY;
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

// Boost on left-click hold
canvas.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  boosting = true;
  socket.emit('boost', { on: true });
});
document.addEventListener('mouseup', e => {
  if (e.button !== 0) return;
  boosting = false;
  socket.emit('boost', { on: false });
});
// Safety: stop boost if mouse leaves window
document.addEventListener('mouseleave', () => {
  if (boosting) { boosting = false; socket.emit('boost', { on: false }); }
});

// chatInput handles its OWN Enter/Escape — stopPropagation keeps game keys out
chatInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter')  { e.preventDefault(); sendChat(); }
  if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
});

document.addEventListener('keydown', e => {
  if (chatOpen) return; // chatInput takes over while chat is open

  if (e.key === 'Enter') {
    e.preventDefault();
    if (!gameEl.classList.contains('hidden')) openChat();
    return;
  }

  if ((e.code === 'Space' || e.key === ' ') && alive && !spaceHeld) {
    e.preventDefault();
    spaceHeld = true;
    spaceStartTime = Date.now();
  }
});

document.addEventListener('keyup', e => {
  if ((e.code === 'Space' || e.key === ' ') && spaceHeld) {
    e.preventDefault();
    spaceHeld = false;
    if (!alive) return;
    const charge = Math.min(1, (Date.now() - spaceStartTime) / 2000);
    if (charge > 0.05) {
      const snakeSX = predX - cam.x;
      const snakeSY = predY - cam.y;
      const throwDir = Math.atan2(mouseClientY - snakeSY, mouseClientX - snakeSX);
      socket.emit('throwBomb', { dir: throwDir, power: charge });
    }
  }
});

// Send direction every frame via rAF (inside render loop)
let lastDirSent = 0;
function maybeSendDir() {
  if (!myId || !alive) return;
  // Direction from snake's real screen position → cursor (not from screen centre)
  const snakeSX = predX - cam.x;
  const snakeSY = predY - cam.y;
  const dx = mouseClientX - snakeSX;
  const dy = mouseClientY - snakeSY;
  const dist = Math.hypot(dx, dy);
  if (dist < 8) return;
  const dir = Math.atan2(dy, dx);
  const now = Date.now();
  if (now - lastDirSent > 16) {
    socket.emit('dir', { dir });
    lastDirSent = now;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Render ────────────────────────────────────────────────────────────────
function render() {
  requestAnimationFrame(render);
  if (!myId) return;

  const W = canvas.width, H = canvas.height;

  // Client-side position prediction — always toward actual cursor position
  if (predReady && alive) {
    const snakeSX = predX - cam.x;
    const snakeSY = predY - cam.y;
    const dx = mouseClientX - snakeSX;
    const dy = mouseClientY - snakeSY;
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

  // Smooth camera
  cam.x += (camTarget.x - cam.x) * LERP_CAM;
  cam.y += (camTarget.y - cam.y) * LERP_CAM;
  cam.x = Math.max(0, Math.min(mapW - W, cam.x));
  cam.y = Math.max(0, Math.min(mapH - H, cam.y));

  // Send direction every frame
  maybeSendDir();

  // ── Background ──────────────────────────────────────────────────────────
  ctx.fillStyle = '#07071e';
  ctx.fillRect(0, 0, W, H);

  // Grid
  const G = 80;
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  const ox = ((-cam.x) % G + G) % G, oy = ((-cam.y) % G + G) % G;
  for (let x = ox; x < W; x += G) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = oy; y < H; y += G) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Map border
  ctx.strokeStyle = 'rgba(255, 80, 80, 0.5)';
  ctx.lineWidth = 5;
  ctx.strokeRect(-cam.x, -cam.y, mapW, mapH);

  // ── Fruits ──────────────────────────────────────────────────────────────
  const now = Date.now();
  for (const f of fruits) {
    const sx = f.x - cam.x, sy = f.y - cam.y;
    if (sx < -80 || sx > W + 80 || sy < -80 || sy > H + 80) continue;

    if (f.soul) {
      // Soul orb — pulsing multi-ring glow
      const pulse = 1 + 0.22 * Math.sin(now / 280 + f.x * 0.005);
      const r = f.radius * pulse;
      // Three glow rings
      for (let gi = 3; gi >= 1; gi--) {
        const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * gi * 1.4);
        gr.addColorStop(0, f.color + (gi === 1 ? '55' : gi === 2 ? '33' : '18'));
        gr.addColorStop(1, 'transparent');
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(sx, sy, r * gi * 1.4, 0, Math.PI * 2); ctx.fill();
      }
      // Core
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = f.color; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
      // Rotating sparkle lines
      const angle = now / 600;
      ctx.strokeStyle = f.color + 'cc'; ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        const a = angle + i * Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(a) * (r + 3), sy + Math.sin(a) * (r + 3));
        ctx.lineTo(sx + Math.cos(a) * (r + 10), sy + Math.sin(a) * (r + 10));
        ctx.stroke();
      }
      // Label
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r * 0.75)}px Arial`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('✨', sx, sy);
    } else {
      // Regular fruit
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
    const frac = b.t / 120;                      // 1→0 as it expires (4s fuse)
    const pulse = 1 + 0.3 * Math.sin(now / 120); // fast pulse
    const bR = 14 * (frac < 0.2 ? pulse : 1);    // pulse when almost expired

    // Outer glow (red, intensifies near expiry)
    const intensity = Math.max(0.3, 1 - frac);
    const gl = ctx.createRadialGradient(sx, sy, 0, sx, sy, bR * 3);
    gl.addColorStop(0, `rgba(255,50,30,${0.5 * intensity})`);
    gl.addColorStop(1, 'transparent');
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(sx, sy, bR * 3, 0, Math.PI * 2); ctx.fill();

    // Body
    ctx.beginPath(); ctx.arc(sx, sy, bR, 0, Math.PI * 2);
    ctx.fillStyle = '#111'; ctx.fill();
    ctx.strokeStyle = `rgba(255,80,30,${0.6 + 0.4 * intensity})`; ctx.lineWidth = 2.5; ctx.stroke();

    // Skull emoji
    ctx.font = `${Math.round(bR * 1.1)}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('💣', sx, sy);

    // Timer ring
    ctx.beginPath();
    ctx.arc(sx, sy, bR + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.strokeStyle = frac < 0.25 ? '#ff2200' : '#ffaa00';
    ctx.lineWidth = 2; ctx.stroke();
  }

  // Bomb blast effects — expanding ring at world position
  for (let i = bombBlasts.length - 1; i >= 0; i--) {
    const bl = bombBlasts[i];
    bl.timer--;
    if (bl.timer <= 0) { bombBlasts.splice(i, 1); continue; }
    const sx = bl.wx - cam.x, sy = bl.wy - cam.y;
    const prog  = 1 - bl.timer / bl.maxTimer;   // 0→1
    const alpha = (bl.timer / bl.maxTimer);

    // Expanding shockwave ring
    const r = bl.radius * prog;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,160,30,${alpha * 0.9})`;
    ctx.lineWidth = 12 * (1 - prog) + 2;
    ctx.stroke();

    // Secondary smaller ring
    if (prog > 0.2) {
      const r2 = bl.radius * 0.55 * prog;
      ctx.beginPath(); ctx.arc(sx, sy, r2, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,220,80,${alpha * 0.6})`;
      ctx.lineWidth = 6 * (1 - prog) + 1;
      ctx.stroke();
    }

    // Inner fireball (first half of animation)
    if (prog < 0.5) {
      const fb = bl.radius * 0.35 * (0.5 - prog) / 0.5;
      const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, fb);
      grd.addColorStop(0, `rgba(255,240,120,${alpha})`);
      grd.addColorStop(0.5, `rgba(255,100,20,${alpha * 0.7})`);
      grd.addColorStop(1, 'transparent');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(sx, sy, fb, 0, Math.PI * 2); ctx.fill();
    }

    // Screen tint (only first few frames)
    if (bl.timer > bl.maxTimer * 0.75) {
      ctx.fillStyle = `rgba(255,120,0,${alpha * 0.18})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ── Snakes ──────────────────────────────────────────────────────────────
  const sorted = [...snakes].sort((a, b) => (+a.alive) - (+b.alive));
  for (const s of sorted) drawSnake(s);

  // ── Slingshot rubber band ────────────────────────────────────────────────
  if (spaceHeld && alive && predReady) {
    const charge = Math.min(1, (Date.now() - spaceStartTime) / 2000);
    const snakeSX = predX - cam.x;
    const snakeSY = predY - cam.y;
    const throwDir = Math.atan2(mouseClientY - snakeSY, mouseClientX - snakeSX);

    // Bomb is pulled back opposite to throw direction
    const pullDist = 30 + charge * 80;
    const pullX = snakeSX - Math.cos(throwDir) * pullDist;
    const pullY = snakeSY - Math.sin(throwDir) * pullDist;

    // Anchor points: perpendicular sides of snake head
    const me2 = snakes.find(s => s.id === myId);
    const bodyR2 = me2 ? Math.max(6, Math.min(22, 6 + me2.len / 40)) : 10;
    const perpX = -Math.sin(throwDir) * (bodyR2 + 6);
    const perpY =  Math.cos(throwDir) * (bodyR2 + 6);

    // Band color: green → yellow → red
    const cr = Math.round(charge * 255);
    const cg = Math.round((1 - charge) * 200);
    const bandColor = `rgb(${cr},${cg},30)`;

    ctx.save();

    // Trajectory preview (dotted line from snake head forward)
    const previewLen = 120 + charge * 450;
    ctx.setLineDash([7, 7]);
    ctx.strokeStyle = `rgba(${cr},${cg},30,0.55)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(snakeSX, snakeSY);
    ctx.lineTo(snakeSX + Math.cos(throwDir) * previewLen,
               snakeSY + Math.sin(throwDir) * previewLen);
    ctx.stroke();
    ctx.setLineDash([]);

    // Elastic bands (two lines anchor → bomb)
    ctx.strokeStyle = bandColor;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(snakeSX + perpX, snakeSY + perpY);
    ctx.lineTo(pullX, pullY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(snakeSX - perpX, snakeSY - perpY);
    ctx.lineTo(pullX, pullY);
    ctx.stroke();

    // Bomb icon at pullback pos
    ctx.font = `${Math.round(16 + charge * 8)}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('💣', pullX, pullY);

    // Charge ring around snake head
    ctx.beginPath();
    ctx.arc(snakeSX, snakeSY, bodyR2 + 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * charge);
    ctx.strokeStyle = bandColor;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.restore();
  }

  // ── Minimap ─────────────────────────────────────────────────────────────
  drawMinimap(W, H);

  // ── HUD ─────────────────────────────────────────────────────────────────
  drawHUD(W, H);

  // Decay hit flashes
  for (const id of Object.keys(hitFlashes)) {
    hitFlashes[id]--;
    if (hitFlashes[id] <= 0) delete hitFlashes[id];
  }
}

function drawSnake(s) {
  const body = s.body;
  if (!body || body.length < 2) return;
  const W = canvas.width, H = canvas.height;

  const isMe = s.id === myId;
  const flash = hitFlashes[s.id] > 0;
  const bodyR = Math.max(6, Math.min(22, 6 + s.len / 40));
  const hx = s.x - cam.x, hy = s.y - cam.y;

  // Cull only if the entire body bounding box is off-screen
  // (head-only cull is wrong — body can extend onto screen while head is off)
  let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
  for (const p of body) {
    const px = p.x - cam.x, py = p.y - cam.y;
    if (px < bMinX) bMinX = px; if (px > bMaxX) bMaxX = px;
    if (py < bMinY) bMinY = py; if (py > bMaxY) bMaxY = py;
  }
  const mg = bodyR + 10;
  if (bMaxX < -mg || bMinX > W + mg || bMaxY < -mg || bMinY > H + mg) return;

  ctx.save();
  ctx.globalAlpha = s.alive ? 1 : 0.2;

  // Hit flash: white overlay
  const bodyColor = flash ? '#ffffff' : s.bodyColor;

  // Body path
  ctx.beginPath();
  ctx.moveTo(body[0].x - cam.x, body[0].y - cam.y);
  for (let i = 1; i < body.length; i++) ctx.lineTo(body[i].x - cam.x, body[i].y - cam.y);
  ctx.strokeStyle = bodyColor;
  ctx.lineWidth   = bodyR * 2;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Boost speed lines
  if (s.boosting) {
    const behind = s.dir + Math.PI;
    for (let i = 0; i < 5; i++) {
      const spread = (i - 2) * 0.28;
      const lineDir = behind + spread;
      const len = (25 + Math.random() * 30) * (isMe ? 1 : 0.7);
      const lx = hx + Math.cos(lineDir) * (bodyR + 4);
      const ly = hy + Math.sin(lineDir) * (bodyR + 4);
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + Math.cos(lineDir) * len, ly + Math.sin(lineDir) * len);
      ctx.strokeStyle = `rgba(255,220,80,${0.6 - Math.abs(i - 2) * 0.15})`;
      ctx.lineWidth = 2 - Math.abs(i - 2) * 0.4;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  // Head glow
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
    ctx.beginPath(); ctx.arc(ex, ey, eR, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(ex + Math.cos(s.dir) * eR * 0.5, ey + Math.sin(s.dir) * eR * 0.5, eR * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = '#111'; ctx.fill();
  }

  // Name tag
  if (hx > -150 && hx < W + 150 && hy > -80 && hy < H + 80) {
    const fontSize = Math.max(11, Math.min(15, 11 + s.len / 60));
    ctx.font = `bold ${fontSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const label = `${s.emoji} ${s.name}`;
    const tagY = hy - hR - 4;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(label, hx + 1, tagY + 1);
    ctx.fillStyle = isMe ? '#ffd700' : '#fff';
    ctx.fillText(label, hx, tagY);
  }

  ctx.restore();
}

function drawMinimap(W, H) {
  const MX = 12, MY = H - MM_H - 12;

  ctx.fillStyle = 'rgba(4,4,18,0.85)';
  roundRect(MX, MY, MM_W, MM_H, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(80,80,160,0.45)'; ctx.lineWidth = 1;
  roundRect(MX, MY, MM_W, MM_H, 8); ctx.stroke();

  ctx.save();
  roundRect(MX, MY, MM_W, MM_H, 8); ctx.clip();

  const sx = MM_W / mapW, sy = MM_H / mapH;

  // Fruits
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  for (const f of fruits) {
    ctx.beginPath(); ctx.arc(MX + f.x * sx, MY + f.y * sy, 1.5, 0, Math.PI * 2); ctx.fill();
  }

  // Bombs on minimap
  for (const b of bombs) {
    ctx.beginPath(); ctx.arc(MX + b.x * sx, MY + b.y * sy, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4422'; ctx.fill();
  }

  // Viewport rect
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
  ctx.strokeRect(MX + cam.x * sx, MY + cam.y * sy, canvas.width * sx, canvas.height * sy);

  // Snakes
  for (const s of snakes) {
    if (!s.alive) continue;
    const isMe = s.id === myId;
    const mx = MX + s.x * sx, my = MY + s.y * sy;
    ctx.beginPath(); ctx.arc(mx, my, isMe ? 5 : 3, 0, Math.PI * 2);
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

  // Top bar
  const canBomb = me && me.alive && me.len >= 110;
  const topTxt  = me
    ? `${me.emoji} ${me.name}  |  Skor: ${me.score}  |  Boy: ${me.len}`
    : 'Bağlanılıyor…';

  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.font = 'bold 15px Arial'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(topTxt, 14, 14);

  // Bomb hint
  const bombTxt = canBomb
    ? '💣 [Space] Bomba at (−100 boy)'
    : me && me.len < 110
      ? `💣 Bomba için ${110 - me.len} daha gerek`
      : '';
  if (bombTxt) {
    ctx.font = '12px Arial';
    ctx.fillStyle = canBomb ? '#ffcc44' : 'rgba(255,255,255,0.35)';
    ctx.fillText(bombTxt, 14, 34);
  }

  // Boost & chat hints
  const boostTxt = me && me.boosting
    ? '🚀 BOOST aktif — boy eriyor!'
    : '🖱️ [Sol Tık] Boost (boy harcar)';
  ctx.font = '11px Arial';
  ctx.fillStyle = me && me.boosting ? '#ffdd44' : 'rgba(255,255,255,0.3)';
  ctx.fillText(boostTxt, 14, 54);

  ctx.fillStyle = 'rgba(180,180,255,0.35)';
  ctx.fillText('💬 [Enter] Sohbet', 14, 70);

  // Leaderboard
  const aliveSnakes = [...snakes].filter(s => s.alive).sort((a, b) => b.len - a.len).slice(0, 6);
  const lbW = 200, lbH = 22 + aliveSnakes.length * 22 + 6;
  const lbX = W - lbW - 14, lbY = 14;

  ctx.fillStyle = 'rgba(4,4,20,0.72)';
  roundRect(lbX, lbY, lbW, lbH, 8); ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = 'bold 10px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('🏆 LİDERLER', lbX + lbW / 2, lbY + 5);

  for (let i = 0; i < aliveSnakes.length; i++) {
    const s = aliveSnakes[i];
    const isMe = s.id === myId;
    const y = lbY + 22 + i * 22;
    ctx.font = isMe ? 'bold 12px Arial' : '11px Arial';
    ctx.fillStyle = isMe ? '#ffd700' : 'rgba(255,255,255,0.8)';
    ctx.textAlign = 'left';
    ctx.fillText(`${i + 1}. ${s.emoji} ${s.name}${s.isNPC ? ' 🤖' : ''}`, lbX + 10, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = isMe ? '#ffd700' : 'rgba(255,255,255,0.5)';
    ctx.fillText(`${s.len}`, lbX + lbW - 8, y);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
render();
