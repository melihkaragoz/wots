'use strict';

// ── Constants (must match server) ──────────────────────────────────────────
const COLS = 100;
const ROWS = 60;
const CELL = 10;
const CW = COLS * CELL;  // 1000
const CH = ROWS * CELL;  // 600
const P_RADIUS = 12;
const TOTAL_CELLS = COLS * ROWS;

// ── DOM refs ──────────────────────────────────────────────────────────────
const canvas    = document.getElementById('cvs');
const ctx       = canvas.getContext('2d');
const overlay   = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');
const roleInfo  = document.getElementById('role-info');
const pct1El    = document.getElementById('pct1');
const pct2El    = document.getElementById('pct2');
const bar1El    = document.getElementById('bar1');
const bar2El    = document.getElementById('bar2');
const connEl    = document.getElementById('conn');
const cellCounts = document.getElementById('cell-counts');
const resetBtn  = document.getElementById('reset-btn');

canvas.width  = CW;
canvas.height = CH;

// ── Off-screen territory canvas ───────────────────────────────────────────
const terCanvas = document.createElement('canvas');
terCanvas.width  = COLS;
terCanvas.height = ROWS;
const terCtx     = terCanvas.getContext('2d');
const terImg     = terCtx.createImageData(COLS, ROWS);
const terData    = terImg.data;

// Colour palette  [r, g, b, a]
const PAL = [
  [18, 18, 36, 255],    // 0 neutral
  [255, 71, 87, 230],   // 1 player 1 (red)
  [30, 144, 255, 230],  // 2 player 2 (blue)
];

// ── Client state ───────────────────────────────────────────────────────────
let territory  = new Uint8Array(TOTAL_CELLS);
let players    = {};   // { 1: {x,y,color}, 2: {x,y,color} }
let scores     = { 1: 0, 2: 0 };
let myNum      = null;
let isSpectator = false;
let connected  = false;

// Particle system for captures
const particles = [];

// ── Socket ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => {
  connected = true;
  connEl.textContent = 'Bağlandı';
  connEl.className = 'badge badge-online';
});

socket.on('disconnect', () => {
  connected = false;
  connEl.textContent = 'Bağlantı kesildi';
  connEl.className = 'badge badge-connecting';
  showOverlay('Sunucuya bağlantı kesildi…');
});

socket.on('init', (data) => {
  if (data.role === 'spectator') {
    isSpectator = true;
    connEl.textContent = 'İzleyici';
    connEl.className = 'badge badge-spectator';
    roleInfo.textContent = '👁 İzleyici modunda';
    showOverlay('Oyun dolu — izleyici olarak bağlandınız');
  } else {
    myNum = data.num;
    isSpectator = false;
    const colourName = myNum === 1 ? '🔴 Kırmızı' : '🔵 Mavi';
    roleInfo.textContent = `Sen: ${colourName} (Oyuncu ${myNum})`;

    const otherNum = myNum === 1 ? 2 : 1;
    if (!data.players[otherNum]) {
      showOverlay('Oyuncu 2 bekleniyor…');
    } else {
      hideOverlay();
    }
  }

  applyTerritory(data.territory);
  players = data.players || {};
  scores  = data.scores;
  updateHUD();
});

socket.on('pjoin', ({ num }) => {
  hideOverlay();
  spawnNotification(`Oyuncu ${num} katıldı!`);
});

socket.on('pleave', ({ num }) => {
  delete players[num];
  showOverlay(`Oyuncu ${num} ayrıldı — bekleniyor…`);
  spawnNotification(`Oyuncu ${num} ayrıldı`);
});

socket.on('tick', (data) => {
  if (data.p) players = data.p;
  if (data.t) applyTerritory(data.t);
  if (data.s) {
    scores = data.s;
    updateHUD();
  }
});

socket.on('reset', (data) => {
  applyTerritory(data.territory);
  scores = data.scores;
  updateHUD();
  spawnNotification('Oyun sıfırlandı!');
});

// ── Territory rendering ────────────────────────────────────────────────────
function applyTerritory(buf) {
  const prev = territory;
  territory = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer || buf);

  // Update ImageData and collect changed cells for particles
  const d = terData;
  for (let i = 0; i < territory.length; i++) {
    const v = territory[i];
    const b = i << 2;
    const c = PAL[v];
    d[b]     = c[0];
    d[b + 1] = c[1];
    d[b + 2] = c[2];
    d[b + 3] = c[3];

    // Emit capture particles on ownership change
    if (prev[i] !== 0 && prev[i] !== v && v !== 0) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      spawnParticles(col * CELL + CELL / 2, row * CELL + CELL / 2, PAL[v]);
    }
  }
  terCtx.putImageData(terImg, 0, 0);
}

