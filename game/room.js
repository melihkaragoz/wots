'use strict';
// ── GameRoom ──────────────────────────────────────────────────────────────
// Self-contained game room: owns its own state, game loop and NPC logic.
// Emits JS events for the server layer to react to (match_end, etc.)

const SW_W = 5000, SW_H = 5000;
const SW_FRUITS = 120;
const SW_MINES  = 35;
const SW_SAMPLE = 1;

const SW_ANIMALS = [
  { id: 'snake',  emoji: '🐍', name: 'Yılan',  body: '#2ed573', head: '#1e9e5e' },
  { id: 'fox',    emoji: '🦊', name: 'Tilki',  body: '#ff9f43', head: '#e67e22' },
  { id: 'dragon', emoji: '🐉', name: 'Ejder',  body: '#a29bfe', head: '#6c5ce7' },
  { id: 'lion',   emoji: '🦁', name: 'Aslan',  body: '#ffeaa7', head: '#c8a400' },
  { id: 'wolf',   emoji: '🐺', name: 'Kurt',   body: '#b2bec3', head: '#636e72' },
  { id: 'bear',   emoji: '🐻', name: 'Ayı',    body: '#c8a07a', head: '#8b5e3c' },
];
const SW_FRUIT_TYPES = [
  { value: 1, radius: 10, color: '#ff4757' },
  { value: 1, radius: 8,  color: '#ffd700' },
  { value: 2, radius: 9,  color: '#e84393' },
  { value: 1, radius: 7,  color: '#9b59b6' },
  { value: 3, radius: 14, color: '#2ed573' },
];
const NPC_NAMES = ['Ninja','Shadow','Thunder','Blaze','Storm','Frost','Venom','Ghost','Saber','Razor'];

class GameRoom {
  constructor(config, settings, io) {
    this.id       = config.id;
    this.name     = config.name;
    this.capacity = config.capacity || 8;
    this.npcFill  = config.npcFill !== false;
    this.password = config.password || null;
    this.duration = config.duration || 10;    // match duration in minutes
    this.settings = settings;
    this.io       = io;

    this.status      = 'waiting'; // waiting | countdown | playing | finished
    this.players     = {};   // socketId → { socketId, userId, name, animal, emoji, ready, isHost }
    this.countdownId = null;
    this.gameLoopId  = null;

    // Game state (null until match starts)
    this.gs = null;
    this.tick    = 0;
    this.timeLeft = 0;
    this.idx     = 0;

    // JS event emitter (lightweight)
    this._handlers = {};
    this.createdAt = Date.now();
  }

