'use strict';
const express = require('express');
const db = require('../db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// Slot validation: which item types belong to which slot
const SLOT_MAP = {
  skin: 'skin', gradient: 'skin', pattern: 'skin',
  effect: 'effect', trail: 'trail',
  magnet: 'passive_1', boost_upgrade: 'passive_2',
  bomb_radius: 'passive_3', bomb_damage: 'passive_4',
  mine_resist: 'passive_5', head_start: 'passive_6',
  invisibility: 'active_1', shield: 'active_2', dash: 'active_3',
};

// GET /api/shop
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, description, category, type, rarity,
              price, duration_tiers, properties, is_consumable, max_stack, sort_order
       FROM shop_items WHERE active = TRUE ORDER BY sort_order, id`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// GET /api/shop/inventory  (caller's owned items)
router.get('/inventory', verifyToken, async (req, res) => {
  try {
    // Clean expired items first
    await db.query(
      `DELETE FROM user_inventory WHERE user_id = $1 AND expires_at IS NOT NULL AND expires_at < NOW()`,
      [req.user.userId]
    );
    const { rows } = await db.query(
      `SELECT ui.item_id, ui.quantity, ui.expires_at, ui.bought_at,
              si.name, si.category, si.type, si.rarity, si.properties, si.is_consumable
       FROM user_inventory ui
       JOIN shop_items si ON si.id = ui.item_id
       WHERE ui.user_id = $1`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// POST /api/shop/buy  { item_id, duration_hours? }
router.post('/buy', verifyToken, async (req, res) => {
  const { item_id, duration_hours } = req.body || {};
  if (!item_id) return res.status(400).json({ error: 'item_id gerekli' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: items } = await client.query(
      'SELECT * FROM shop_items WHERE id = $1 AND active = TRUE', [item_id]
    );
    if (!items.length) return res.status(404).json({ error: 'Ürün bulunamadı' });
    const item = items[0];

    // Determine price
    let price = item.price;
    let expiresAt = null;

    if (item.duration_tiers && item.duration_tiers.length) {
      const tiers = item.duration_tiers;
      const tier = tiers.find(t => t.hours === duration_hours);
      if (!tier) return res.status(400).json({ error: 'Geçersiz süre seçeneği' });
      price = tier.price;
      expiresAt = new Date(Date.now() + duration_hours * 3600 * 1000);
    }

    // Check user gold
    const { rows: users } = await client.query(
      'SELECT gold FROM users WHERE id = $1 FOR UPDATE', [req.user.userId]
    );
    if (!users.length) throw new Error('User not found');
    if (users[0].gold < price) {
      await client.query('ROLLBACK');
      return res.status(402).json({ error: 'Yetersiz altın' });
    }

    // Check if non-consumable already owned and still valid
    if (!item.is_consumable) {
      const { rows: owned } = await client.query(
        `SELECT quantity, expires_at FROM user_inventory
         WHERE user_id = $1 AND item_id = $2`,
        [req.user.userId, item_id]
      );
      if (owned.length && (!owned[0].expires_at || new Date(owned[0].expires_at) > new Date())) {
        if (item.duration_tiers && item.duration_tiers.length) {
          // Renew: extend expires_at
          await client.query(
            `UPDATE user_inventory SET expires_at = $1 WHERE user_id = $2 AND item_id = $3`,
            [expiresAt, req.user.userId, item_id]
          );
        } else {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Bu ürün zaten sahipsinizde' });
        }
      } else {
        await client.query(
          `INSERT INTO user_inventory (user_id, item_id, quantity, expires_at)
           VALUES ($1, $2, 1, $3)
           ON CONFLICT (user_id, item_id) DO UPDATE
           SET quantity = 1, expires_at = EXCLUDED.expires_at, bought_at = NOW()`,
          [req.user.userId, item_id, expiresAt]
        );
      }
    } else {
      // Consumable: increment quantity
      const { rows: owned } = await client.query(
        `SELECT quantity FROM user_inventory WHERE user_id = $1 AND item_id = $2`,
        [req.user.userId, item_id]
      );
      const currentQty = owned[0]?.quantity || 0;
      if (currentQty >= item.max_stack) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Maksimum ${item.max_stack} adet satın alınabilir` });
      }
      await client.query(
        `INSERT INTO user_inventory (user_id, item_id, quantity)
         VALUES ($1, $2, 1)
         ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = user_inventory.quantity + 1`,
        [req.user.userId, item_id]
      );
    }

    // Deduct gold
    const { rows: updated } = await client.query(
      'UPDATE users SET gold = gold - $1 WHERE id = $2 RETURNING gold',
      [price, req.user.userId]
    );

    await client.query('COMMIT');
    res.json({ success: true, new_gold: updated[0].gold, item_id, expires_at: expiresAt });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  } finally {
    client.release();
  }
});

// POST /api/shop/equip  { item_id, slot }
router.post('/equip', verifyToken, async (req, res) => {
  const { item_id } = req.body || {};
  if (!item_id) return res.status(400).json({ error: 'item_id gerekli' });

  try {
    // Verify ownership and validity
    const { rows } = await db.query(
      `SELECT ui.item_id, si.type
       FROM user_inventory ui
       JOIN shop_items si ON si.id = ui.item_id
       WHERE ui.user_id = $1 AND ui.item_id = $2
         AND (ui.expires_at IS NULL OR ui.expires_at > NOW())
         AND (ui.quantity > 0)`,
      [req.user.userId, item_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item sahipliğinde değil veya süresi dolmuş' });

    const slot = SLOT_MAP[rows[0].type];
    if (!slot) return res.status(400).json({ error: 'Bu item equip edilemez' });

    await db.query(
      `INSERT INTO user_equipped (user_id, slots) VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE
       SET slots = user_equipped.slots || $2::jsonb`,
      [req.user.userId, JSON.stringify({ [slot]: item_id })]
    );
    res.json({ success: true, slot, item_id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// POST /api/shop/unequip  { slot }
router.post('/unequip', verifyToken, async (req, res) => {
  const { slot } = req.body || {};
  if (!slot) return res.status(400).json({ error: 'slot gerekli' });
  try {
    await db.query(
      `INSERT INTO user_equipped (user_id, slots) VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE
       SET slots = user_equipped.slots || $2::jsonb`,
      [req.user.userId, JSON.stringify({ [slot]: null })]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

module.exports = router;
