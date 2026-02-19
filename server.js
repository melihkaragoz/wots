'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000 });

app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ──────────────────────────────────────────────────────────────
const COLS = 100;
const ROWS = 60;
const CELL = 10;          // pixels per cell
const W = COLS * CELL;    // 1000px
const H = ROWS * CELL;    // 600px
const SPEED = 3;          // px per tick
const P_RADIUS = 12;      // player circle radius
const PAINT_R = 2.3;      // paint radius in cells

// ── Persistence ────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Game state ─────────────────────────────────────────────────────────────
const gs = {
  territory: new Uint8Array(COLS * ROWS),  // 0=neutral 1=P1 2=P2
  scores: { 1: 0, 2: 0 },
  players: {},                             // socketId → player obj
};

// ── Load persisted state ───────────────────────────────────────────────────
try {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    gs.territory = new Uint8Array(saved.territory);
    gs.scores = saved.scores;
    console.log('Loaded saved state.');
  }
} catch (e) {
  console.warn('Could not load saved state:', e.message);
}

function persistState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      territory: Array.from(gs.territory),
      scores: gs.scores
    }));
  } catch (e) {
    console.warn('Save failed:', e.message);
  }
}
setInterval(persistState, 10_000);

// ── Helpers ────────────────────────────────────────────────────────────────
const COLORS = { 1: '#ff4757', 2: '#1e90ff' };

function startPos(num) {
  return num === 1
    ? { x: W * 0.25, y: H / 2 }
    : { x: W * 0.75, y: H / 2 };
}

function calcScores() {
  let s1 = 0, s2 = 0;
  for (const v of gs.territory) {
    if (v === 1) s1++;
    else if (v === 2) s2++;
  }
  gs.scores = { 1: s1, 2: s2 };
}

function paint(x, y, pNum) {
  const cx = x / CELL;
  const cy = y / CELL;
  const r = Math.ceil(PAINT_R) + 1;
  let changed = false;
  for (let row = Math.max(0, Math.floor(cy - r)); row <= Math.min(ROWS - 1, Math.ceil(cy + r)); row++) {
    for (let col = Math.max(0, Math.floor(cx - r)); col <= Math.min(COLS - 1, Math.ceil(cx + r)); col++) {
      const d = Math.sqrt((col + 0.5 - cx) ** 2 + (row + 0.5 - cy) ** 2);
      if (d <= PAINT_R) {
        const idx = row * COLS + col;
        if (gs.territory[idx] !== pNum) {
          gs.territory[idx] = pNum;
          changed = true;
        }
      }
    }
  }
  return changed;
}

function activePlayers() {
  return Object.values(gs.players);
}

function buildPData() {
  const d = {};
  for (const p of activePlayers()) {
    d[p.num] = { x: p.x, y: p.y, color: p.color };
  }
  return d;
}

// ── Game loop ──────────────────────────────────────────────────────────────
let dirty = false;

setInterval(() => {
  let moved = false;
  for (const p of activePlayers()) {
    const dx = p.tx - p.x;
    const dy = p.ty - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0.5) {
      const spd = Math.min(SPEED, dist);
      p.x += (dx / dist) * spd;
      p.y += (dy / dist) * spd;
      p.x = Math.max(P_RADIUS, Math.min(W - P_RADIUS, p.x));
      p.y = Math.max(P_RADIUS, Math.min(H - P_RADIUS, p.y));
      if (paint(p.x, p.y, p.num)) dirty = true;
      moved = true;
    }
  }

  if (dirty) calcScores();

  io.emit('tick', {
    p: buildPData(),
    s: gs.scores,
    t: dirty ? Buffer.from(gs.territory) : null,
  });

  dirty = false;
}, 1000 / 30);

