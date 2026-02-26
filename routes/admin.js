'use strict';
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const db = require('../db');

const router = express.Router();

// HTTP Basic Auth guard
function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Snake Wars Admin"');
    return res.status(401).send('Giriş gerekli');
  }
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  if (user !== process.env.ADMIN_USER || pass !== process.env.ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Snake Wars Admin"');
    return res.status(401).send('Hatalı kullanıcı adı veya şifre');
  }
  next();
}

router.use(adminAuth);

// Panel HTML
router.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, '../admin/index.html'))
);

// GET /admin/api/settings
router.get('/api/settings', async (req, res) => {
  const { rows } = await db.query('SELECT key, value FROM app_settings ORDER BY key');
  res.json(rows);
});

// PUT /admin/api/settings
router.put('/api/settings', async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key gerekli' });
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify({ value })]
  );
  res.json({ ok: true });
});

// GET /admin/api/shop
router.get('/api/shop', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM shop_items ORDER BY sort_order, id');
  res.json(rows);
});

// POST /admin/api/shop
router.post('/api/shop', async (req, res) => {
  const { id, name, description, category, type, rarity, price, duration_tiers, properties, is_consumable, max_stack, sort_order } = req.body || {};
  if (!id || !name || !category || !type) return res.status(400).json({ error: 'Eksik alan' });
  await db.query(
    `INSERT INTO shop_items (id,name,description,category,type,rarity,price,duration_tiers,properties,is_consumable,max_stack,sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, description=EXCLUDED.description, category=EXCLUDED.category,
       type=EXCLUDED.type, rarity=EXCLUDED.rarity, price=EXCLUDED.price,
       duration_tiers=EXCLUDED.duration_tiers, properties=EXCLUDED.properties,
       is_consumable=EXCLUDED.is_consumable, max_stack=EXCLUDED.max_stack, sort_order=EXCLUDED.sort_order`,
    [id, name, description || null, category, type, rarity || 'common',
     price || null, duration_tiers ? JSON.stringify(duration_tiers) : null,
     JSON.stringify(properties || {}), !!is_consumable, max_stack || 1, sort_order || 0]
  );
  res.json({ ok: true });
});

// PATCH /admin/api/shop/:id/toggle
router.patch('/api/shop/:id/toggle', async (req, res) => {
  await db.query('UPDATE shop_items SET active = NOT active WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// GET /admin/api/users
router.get('/api/users', async (req, res) => {
  const search = (req.query.q || '').trim();
  let query = `SELECT u.id, u.username, u.email, u.gold, u.created_at,
            s.total_kills, s.games_played, s.max_size
     FROM users u LEFT JOIN user_stats s ON s.user_id = u.id`;
  const params = [];
  if (search) {
    query += ` WHERE u.username ILIKE $1 OR u.email ILIKE $1`;
    params.push(`%${search}%`);
  }
  query += ` ORDER BY u.created_at DESC LIMIT 200`;
  const { rows } = await db.query(query, params);
  res.json(rows);
});

// POST /admin/api/users/:id/reset-password
router.post('/api/users/:id/reset-password', async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı' });
  const hash = await bcrypt.hash(password, 12);
  const { rowCount } = await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  res.json({ ok: true });
});

// POST /admin/api/users/:id/add-gold
router.post('/api/users/:id/add-gold', async (req, res) => {
  const { amount } = req.body || {};
  if (amount == null || isNaN(amount)) return res.status(400).json({ error: 'Geçerli bir miktar girin' });
  const { rowCount } = await db.query('UPDATE users SET gold = gold + $1 WHERE id = $2', [Number(amount), req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  res.json({ ok: true });
});

// GET /admin/api/reward-rules
router.get('/api/reward-rules', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM reward_rules ORDER BY id');
  res.json(rows);
});

// POST /admin/api/reward-rules
router.post('/api/reward-rules', async (req, res) => {
  const { name, condition, reward } = req.body || {};
  if (!name || !condition || !reward) return res.status(400).json({ error: 'Eksik alan' });
  const { rows } = await db.query(
    'INSERT INTO reward_rules (name, condition, reward) VALUES ($1,$2::jsonb,$3::jsonb) RETURNING *',
    [name, JSON.stringify(condition), JSON.stringify(reward)]
  );
  res.json(rows[0]);
});

// PATCH /admin/api/reward-rules/:id/toggle
router.patch('/api/reward-rules/:id/toggle', async (req, res) => {
  await db.query('UPDATE reward_rules SET active = NOT active WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