  // ── Pub/sub ──────────────────────────────────────────────────────────────
  on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); }
  _emit(ev, data) { (this._handlers[ev] || []).forEach(fn => fn(data)); }

  // ── Socket.io broadcast helpers ──────────────────────────────────────────
  broadcast(event, data) { this.io.to(`room:${this.id}`).emit(event, data); }
  broadcastRoomState()   { this.broadcast('room_state', this._buildRoomState()); }

  // ── Getters ───────────────────────────────────────────────────────────────
  get playerCount()    { return Object.keys(this.players).length; }
  get readyCount()     { return Object.values(this.players).filter(p => p.ready).length; }
  get aliveNpcCount()  { return this.gs ? Object.values(this.gs.snakes).filter(s => s.isNPC && s.alive).length : 0; }
  get realPlayerCount(){ return this.playerCount; }
  get isFull()         { return this.playerCount >= this.capacity; }

  // ── Player management ────────────────────────────────────────────────────
  addPlayer(socket, { name, animal, emoji, userId, mods }) {
    if (this.isFull) return false;
    const isHost = this.playerCount === 0;
    this.players[socket.id] = {
      socketId: socket.id, userId, name, animal, emoji,
      ready: false, isHost, mods: mods || {},
    };
    socket.join(`room:${this.id}`);

    // Mid-match join: spawn player immediately into the running game
    if (this.status === 'playing' && this.gs) {
      this._spawnPlayer(socket.id, this.players[socket.id]);
      socket.emit('match_start', {
        duration_sec: this.duration * 60,
        mapW: SW_W, mapH: SW_H,
      });
    }

    this.broadcastRoomState();
    return true;
  }

  removePlayer(socketId) {
    const p = this.players[socketId];
    if (!p) return;
    delete this.players[socketId];

    // Transfer host
    if (p.isHost && this.playerCount > 0) {
      const next = Object.values(this.players)[0];
      next.isHost = true;
      this.io.to(next.socketId).emit('you_are_host');
    }

    // Remove snake from live game
    if (this.gs) {
      const snakeId = this.gs.playerMap[socketId];
      if (snakeId && this.gs.snakes[snakeId]) {
        this._spawnSoulOrb(this.gs.snakes[snakeId]);
        delete this.gs.snakes[snakeId];
      }
      delete this.gs.playerMap[socketId];
      // Fill with NPC if needed
      if (this.npcFill) this._fillNpcs();
    }

    if (this.playerCount === 0) this._destroy();
    else this.broadcastRoomState();
  }

  setReady(socketId, ready) {
    if (!this.players[socketId]) return;
    this.players[socketId].ready = ready;
    this.broadcastRoomState();

    if (this.readyCount >= 1 && this.status === 'waiting') {
      this._startCountdown();
    } else if (this.readyCount < 1 && this.status === 'countdown') {
      this._cancelCountdown();
    }
  }

  // ── Countdown → Start ────────────────────────────────────────────────────
  _startCountdown() {
    if (this.countdownId) return;
    this.status = 'countdown';
    let n = 5;
    this.broadcast('countdown', { seconds: n });
    this.countdownId = setInterval(() => {
      n--;
      if (n > 0) {
        this.broadcast('countdown', { seconds: n });
      } else {
        clearInterval(this.countdownId);
        this.countdownId = null;
        this._startMatch();
      }
    }, 1000);
  }

  _cancelCountdown() {
    if (!this.countdownId) return;
    clearInterval(this.countdownId);
    this.countdownId = null;
    this.status = 'waiting';
    this.broadcast('countdown_cancelled', {});
  }

  // ── Match start ──────────────────────────────────────────────────────────
  _startMatch() {
    this.status   = 'playing';
    this.tick     = 0;
    this.timeLeft = this.duration * 60 * 30; // ticks (duration in minutes × 60s × 30fps)
    this.gs = { snakes: {}, fruits: {}, bombs: {}, mines: {}, playerMap: {} };

    for (let i = 0; i < SW_FRUITS; i++) this._spawnFruit();
    for (let i = 0; i < SW_MINES;  i++) this._spawnMine();
    if (this.npcFill) this._fillNpcs();
    for (const [sid, p] of Object.entries(this.players)) this._spawnPlayer(sid, p);

    this.broadcast('match_start', {
      duration_sec: this.duration * 60,
      mapW: SW_W, mapH: SW_H,
    });
    this.gameLoopId = setInterval(() => this._tickLoop(), 1000 / 30);
  }

  // ── Game tick ────────────────────────────────────────────────────────────
  _tickLoop() {
    this.tick++;
    this.timeLeft--;
    if (this.timeLeft <= 0) { this._endMatch(); return; }

    // Expire soul orbs
    for (const [fid, f] of Object.entries(this.gs.fruits)) {
      if (f.soul && --f.timer <= 0) delete this.gs.fruits[fid];
    }

    for (const s of Object.values(this.gs.snakes)) {
      if (!s.alive) {
        s.deathTimer++;
        const delay = this.settings.respawn_delay_ticks || 90;
        if (s.deathTimer >= delay) {
          if (s.isNPC) {
            // NPC respawn if needed
            const total = this.realPlayerCount + this.aliveNpcCount;
            if (this.npcFill && total < this.capacity) {
              this._resetNpc(s);
            }
          } else {
            // Player always respawns during match
            this._respawnPlayer(s);
          }
        }
        continue;
      }

      if (s.spawnTimer > 0) s.spawnTimer--;
      if (s.isNPC) this._npcAI(s);

      // Boost drain: 1pt per 6 ticks
      if (s.boosting && this.tick % 6 === 0) {
        if (s.tLen <= 15) s.boosting = false;
        else { s.tLen--; if (s.trail.length > s.tLen) s.trail.shift(); }
      }

      this._moveSnake(s);
    }

    this._attractAndEat();
    this._collide();
    this._moveBombs();
    this._checkBombs();
    this._checkMines();

    this.broadcast('tick', this._buildState());
  }

  // ── Match end ────────────────────────────────────────────────────────────
  _endMatch() {
    if (this.gameLoopId) { clearInterval(this.gameLoopId); this.gameLoopId = null; }
    this.status = 'finished';

    // Build leaderboard (real players only, sorted by score)
    const leaderboard = Object.entries(this.gs.playerMap)
      .map(([sid, snakeId]) => {
        const s = this.gs.snakes[snakeId];
        const p = this.players[sid];
        if (!s || !p) return null;
        return { socketId: sid, userId: p.userId, name: s.name, emoji: s.emoji,
                 score: s.score, kills: s.kills || 0, maxSize: s.maxSize || s.tLen };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    leaderboard.forEach((e, i) => { e.rank = i + 1; });

    this.broadcast('match_end', { leaderboard, duration_sec: this.duration * 60 });
    this._emit('match_end', { roomId: this.id, leaderboard });

    // Reset to lobby after 15s so players can play again
    this._resetTimer = setTimeout(() => this._resetToLobby(), 15000);
  }

  _resetToLobby() {
    if (this._resetTimer) { clearTimeout(this._resetTimer); this._resetTimer = null; }
    this.gs = null;
    this.tick = 0;
    this.timeLeft = 0;
    this.status = 'waiting';
    // Reset all players' ready state
    for (const p of Object.values(this.players)) p.ready = false;
    this.broadcast('room_reset', {});
    this.broadcastRoomState();
  }

  _destroy() {
    if (this.gameLoopId)  clearInterval(this.gameLoopId);
    if (this.countdownId) clearInterval(this.countdownId);
    if (this._resetTimer) clearTimeout(this._resetTimer);
    this.broadcast('room_closed', {});
    this._emit('destroyed', { roomId: this.id });
  }

  // ── Player spawn / respawn ────────────────────────────────────────────────
  _spawnPlayer(socketId, p) {
    const a = SW_ANIMALS.find(a => a.id === p.animal) || SW_ANIMALS[0];
    const mods = p.mods || {};
    const skin = mods.skinColors;
    const bodyColor = skin?.body || a.body;
    const headColor = skin?.head || a.head;
    const startLen = 20 + (mods.bonus_size || 0);
    const id = 'p_' + socketId;
    const x = 300 + Math.random() * (SW_W - 600);
    const y = 300 + Math.random() * (SW_H - 600);
    const trail = [];
    for (let i = 0; i < startLen; i++) trail.push({ x, y });
    this.gs.snakes[id] = {
      id, name: p.name, emoji: a.emoji, isNPC: false,
      bodyColor, headColor, animalId: a.id,
      x, y, dir: Math.random() * Math.PI * 2,
      trail, tLen: startLen, growing: 0,
      alive: true, score: 0, kills: 0, maxSize: startLen,
      deathTimer: 0, spawnTimer: 90, boosting: false,
      mods, activeAbilities: p.activeAbilities || {},
    };
    this.gs.playerMap[socketId] = id;
  }

  _respawnPlayer(s) {
    const x = 300 + Math.random() * (SW_W - 600);
    const y = 300 + Math.random() * (SW_H - 600);
    const startLen = 20 + (s.mods?.bonus_size || 0);
    const trail = [];
    for (let i = 0; i < startLen; i++) trail.push({ x, y });
    s.x = x; s.y = y;
    s.trail = trail; s.tLen = startLen;
    s.alive = true; s.deathTimer = 0; s.spawnTimer = 90;
    s.boosting = false;
    // score & kills preserved
  }

  // ── NPC management ────────────────────────────────────────────────────────
  _fillNpcs() {
    const total = this.realPlayerCount + this.aliveNpcCount;
    const toSpawn = Math.max(0, this.capacity - total);
    for (let i = 0; i < toSpawn; i++) this._spawnNpc();
  }

  _spawnNpc() {
    const id = 'npc_' + (this.idx++);
    const a  = SW_ANIMALS[Math.floor(Math.random() * SW_ANIMALS.length)];
    const nm = NPC_NAMES[Math.floor(Math.random() * NPC_NAMES.length)];
    const len = 20 + Math.floor(Math.random() * 60);
    const x = 300 + Math.random() * (SW_W - 600);
    const y = 300 + Math.random() * (SW_H - 600);
    const trail = [];
    for (let i = 0; i < len; i++) trail.push({ x, y });
    this.gs.snakes[id] = {
      id, name: nm, emoji: a.emoji, isNPC: true,
      bodyColor: a.body, headColor: a.head,
      x, y, dir: Math.random() * Math.PI * 2,
      trail, tLen: len, growing: 0,
      alive: true, score: 0, kills: 0, maxSize: len,
      deathTimer: 0, spawnTimer: 90, npcTimer: 0, boosting: false,
    };
  }

  _resetNpc(s) {
    const a = SW_ANIMALS[Math.floor(Math.random() * SW_ANIMALS.length)];
    const len = 20 + Math.floor(Math.random() * 60);
    const x = 300 + Math.random() * (SW_W - 600);
    const y = 300 + Math.random() * (SW_H - 600);
    const trail = [];
    for (let i = 0; i < len; i++) trail.push({ x, y });
    Object.assign(s, {
      bodyColor: a.body, headColor: a.head, emoji: a.emoji,
      x, y, dir: Math.random() * Math.PI * 2,
      trail, tLen: len, growing: 0,
      alive: true, score: 0, kills: 0, maxSize: len,
      deathTimer: 0, spawnTimer: 90, npcTimer: 0, boosting: false,
    });
  }

  // ── Movement ─────────────────────────────────────────────────────────────
  _moveSnake(s) {
    const spd = (this.settings.sw_speed || 6) * (s.boosting ? 3 : 1);
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
    if (s.trail.length > 100000) { s.trail.shift(); s.tLen = Math.min(s.tLen, 100000); }
    if (s.tLen > (s.maxSize || 0)) s.maxSize = s.tLen;
  }

  // ── NPC AI ────────────────────────────────────────────────────────────────
  _npcAI(s) {
    const M = 200;
    if (s.x < M || s.x > SW_W - M || s.y < M || s.y > SW_H - M) {
      s.dir = Math.atan2(SW_H / 2 - s.y, SW_W / 2 - s.x) + (Math.random() - 0.5) * 0.3;
      s.npcTimer = 40; return;
    }
    if (--s.npcTimer > 0) return;

    const HUNT_RANGE = 700, FLEE_RANGE = 450;
    let fleeDx = 0, fleeDy = 0, fleeCount = 0;
    for (const other of Object.values(this.gs.snakes)) {
      if (other === s || !other.alive) continue;
      const d = Math.hypot(other.x - s.x, other.y - s.y);
      if (d < FLEE_RANGE && other.tLen > s.tLen * 1.2) {
        fleeDx -= (other.x - s.x) / d; fleeDy -= (other.y - s.y) / d; fleeCount++;
      }
    }
    if (fleeCount > 0) {
      s.dir = Math.atan2(fleeDy, fleeDx) + (Math.random() - 0.5) * 0.4;
      s.npcTimer = 20 + Math.floor(Math.random() * 20); return;
    }

    let huntTarget = null, huntDist = HUNT_RANGE;
    for (const other of Object.values(this.gs.snakes)) {
      if (other === s || !other.alive || other.spawnTimer > 0) continue;
      const d = Math.hypot(other.x - s.x, other.y - s.y);
      if (d < huntDist && other.tLen < s.tLen * 0.85) { huntDist = d; huntTarget = other; }
    }
    if (huntTarget) {
      const ahead = 12;
      const tx = huntTarget.x + Math.cos(huntTarget.dir) * (this.settings.sw_speed || 6) * ahead;
      const ty = huntTarget.y + Math.sin(huntTarget.dir) * (this.settings.sw_speed || 6) * ahead;
      s.dir = Math.atan2(ty - s.y, tx - s.x) + (Math.random() - 0.5) * 0.15;
      s.npcTimer = 10 + Math.floor(Math.random() * 15); return;
    }

    let bestSoul = null, bestSoulD = 1400;
    for (const f of Object.values(this.gs.fruits)) {
      if (!f.soul) continue;
      const d = Math.hypot(f.x - s.x, f.y - s.y);
      if (d < bestSoulD) { bestSoulD = d; bestSoul = f; }
    }
    if (bestSoul) {
      s.dir = Math.atan2(bestSoul.y - s.y, bestSoul.x - s.x) + (Math.random() - 0.5) * 0.2;
      s.npcTimer = 15 + Math.floor(Math.random() * 20); return;
    }

    let best = null, bestD = 700;
    for (const f of Object.values(this.gs.fruits)) {
      const d = Math.hypot(f.x - s.x, f.y - s.y);
      if (d < bestD) { bestD = d; best = f; }
    }
    s.dir = best
      ? Math.atan2(best.y - s.y, best.x - s.x) + (Math.random() - 0.5) * 0.3
      : s.dir + (Math.random() - 0.5) * 1.1;
    s.npcTimer = 15 + Math.floor(Math.random() * 45);
  }

  // ── Fruit / Mine spawn ────────────────────────────────────────────────────
  _spawnFruit() {
    const id = 'f' + (this.idx++);
    const t  = SW_FRUIT_TYPES[Math.floor(Math.random() * SW_FRUIT_TYPES.length)];
    this.gs.fruits[id] = { id, x: 60 + Math.random() * (SW_W - 120), y: 60 + Math.random() * (SW_H - 120), ...t };
  }

  _spawnMine() {
    const id = 'm' + (this.idx++);
    this.gs.mines[id] = { id, x: 150 + Math.random() * (SW_W - 300), y: 150 + Math.random() * (SW_H - 300) };
  }

  _spawnSoulOrb(s) {
    const id = 'soul' + (this.idx++);
    const r  = Math.max(14, Math.min(30, 14 + s.tLen / 40));
    this.gs.fruits[id] = { id, x: s.x, y: s.y, color: s.headColor, value: 50, radius: r, soul: true, timer: 1200 };
  }

  // ── Attract & eat ─────────────────────────────────────────────────────────
  _attractAndEat() {
    const ATTRACT_RANGE = this.settings.attract_range || 120;
    const EAT_RANGE     = 28;
    for (const s of Object.values(this.gs.snakes)) {
      if (!s.alive) continue;
      for (const [fid, f] of Object.entries(this.gs.fruits)) {
        const dx = s.x - f.x, dy = s.y - f.y;
        const dist = Math.hypot(dx, dy);
        if (dist < EAT_RANGE) {
          s.growing += f.value; s.score += f.value;
          delete this.gs.fruits[fid];
          if (!f.soul) this._spawnFruit();
        } else if (dist < ATTRACT_RANGE) {
          const spd = 3 + 9 * (1 - dist / ATTRACT_RANGE);
          f.x += (dx / dist) * spd; f.y += (dy / dist) * spd;
        }
      }
    }
  }

  // ── Collision ─────────────────────────────────────────────────────────────
  _collide() {
    const alive = Object.values(this.gs.snakes).filter(s => s.alive);
    for (const s1 of alive) {
      if (s1.spawnTimer > 0) continue;
      for (const s2 of alive) {
        if (s1 === s2 || !s1.alive || !s2.alive) continue;

        // Head-to-head
        if (Math.hypot(s1.x - s2.x, s1.y - s2.y) < 20) {
          if (s1.tLen > s2.tLen) {
            s2.alive = false; this._spawnSoulOrb(s2);
            s1.growing += Math.floor(s2.tLen * 0.13); s1.score += s2.tLen;
            s1.kills = (s1.kills || 0) + 1;
          } else if (s1.tLen === s2.tLen) {
            s1.alive = false; this._spawnSoulOrb(s1);
            s2.alive = false; this._spawnSoulOrb(s2);
          }
          continue;
        }

        // Head → body
        const body = s2.trail;
        const tailSkip = Math.min(15, Math.floor(body.length * 0.1));
        for (let k = tailSkip; k < body.length - 12 && s1.alive; k++) {
          if (Math.hypot(s1.x - body[k].x, s1.y - body[k].y) < 14) {
            s1.alive = false; this._spawnSoulOrb(s1);
            s2.kills = (s2.kills || 0) + 1;
            break;
          }
        }
      }
    }
  }

  // ── Bombs ─────────────────────────────────────────────────────────────────
  _moveBombs() {
    for (const bomb of Object.values(this.gs.bombs)) {
      bomb.x += bomb.vx; bomb.y += bomb.vy;
      if (bomb.x < 0) bomb.x = 0; else if (bomb.x > SW_W) bomb.x = SW_W;
      if (bomb.y < 0) bomb.y = 0; else if (bomb.y > SW_H) bomb.y = SW_H;
    }
  }

  _checkBombs() {
    const BOMB_RADIUS = (this.settings.bomb_radius || 375);
    const BOMB_DAMAGE = (this.settings.bomb_damage || 100);
    for (const [bid, bomb] of Object.entries(this.gs.bombs)) {
      if (--bomb.timer > 0) continue;
      const hits = [];
      for (const s of Object.values(this.gs.snakes)) {
        if (!s.alive || s.id === bomb.ownerId) continue;
        if (Math.hypot(s.x - bomb.x, s.y - bomb.y) < BOMB_RADIUS) {
          s.tLen -= BOMB_DAMAGE;
          if (s.tLen < 1) { s.alive = false; this._spawnSoulOrb(s); }
          else if (s.trail.length > s.tLen) s.trail = s.trail.slice(s.trail.length - s.tLen);
          hits.push(s.id);
        }
      }
      this.broadcast('bombExplode', { id: bid, x: bomb.x, y: bomb.y, hits, radius: BOMB_RADIUS });
      delete this.gs.bombs[bid];
    }
  }

  throwBomb(socketId, { dir, power }) {
    const snakeId = this.gs?.playerMap[socketId];
    if (!snakeId) return;
    const s = this.gs.snakes[snakeId];
    if (!s?.alive || s.tLen < 45) return;
    s.tLen -= 40;
    if (s.trail.length > s.tLen) s.trail = s.trail.slice(s.trail.length - s.tLen);
    const BOMB_SPEED = 22;
    const dist  = Math.max(350, Math.min(1, power) * 2200);
    const timer = Math.round(dist / BOMB_SPEED);
    const bid   = 'b' + (this.idx++);
    const radiusBonus  = s.mods?.radius_bonus  || 0;
    const damageBonus  = s.mods?.damage_bonus  || 0;
    this.gs.bombs[bid] = {
      id: bid,
      x: s.x + Math.cos(dir) * 35,
      y: s.y + Math.sin(dir) * 35,
      vx: Math.cos(dir) * BOMB_SPEED,
      vy: Math.sin(dir) * BOMB_SPEED,
      ownerId: snakeId, timer,
      radiusBonus, damageBonus,
    };
  }

  // ── Mines ─────────────────────────────────────────────────────────────────
  _checkMines() {
    const MINE_DAMAGE = this.settings.mine_damage || 40;
    for (const s of Object.values(this.gs.snakes)) {
      if (!s.alive || s.spawnTimer > 0) continue;
      const resistPct = s.mods?.resist_pct || 0;
      const damage    = Math.round(MINE_DAMAGE * (1 - resistPct));
      for (const [mid, mine] of Object.entries(this.gs.mines)) {
        if (Math.hypot(s.x - mine.x, s.y - mine.y) < 23) {
          s.tLen -= damage;
          if (s.tLen < 1) { s.alive = false; this._spawnSoulOrb(s); }
          else if (s.trail.length > s.tLen) s.trail = s.trail.slice(s.trail.length - s.tLen);
          this.broadcast('mineHit', { id: mid, x: mine.x, y: mine.y, snakeId: s.id });
          delete this.gs.mines[mid];
          this._spawnMine();
          break;
        }
      }
    }
  }

  // ── Active abilities ──────────────────────────────────────────────────────
  useActive(socketId, itemType) {
    const snakeId = this.gs?.playerMap[socketId];
    if (!snakeId) return;
    const s = this.gs.snakes[snakeId];
    if (!s?.alive) return;
    const ab = s.activeAbilities || {};

    if (itemType === 'invisibility') {
      const props = ab.invisibility;
      if (!props) return;
      const now = Date.now();
      if (props.lastUsed && now - props.lastUsed < props.cooldown_sec * 1000) return;
      props.lastUsed = now;
      s.invisible = true;
      this.broadcast('player_invisible', { id: snakeId, duration_sec: props.duration_sec });
      setTimeout(() => { s.invisible = false; }, props.duration_sec * 1000);
    }
    if (itemType === 'shield') {
      const props = ab.shield;
      if (!props || props.active) return;
      const now = Date.now();
      if (props.lastUsed && now - props.lastUsed < props.cooldown_sec * 1000) return;
      props.lastUsed = now;
      s.shielded = true;
      this.broadcast('player_shielded', { id: snakeId });
    }
  }

  // ── Player dir / boost ────────────────────────────────────────────────────
  setDir(socketId, dir) {
    const id = this.gs?.playerMap[socketId];
    if (id && this.gs.snakes[id]) this.gs.snakes[id].dir = dir;
  }

  setBoost(socketId, on) {
    const id = this.gs?.playerMap[socketId];
    if (id && this.gs.snakes[id]?.alive) this.gs.snakes[id].boosting = !!on;
  }

  // ── State serializers ─────────────────────────────────────────────────────
  _buildRoomState() {
    return {
      id: this.id,
      name: this.name,
      capacity: this.capacity,
      npcFill: this.npcFill,
      duration: this.duration,
      status: this.status,
      players: Object.values(this.players).map(p => ({
        socketId: p.socketId, name: p.name, emoji: p.emoji,
        ready: p.ready, isHost: p.isHost,
      })),
    };
  }

  _buildState() {
    const snakes = Object.values(this.gs.snakes).map(s => {
      const body = [];
      for (let i = 0; i < s.trail.length; i += SW_SAMPLE) body.push(s.trail[i]);
      if (s.trail.length) {
        const last = s.trail[s.trail.length - 1];
        if (!body.length || body[body.length - 1] !== last) body.push(last);
      }
      return {
        id: s.id, name: s.name, emoji: s.emoji,
        bodyColor: s.invisible ? 'transparent' : s.bodyColor,
        headColor: s.invisible ? 'transparent' : s.headColor,
        x: Math.round(s.x), y: Math.round(s.y), dir: s.dir,
        body: body.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        len: s.tLen, alive: s.alive, score: s.score, isNPC: s.isNPC,
        boosting: s.boosting, shielded: !!s.shielded, invisible: !!s.invisible,
        deathTimer: s.deathTimer, spawnTimer: s.spawnTimer,
      };
    });

    return {
      snakes,
      fruits: Object.values(this.gs.fruits).map(f => ({
        id: f.id, x: Math.round(f.x), y: Math.round(f.y),
        color: f.color, radius: f.radius, soul: !!f.soul,
      })),
      bombs: Object.values(this.gs.bombs).map(b => ({
        id: b.id, x: Math.round(b.x), y: Math.round(b.y), t: b.timer,
      })),
      mines: Object.values(this.gs.mines).map(m => ({
        id: m.id, x: Math.round(m.x), y: Math.round(m.y),
      })),
      timeLeft: Math.ceil(this.timeLeft / 30),
      mapW: SW_W, mapH: SW_H,
    };
  }

  // ── Public room info (for listing) ───────────────────────────────────────
  toListItem() {
    return {
      id: this.id,
      name: this.name,
      hasPassword: !!this.password,
      capacity: this.capacity,
      playerCount: this.playerCount,
      npcFill: this.npcFill,
      duration: this.duration,
      status: this.status,
    };
  }
}

module.exports = GameRoom;