// ── Socket handling ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const taken = activePlayers().map(p => p.num);

  if (taken.length >= 2) {
    socket.emit('init', {
      role: 'spectator',
      territory: Buffer.from(gs.territory),
      scores: gs.scores,
      players: buildPData(),
      totalCells: COLS * ROWS,
    });

    socket.on('reset', handleReset);
    return;
  }

  const num = [1, 2].find(n => !taken.includes(n));
  const { x, y } = startPos(num);

  gs.players[socket.id] = { socketId: socket.id, num, color: COLORS[num], x, y, tx: x, ty: y };

  paint(x, y, num);
  calcScores();
  dirty = true;

  socket.emit('init', {
    role: 'player',
    num,
    color: COLORS[num],
    territory: Buffer.from(gs.territory),
    scores: gs.scores,
    players: buildPData(),
    totalCells: COLS * ROWS,
  });

  socket.broadcast.emit('pjoin', { num, color: COLORS[num] });

  socket.on('m', ({ x, y }) => {
    const p = gs.players[socket.id];
    if (p) {
      p.tx = Math.max(0, Math.min(W, x));
      p.ty = Math.max(0, Math.min(H, y));
    }
  });

  socket.on('reset', handleReset);

  socket.on('disconnect', () => {
    if (!gs.players[socket.id]) return;
    const { num } = gs.players[socket.id];
    delete gs.players[socket.id];
    socket.broadcast.emit('pleave', { num });
    persistState();
    console.log(`P${num} disconnected.`);
  });
});

function handleReset() {
  gs.territory.fill(0);
  for (const p of activePlayers()) paint(p.x, p.y, p.num);
  calcScores();
  dirty = true;
  io.emit('reset', { territory: Buffer.from(gs.territory), scores: gs.scores });
  persistState();
}

// ══════════════════════════════════════════════════════════════════════════
// SNAKE WARS
// ══════════════════════════════════════════════════════════════════════════

app.get('/snake', (req, res) => res.sendFile(path.join(__dirname, 'snake', 'index.html')));
app.use('/snake', express.static(path.join(__dirname, 'snake')));

const SW_W = 5000, SW_H = 5000;
const SW_SPEED = 6;
const SW_NPC = 8;
const SW_FRUITS = 200;
const SW_MAX_TRAIL = 100000; // effectively unlimited
const SW_SAMPLE = 3;

const SW_ANIMALS = [
  { id: 'snake',  emoji: '🐍', name: 'Yılan',  body: '#2ed573', head: '#1e9e5e' },
  { id: 'fox',    emoji: '🦊', name: 'Tilki',  body: '#ff9f43', head: '#e67e22' },
  { id: 'dragon', emoji: '🐉', name: 'Ejder',  body: '#a29bfe', head: '#6c5ce7' },
  { id: 'lion',   emoji: '🦁', name: 'Aslan',  body: '#ffeaa7', head: '#c8a400' },
  { id: 'wolf',   emoji: '🐺', name: 'Kurt',   body: '#b2bec3', head: '#636e72' },
  { id: 'bear',   emoji: '🐻', name: 'Ayı',    body: '#c8a07a', head: '#8b5e3c' },
];

const SW_FRUIT_TYPES = [
  { value: 8,  radius: 10, color: '#ff4757' },
  { value: 5,  radius: 8,  color: '#ffd700' },
  { value: 12, radius: 9,  color: '#e84393' },
  { value: 6,  radius: 7,  color: '#9b59b6' },
  { value: 25, radius: 14, color: '#2ed573' },
];

const NPC_NAMES = ['Ninja', 'Shadow', 'Thunder', 'Blaze', 'Storm', 'Frost', 'Venom', 'Ghost'];

let swIdx = 0;
const sw = { snakes: {}, fruits: {}, players: {}, bombs: {} };
const swChat = [];

function swFruit() {
  const id = 'f' + swIdx++;
  const t = SW_FRUIT_TYPES[Math.floor(Math.random() * SW_FRUIT_TYPES.length)];
  sw.fruits[id] = { id, x: 60 + Math.random() * (SW_W - 120), y: 60 + Math.random() * (SW_H - 120), ...t };
}
for (let i = 0; i < SW_FRUITS; i++) swFruit();

