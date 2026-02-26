'use strict';
require('dotenv').config();

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const db       = require('./db');
const GameRoom = require('./game/room');
const { fetchSettings } = require('./routes/settings');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { pingTimeout: 60000 });

app.use(express.json());

// ── Static / web client ────────────────────────────────────────────────────
app.get('/',      (req, res) => res.redirect('/snake'));
app.get('/snake', (req, res) => res.sendFile(path.join(__dirname, 'snake', 'index.html')));
app.use('/snake', express.static(path.join(__dirname, 'snake')));

// ── API routes ─────────────────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/shop',     require('./routes/shop'));
app.use('/api/match',    require('./routes/match'));
app.use('/admin',        require('./routes/admin'));

// ── Game settings cache ────────────────────────────────────────────────────
let gameSettings = {
  offline_min_players:      5,
  online_room_max_capacity: 15,
  match_duration_sec:       300,
  gold_per_minute:          1,
  gold_per_kill:            2,
  gold_per_100size:         1,
  bomb_damage:              100,
  bomb_radius:              375,
  mine_damage:              40,
  sw_speed:                 6,
  attract_range:            120,
  npc_respawn_delay_ticks:  90,
  respawn_delay_ticks:      90,
  boost_drain_div:          10,
};

async function refreshSettings() {
  try {
    gameSettings = { ...gameSettings, ...await fetchSettings() };
    // Propagate to all active rooms
    for (const room of Object.values(activeRooms)) room.settings = { ...gameSettings };
  } catch (e) { console.warn('Settings refresh failed:', e.message); }
}
setInterval(refreshSettings, 30_000);

// Seed default settings into DB (insert only if missing)
async function seedDefaults() {
  const defaults = { ...gameSettings };
  for (const [key, value] of Object.entries(defaults)) {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify({ value })]
    );
  }
}
seedDefaults().then(() => refreshSettings()).catch(e => console.warn('Seed failed:', e.message));

// ── Socket.io — Snake Wars namespace ──────────────────────────────────────
// Defined here so GameRoom receives the correct namespace for broadcasts
const swIo = io.of('/snake');

// ── Room registry ──────────────────────────────────────────────────────────
const activeRooms = {};   // roomId → GameRoom

function createRoom(config) {
  const room = new GameRoom(
    { id: uuidv4(), ...config },
    { ...gameSettings },
    swIo                        // ← namespace, not root io
  );
  room.on('destroyed', ({ roomId }) => { delete activeRooms[roomId]; });
  room.on('match_end', handleMatchEnd);
  activeRooms[room.id] = room;
  return room;
}

// HTTP: GET /api/rooms
app.get('/api/rooms', (req, res) => {
  const list = Object.values(activeRooms)
    .filter(r => r.status === 'waiting' || r.status === 'countdown')
    .map(r => r.toListItem());
  res.json(list);
});

// HTTP: POST /api/rooms
app.post('/api/rooms', (req, res) => {
  const { name, capacity, npcFill, password } = req.body || {};
  const maxCap = gameSettings.online_room_max_capacity || 15;
  const cap = Math.min(maxCap, Math.max(2, parseInt(capacity) || 8));
  const room = createRoom({
    name: (name || 'Oda').slice(0, 40),
    capacity: cap,
    npcFill: npcFill !== false,
    password: password || null,
  });
  res.status(201).json({ roomId: room.id });
});

// ── Post-match DB handler ──────────────────────────────────────────────────
async function handleMatchEnd({ roomId, leaderboard }) {
  // Gold + stats are handled by the client via POST /api/match/end
  // This handler is intentionally empty to prevent double-writes
}

// Optional JWT auth on socket connect
const jwt = require('jsonwebtoken');
swIo.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {}
  }
  next();
});