// ── Particles ──────────────────────────────────────────────────────────────
function spawnParticles(x, y, col) {
  if (Math.random() > 0.15) return; // only some captures spawn particles
  for (let i = 0; i < 4; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1 + Math.random() * 3;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      alpha: 1,
      r: col[0], g: col[1], b: col[2],
    });
  }
}

function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.alpha -= 0.04;
    if (p.alpha <= 0) particles.splice(i, 1);
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.alpha})`;
    ctx.fill();
  }
}

// ── HUD update ─────────────────────────────────────────────────────────────
function updateHUD() {
  const total = TOTAL_CELLS;
  const p1 = Math.round(scores[1] / total * 100);
  const p2 = Math.round(scores[2] / total * 100);

  pct1El.textContent = p1 + '%';
  pct2El.textContent = p2 + '%';
  bar1El.style.width = p1 + '%';
  bar2El.style.width = p2 + '%';
  cellCounts.textContent = `P1: ${scores[1]} | P2: ${scores[2]} | Nötr: ${total - scores[1] - scores[2]}`;
}

// ── Overlay helpers ────────────────────────────────────────────────────────
function showOverlay(msg) {
  overlayMsg.textContent = msg;
  overlay.classList.remove('hidden');
}
function hideOverlay() {
  overlay.classList.add('hidden');
}

// ── Notification toasts ────────────────────────────────────────────────────
function spawnNotification(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(20,20,40,0.95)', color: '#fff', padding: '8px 20px',
    borderRadius: '20px', border: '1px solid #3a3a6a', fontSize: '0.85rem',
    zIndex: 99, transition: 'opacity 0.5s', opacity: '1', pointerEvents: 'none',
  });
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 2000);
  setTimeout(() => el.remove(), 2600);
}

// ── Main render loop ───────────────────────────────────────────────────────
function render() {
  requestAnimationFrame(render);

  // Background
  ctx.fillStyle = '#0d0d1a';
  ctx.fillRect(0, 0, CW, CH);

  // Territory layer (pixel-perfect scaled up from 100×60 canvas)
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(terCanvas, 0, 0, CW, CH);

  // Subtle grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 0.5;
  for (let c = 0; c <= COLS; c += 5) {
    ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, CH); ctx.stroke();
  }
  for (let r = 0; r <= ROWS; r += 5) {
    ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(CW, r * CELL); ctx.stroke();
  }

  // Particles
  updateParticles();
  drawParticles();

  // Players
  for (const [num, p] of Object.entries(players)) {
    const n = parseInt(num);
    drawPlayer(p.x, p.y, p.color, n === myNum, `P${n}`);
  }
}

function drawPlayer(x, y, color, isMe, label) {
  // Outer glow
  const glow = ctx.createRadialGradient(x, y, 0, x, y, 32);
  glow.addColorStop(0, color + 'aa');
  glow.addColorStop(1, color + '00');
  ctx.beginPath();
  ctx.arc(x, y, 32, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();

  // Shadow ring for "me"
  if (isMe) {
    ctx.beginPath();
    ctx.arc(x, y, P_RADIUS + 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff55';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Body
  ctx.beginPath();
  ctx.arc(x, y, P_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // Border
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Label
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 9px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y);
}

// ── Mouse / touch input ────────────────────────────────────────────────────
function getCanvasPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = CW / rect.width;
  const scaleY = CH / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top)  * scaleY,
  };
}

canvas.addEventListener('mousemove', (e) => {
  if (isSpectator) return;
  const { x, y } = getCanvasPos(e.clientX, e.clientY);
  socket.emit('m', { x, y });
});

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (isSpectator) return;
  const t = e.touches[0];
  const { x, y } = getCanvasPos(t.clientX, t.clientY);
  socket.emit('m', { x, y });
}, { passive: false });

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (isSpectator) return;
  const t = e.touches[0];
  const { x, y } = getCanvasPos(t.clientX, t.clientY);
  socket.emit('m', { x, y });
}, { passive: false });

// ── Reset button ──────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => socket.emit('reset'));

// ── Boot ──────────────────────────────────────────────────────────────────
showOverlay('Sunucuya bağlanılıyor…');
render();