function swGetAnimal(id) { return SW_ANIMALS.find(a => a.id === id) || SW_ANIMALS[0]; }

function swMake(id, name, animalId, x, y, len, isNPC) {
  const a = swGetAnimal(animalId);
  const trail = [];
  for (let i = 0; i < len; i++) trail.push({ x, y });
  return {
    id, name, isNPC, animalId: a.id, emoji: a.emoji,
    bodyColor: a.body, headColor: a.head,
    x, y, dir: Math.random() * Math.PI * 2,
    trail, tLen: len, growing: 0,
    alive: true, score: 0, deathTimer: 0, npcTimer: 0,
    boosting: false, spawnTimer: 90,
  };
}

// Spawn NPCs
for (let i = 0; i < SW_NPC; i++) {
  const id = 'npc' + i;
  const a = SW_ANIMALS[i % SW_ANIMALS.length].id;
  const len = 20 + Math.floor(Math.random() * 120);
  sw.snakes[id] = swMake(id, NPC_NAMES[i], a,
    300 + Math.random() * (SW_W - 600),
    300 + Math.random() * (SW_H - 600),
    len, true);
}

function swMove(s) {
  const spd = s.boosting ? SW_SPEED * 3 : SW_SPEED;
  let nx = s.x + Math.cos(s.dir) * spd;
  let ny = s.y + Math.sin(s.dir) * spd;
  const M = 20;
  if (nx < M)        { nx = M;        s.dir = Math.PI - s.dir; }
  else if (nx > SW_W - M) { nx = SW_W - M; s.dir = Math.PI - s.dir; }
  if (ny < M)        { ny = M;        s.dir = -s.dir; }
  else if (ny > SW_H - M) { ny = SW_H - M; s.dir = -s.dir; }
  s.x = nx; s.y = ny;
  s.trail.push({ x: nx, y: ny });
  if (s.growing > 0) { s.tLen++; s.growing--; }
  else if (s.trail.length > s.tLen) s.trail.shift();
  if (s.trail.length > SW_MAX_TRAIL) { s.trail.shift(); s.tLen = Math.min(s.tLen, SW_MAX_TRAIL); }
}