swIo.on('connection', (socket) => {
  let currentRoomId = null;

  // ── Room: list ──────────────────────────────────────────────────────────
  socket.on('list_rooms', () => {
    socket.emit('rooms_list', Object.values(activeRooms)
      .map(r => r.toListItem())
    );
  });

  // ── Room: create ────────────────────────────────────────────────────────
  socket.on('create_room', ({ name, capacity, npcFill, password, duration }) => {
    const maxCap = gameSettings.online_room_max_capacity || 15;
    const cap = Math.min(maxCap, Math.max(2, parseInt(capacity) || 8));
    const dur = [5, 10, 15, 20].includes(parseInt(duration)) ? parseInt(duration) : 10;
    const room = createRoom({
      name: (name || 'Oda').slice(0, 40),
      capacity: cap,
      npcFill: npcFill !== false,
      password: password || null,
      duration: dur,
    });
    socket.emit('room_created', { roomId: room.id });
  });

  // ── Room: join ──────────────────────────────────────────────────────────
  socket.on('join_room', ({ roomId, name, animal, password: pw }) => {
    const room = activeRooms[roomId];
    if (!room) return socket.emit('error', { msg: 'Oda bulunamadı' });
    if (room.isFull) return socket.emit('error', { msg: 'Oda dolu' });
    if (room.password && room.password !== pw)
      return socket.emit('error', { msg: 'Yanlış şifre' });

    // Leave previous room if any
    if (currentRoomId && activeRooms[currentRoomId]) {
      activeRooms[currentRoomId].removePlayer(socket.id);
    }

    const a = ['snake','fox','dragon','lion','wolf','bear'].includes(animal) ? animal : 'snake';
    const animals = require('./game/room').__animals || {
      snake:'🐍', fox:'🦊', dragon:'🐉', lion:'🦁', wolf:'🐺', bear:'🐻',
    };
    // Load user mods from DB if authenticated
    let mods = {};
    (async () => {
      if (socket.user?.userId) {
        try {
          mods = await getUserMods(socket.user.userId);
        } catch {}
      }
      const emojiMap = { snake:'🐍', fox:'🦊', dragon:'🐉', lion:'🦁', wolf:'🐺', bear:'🐻' };
      const displayName = socket.user?.username || name || 'Oyuncu';
      room.addPlayer(socket, {
        name: displayName.slice(0, 16),
        animal: a,
        emoji: emojiMap[a] || '🐍',
        userId: socket.user?.userId || null,
        mods,
      });
      currentRoomId = roomId;
      socket.emit('room_joined', { roomId, roomState: room._buildRoomState() });
    })();
  });

  // ── Room: ready toggle ──────────────────────────────────────────────────
  socket.on('ready', ({ ready = true }) => {
    const room = activeRooms[currentRoomId];
    if (room) room.setReady(socket.id, ready);
  });

  // ── In-game events ──────────────────────────────────────────────────────
  socket.on('dir',        ({ dir })         => { activeRooms[currentRoomId]?.setDir(socket.id, dir); });
  socket.on('boost',      ({ on })           => { activeRooms[currentRoomId]?.setBoost(socket.id, on); });
  socket.on('throwBomb',  ({ dir, power })   => { activeRooms[currentRoomId]?.throwBomb(socket.id, { dir, power }); });
  socket.on('use_active', ({ type })         => { activeRooms[currentRoomId]?.useActive(socket.id, type); });

  socket.on('chat', ({ msg }) => {
    const room = activeRooms[currentRoomId];
    if (!room || !msg) return;
    const p = room.players[socket.id];
    if (!p) return;
    const entry = { name: p.name, emoji: p.emoji, msg: String(msg).slice(0, 120) };
    room.broadcast('chatMsg', entry);
  });

  // ── Leave / disconnect ──────────────────────────────────────────────────
  socket.on('leave_room', () => {
    if (currentRoomId && activeRooms[currentRoomId]) {
      activeRooms[currentRoomId].removePlayer(socket.id);
      currentRoomId = null;
    }
  });

  socket.on('disconnect', () => {
    if (currentRoomId && activeRooms[currentRoomId]) {
      activeRooms[currentRoomId].removePlayer(socket.id);
    }
  });
});

// ── Load equipped mods for a user ─────────────────────────────────────────
async function getUserMods(userId) {
  // Clean expired items
  await db.query(
    `DELETE FROM user_inventory WHERE user_id = $1 AND expires_at IS NOT NULL AND expires_at < NOW()`,
    [userId]
  );
  const { rows: equippedRows } = await db.query(
    'SELECT slots FROM user_equipped WHERE user_id = $1', [userId]
  );
  if (!equippedRows.length) return {};
  const slots = equippedRows[0].slots || {};

  const mods = {};
  const activeAbilities = {};
  let skinColors = null;

  for (const [slot, itemId] of Object.entries(slots)) {
    if (!itemId) continue;
    const { rows } = await db.query(
      `SELECT si.type, si.properties
       FROM shop_items si
       JOIN user_inventory ui ON ui.item_id = si.id
       WHERE si.id = $1 AND ui.user_id = $2
         AND (ui.expires_at IS NULL OR ui.expires_at > NOW())`,
      [itemId, userId]
    );
    if (!rows.length) continue;
    const { type, properties: p } = rows[0];
    // Appearance items
    if (type === 'skin')          skinColors = { body: p.body, head: p.head };
    if (type === 'gradient')      skinColors = { body: p.from || p.colors?.[0], head: p.to || p.colors?.[1], gradient: p };
    if (type === 'pattern')       mods.pattern = p;
    if (type === 'effect')        mods.effect  = p;
    if (type === 'trail')         mods.trail   = p;
    // Upgrade items
    if (type === 'magnet')        mods.attract_range = p.attract_range;
    if (type === 'boost_upgrade') { mods.boost_speed_mult = p.speed_mult; mods.boost_drain_div = p.drain_div; }
    if (type === 'bomb_radius')   mods.radius_bonus  = p.radius_bonus;
    if (type === 'bomb_damage')   mods.damage_bonus  = p.damage_bonus;
    if (type === 'mine_resist')   mods.resist_pct    = p.resist_pct;
    if (type === 'head_start')    mods.bonus_size    = p.bonus_size;
    if (type === 'invisibility')  activeAbilities.invisibility = p;
    if (type === 'shield')        activeAbilities.shield = { ...p, active: false };
    if (type === 'dash')          activeAbilities.dash = p;
  }

  return { ...mods, skinColors, activeAbilities };
}

// ── Startup ────────────────────────────────────────────────────────────────
async function start() {
  await refreshSettings();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Snake Wars → http://0.0.0.0:${PORT}`);
    console.log(`Admin Panel → http://0.0.0.0:${PORT}/admin`);
  });
}
start().catch(e => { console.error('Startup error:', e); process.exit(1); });
