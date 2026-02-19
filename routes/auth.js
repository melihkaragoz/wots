'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();
const SALT_ROUNDS = 12;

function makeToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password)
    return res.status(400).json({ error: 'username, email ve password gerekli' });
  if (username.length < 2 || username.length > 30)
    return res.status(400).json({ error: 'Kullanıcı adı 2-30 karakter olmalı' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı' });

  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await db.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id, username, email, gold`,
      [username.trim(), email.toLowerCase().trim(), hash]
    );
    const user = rows[0];
    // Create stats row
    await db.query('INSERT INTO user_stats (user_id) VALUES ($1)', [user.id]);
    await db.query('INSERT INTO user_equipped (user_id) VALUES ($1)', [user.id]);
    res.status(201).json({ token: makeToken(user), user });
  } catch (e) {
    if (e.code === '23505') {
      const field = e.detail?.includes('email') ? 'E-posta' : 'Kullanıcı adı';
      return res.status(409).json({ error: `${field} zaten kullanımda` });
    }
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'email ve password gerekli' });

  try {
    const { rows } = await db.query(
      'SELECT id, username, email, gold, password_hash FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(401).json({ error: 'E-posta veya şifre hatalı' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'E-posta veya şifre hatalı' });
    delete user.password_hash;
    res.json({ token: makeToken(user), user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth').verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.email, u.gold,
              s.total_kills, s.max_size, s.total_seconds, s.games_played,
              e.slots AS equipped
       FROM users u
       LEFT JOIN user_stats   s ON s.user_id = u.id
       LEFT JOIN user_equipped e ON e.user_id = u.id
       WHERE u.id = $1`,
      [req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

module.exports = router;