function swNpcAI(s) {
  const M = 200;
  if (s.x < M || s.x > SW_W - M || s.y < M || s.y > SW_H - M) {
    s.dir = Math.atan2(SW_H / 2 - s.y, SW_W / 2 - s.x) + (Math.random() - 0.5) * 0.3;
    s.npcTimer = 40; return;
  }
  if (--s.npcTimer > 0) return;

  const HUNT_RANGE = 700;
  const FLEE_RANGE = 450;

  // Flee from nearby larger snakes
  let fleeDx = 0, fleeDy = 0, fleeCount = 0;
  for (const other of Object.values(sw.snakes)) {
    if (other === s || !other.alive) continue;
    const d = Math.hypot(other.x - s.x, other.y - s.y);
    if (d < FLEE_RANGE && other.tLen > s.tLen * 1.2) {
      fleeDx -= (other.x - s.x) / d;
      fleeDy -= (other.y - s.y) / d;
      fleeCount++;
    }
  }
  if (fleeCount > 0) {
    s.dir = Math.atan2(fleeDy, fleeDx) + (Math.random() - 0.5) * 0.4;
    s.npcTimer = 20 + Math.floor(Math.random() * 20);
    return;
  }

  // Hunt nearby smaller snakes — aim slightly ahead of their path
  let huntTarget = null, huntDist = HUNT_RANGE;
  for (const other of Object.values(sw.snakes)) {
    if (other === s || !other.alive || other.spawnTimer > 0) continue;
    const d = Math.hypot(other.x - s.x, other.y - s.y);
    if (d < huntDist && other.tLen < s.tLen * 0.85) { huntDist = d; huntTarget = other; }
  }
  if (huntTarget) {
    const ahead = 12;
    const tx = huntTarget.x + Math.cos(huntTarget.dir) * SW_SPEED * ahead;
    const ty = huntTarget.y + Math.sin(huntTarget.dir) * SW_SPEED * ahead;
    s.dir = Math.atan2(ty - s.y, tx - s.x) + (Math.random() - 0.5) * 0.15;
    s.npcTimer = 10 + Math.floor(Math.random() * 15);
    return;
  }

  // Soul orbs are high-value — prioritise them
  let bestSoul = null, bestSoulD = 1400;
  for (const f of Object.values(sw.fruits)) {
    if (!f.soul) continue;
    const d = Math.hypot(f.x - s.x, f.y - s.y);
    if (d < bestSoulD) { bestSoulD = d; bestSoul = f; }
  }
  if (bestSoul) {
    s.dir = Math.atan2(bestSoul.y - s.y, bestSoul.x - s.x) + (Math.random() - 0.5) * 0.2;
    s.npcTimer = 15 + Math.floor(Math.random() * 20);
    return;
  }

  // Fall back: nearest fruit
  let best = null, bestD = 700;
  for (const f of Object.values(sw.fruits)) {
    const d = Math.hypot(f.x - s.x, f.y - s.y);
    if (d < bestD) { bestD = d; best = f; }
  }
  s.dir = best
    ? Math.atan2(best.y - s.y, best.x - s.x) + (Math.random() - 0.5) * 0.3
    : s.dir + (Math.random() - 0.5) * 1.1;
  s.npcTimer = 15 + Math.floor(Math.random() * 45);
}

const ATTRACT_RANGE = 120;  // px — fruits start moving toward snake
const ATTRACT_EAT   = 28;   // px — fruit gets consumed

function spawnSoulOrb(s) {
  const id = 'soul' + swIdx++;
  // Size of orb scales with snake length (capped)
  const r = Math.max(14, Math.min(30, 14 + s.tLen / 40));
  sw.fruits[id] = {
    id, x: s.x, y: s.y,
    color: s.headColor,
    value: 300,
    radius: r,
    soul: true,
    timer: 1200, // 40 seconds before disappearing
  };
}

function swAttractAndEat() {
  for (const s of Object.values(sw.snakes)) {
    if (!s.alive) continue;
    for (const [fid, f] of Object.entries(sw.fruits)) {
      const dx = s.x - f.x, dy = s.y - f.y;
      const dist = Math.hypot(dx, dy);
      if (dist < ATTRACT_EAT) {
        s.growing += f.value; s.score += f.value;
        delete sw.fruits[fid]; swFruit();
      } else if (dist < ATTRACT_RANGE) {
        // Accelerate as it gets closer
        const speed = 3 + 9 * (1 - dist / ATTRACT_RANGE);
        f.x += (dx / dist) * speed;
        f.y += (dy / dist) * speed;
      }
    }
  }
}

function swCollide() {
  const alive = Object.values(sw.snakes).filter(s => s.alive);
  for (const s1 of alive) {
    if (s1.spawnTimer > 0) continue; // spawn grace — immune
    for (const s2 of alive) {
      if (s1 === s2 || !s1.alive || !s2.alive) continue;

      // ── Head-to-head ──────────────────────────────────────────────────
      // Larger wins; equal size → both die.
      // Each direction is handled in its own iteration, so we only act
      // when s1 is the winner (s1 > s2) or equal (kill both immediately).
      if (Math.hypot(s1.x - s2.x, s1.y - s2.y) < 20) {
        if (s1.tLen > s2.tLen) {
          s2.alive = false; spawnSoulOrb(s2);
          s1.growing += Math.floor(s2.tLen * 0.4); s1.score += s2.score;
        } else if (s1.tLen === s2.tLen) {
          s1.alive = false; spawnSoulOrb(s1);
          s2.alive = false; spawnSoulOrb(s2);
        }
        // s1 < s2: the reversed iteration (s1=s2, s2=s1) will handle it.
        continue;
      }

      // ── A head → B body: A dies, no size check ────────────────────────
      const body = s2.trail;
      const tailSkip = Math.min(15, Math.floor(body.length * 0.1));
      for (let k = tailSkip; k < body.length - 12 && s1.alive; k++) {
        if (Math.hypot(s1.x - body[k].x, s1.y - body[k].y) < 14) {
          s1.alive = false; spawnSoulOrb(s1);
          break;
        }
      }
    }
  }
}

