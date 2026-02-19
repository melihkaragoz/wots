'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

async function fetchSettings() {
  const { rows } = await db.query('SELECT key, value FROM app_settings ORDER BY key');
  const obj = {};
  for (const r of rows) obj[r.key] = r.value?.value ?? r.value;
  return obj;
}

function makeChecksum(settings) {
  const str = JSON.stringify(settings, Object.keys(settings).sort());
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

// GET /api/settings
router.get('/', async (req, res) => {
  try {
    const settings = await fetchSettings();
    res.json({ checksum: makeChecksum(settings), settings });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// GET /api/settings/checksum
router.get('/checksum', async (req, res) => {
  try {
    const settings = await fetchSettings();
    res.json({ checksum: makeChecksum(settings) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

module.exports = router;
module.exports.fetchSettings = fetchSettings;
module.exports.makeChecksum = makeChecksum;