function swBuild() {
  return {
    snakes: Object.values(sw.snakes).map(s => {
      const body = [];
      for (let i = 0; i < s.trail.length; i += SW_SAMPLE) body.push(s.trail[i]);
      if (s.trail.length) {
        const last = s.trail[s.trail.length - 1];
        if (!body.length || body[body.length - 1] !== last) body.push(last);
      }
      return {
        id: s.id, name: s.name, emoji: s.emoji,
        bodyColor: s.bodyColor, headColor: s.headColor,
        x: Math.round(s.x), y: Math.round(s.y), dir: s.dir,
        body: body.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        len: s.tLen, alive: s.alive, score: s.score, isNPC: s.isNPC, boosting: s.boosting,
      };
    }),
    fruits: Object.values(sw.fruits).map(f => ({
      id: f.id, x: Math.round(f.x), y: Math.round(f.y), color: f.color, radius: f.radius, soul: !!f.soul,
    })),
    bombs: Object.values(sw.bombs).map(b => ({
      id: b.id, x: Math.round(b.x), y: Math.round(b.y), t: b.timer,
    })),
    mapW: SW_W, mapH: SW_H,
  };
}

const BOMB_RADIUS = 375;
const BOMB_DAMAGE = 300;

function swCheckBombs() {
  for (const [bid, bomb] of Object.entries(sw.bombs)) {
    if (--bomb.timer > 0) continue;
    // Fuse expired — AoE explosion
    const hits = [];
    for (const s of Object.values(sw.snakes)) {
      if (!s.alive || s.id === bomb.ownerId) continue;
      if (Math.hypot(s.x - bomb.x, s.y - bomb.y) < BOMB_RADIUS) {
        s.tLen -= BOMB_DAMAGE;
        if (s.tLen < 1) {
          s.alive = false; spawnSoulOrb(s);
        } else {
          if (s.trail.length > s.tLen) s.trail = s.trail.slice(s.trail.length - s.tLen);
        }
        hits.push(s.id);
      }
    }
    swIo.emit('bombExplode', { id: bid, x: bomb.x, y: bomb.y, hits, radius: BOMB_RADIUS });
    delete sw.bombs[bid];
  }
}

const swIo = io.of('/snake');
let swTick = 0;

setInterval(() => {
  swTick++;
  // Expire soul orbs
  for (const [fid, f] of Object.entries(sw.fruits)) {
    if (f.soul && --f.timer <= 0) delete sw.fruits[fid];
  }
  for (const s of Object.values(sw.snakes)) {
    if (!s.alive) {
      if (++s.deathTimer > 90 && s.isNPC) {
        const a = SW_ANIMALS[Math.floor(Math.random() * SW_ANIMALS.length)];
        Object.assign(s, swMake(s.id, s.name, a.id,
          300 + Math.random() * (SW_W - 600),
          300 + Math.random() * (SW_H - 600),
          20 + Math.floor(Math.random() * 80), true));
      }
      continue;
    }
    if (s.spawnTimer > 0) s.spawnTimer--;
    if (s.isNPC) swNpcAI(s);
    // Boost drain: 1 pt per 6 ticks = 5 pt/sec
    if (s.boosting && swTick % 6 === 0) {
      if (s.tLen <= 15) {
        s.boosting = false;
      } else {
        s.tLen -= 1;
        if (s.trail.length > s.tLen) s.trail.shift();
      }
    }
    swMove(s);
  }
  swAttractAndEat();
  swCollide();
  // Move flying bombs
  for (const bomb of Object.values(sw.bombs)) {
    bomb.x += bomb.vx; bomb.y += bomb.vy;
    if (bomb.x < 0) bomb.x = 0; else if (bomb.x > SW_W) bomb.x = SW_W;
    if (bomb.y < 0) bomb.y = 0; else if (bomb.y > SW_H) bomb.y = SW_H;
  }
  swCheckBombs();
  swIo.emit('tick', swBuild());
}, 1000 / 30);

swIo.on('connection', (socket) => {
  let mySwId = null;

  socket.on('join', ({ name, animal }) => {
    const id = 'p' + socket.id.slice(0, 8);
    sw.snakes[id] = swMake(id, (name || 'Oyuncu').slice(0, 16), animal,
      300 + Math.random() * (SW_W - 600), 300 + Math.random() * (SW_H - 600), 20, false);
    sw.players[socket.id] = id; mySwId = id;
    socket.emit('joined', { id, mapW: SW_W, mapH: SW_H });
  });

  socket.on('dir', ({ dir }) => {
    const id = sw.players[socket.id];
    if (id && sw.snakes[id]) sw.snakes[id].dir = dir;
  });

  socket.on('boost', ({ on }) => {
    const id = sw.players[socket.id];
    if (id && sw.snakes[id] && sw.snakes[id].alive) {
      sw.snakes[id].boosting = !!on;
    }
  });

  socket.on('respawn', () => {
    const id = sw.players[socket.id];
    if (!id || !sw.snakes[id]) return;
    const old = sw.snakes[id];
    Object.assign(sw.snakes[id], swMake(id, old.name, old.animalId,
      300 + Math.random() * (SW_W - 600), 300 + Math.random() * (SW_H - 600), 20, false));
    socket.emit('respawned');
  });

  socket.on('throwBomb', ({ dir, power }) => {
    const id = sw.players[socket.id];
    if (!id || !sw.snakes[id]) return;
    const s = sw.snakes[id];
    if (!s.alive || s.tLen < 110) return;
    s.tLen -= 100;
    if (s.trail.length > s.tLen) s.trail = s.trail.slice(s.trail.length - s.tLen);
    const BOMB_SPEED = 22; // px/tick
    const dist = Math.max(350, Math.min(1, power) * 2200);
    const timer = Math.round(dist / BOMB_SPEED);
    const bid = 'b' + swIdx++;
    sw.bombs[bid] = {
      id: bid,
      x: s.x + Math.cos(dir) * 35,
      y: s.y + Math.sin(dir) * 35,
      vx: Math.cos(dir) * BOMB_SPEED,
      vy: Math.sin(dir) * BOMB_SPEED,
      ownerId: id,
      timer,
    };
  });

  socket.on('chat', ({ msg }) => {
    if (!msg || typeof msg !== 'string') return;
    const pid = sw.players[socket.id];
    const snake = pid && sw.snakes[pid];
    const entry = {
      name:  snake ? snake.name  : 'Anonim',
      emoji: snake ? snake.emoji : '👤',
      msg:   msg.slice(0, 120),
    };
    swChat.push(entry);
    if (swChat.length > 50) swChat.shift();
    swIo.emit('chatMsg', entry);
  });

  socket.on('disconnect', () => {
    const id = sw.players[socket.id];
    if (id) { delete sw.snakes[id]; delete sw.players[socket.id]; }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Territory War → http://0.0.0.0:${PORT}`);
  console.log(`Snake Wars    → http://0.0.0.0:${PORT}/snake`);
});
