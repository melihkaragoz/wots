'use strict';
const express = require('express');
const db = require('../db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// POST /api/match/end
// Called by server game engine after match — not directly by client
// But also exposed as HTTP for mobile clients
router.post('/end', verifyToken, async (req, res) => {
  const { kills = 0, max_size = 0, duration_sec = 0, rank = 99 } = req.body || {};

  // Sanity checks
  if (duration_sec < 10) return res.status(400).json({ error: 'Geçersiz maç süresi' });

  try {
    // Load reward multipliers from settings
    const { rows: settingRows } = await db.query(
      `SELECT key, value FROM app_settings WHERE key IN ('gold_per_minute','gold_per_kill','gold_per_100size')`
    );
    const s = {};
    for (const r of settingRows) s[r.key] = r.value?.value ?? r.value;
    const gpm   = s.gold_per_minute   ?? 1;
    const gpk   = s.gold_per_kill     ?? 2;
    const gp100 = s.gold_per_100size  ?? 1;

    // Check gold_boost consumable
    const { rows: boostRows } = await db.query(
      `SELECT quantity FROM user_inventory ui
       JOIN shop_items si ON si.id = ui.item_id
       WHERE ui.user_id = $1 AND si.type = 'gold_boost'
         AND ui.quantity > 0
         AND (ui.expires_at IS NULL OR ui.expires_at > NOW())`,
      [req.user.userId]
    );
    const multiplier = boostRows.length ? 2 : 1;
    if (boostRows.length) {
      await db.query(
        `UPDATE user_inventory SET quantity = quantity - 1
         WHERE user_id = $1 AND item_id IN (
           SELECT ui.item_id FROM user_inventory ui
           JOIN shop_items si ON si.id = ui.item_id
           WHERE ui.user_id = $1 AND si.type = 'gold_boost' AND ui.quantity > 0
           LIMIT 1
         )`,
        [req.user.userId]
      );
    }

    const base_gold = Math.floor(duration_sec / 60) * gpm
                    + kills * gpk
                    + Math.floor(max_size / 100) * gp100;
    const gold_earned = Math.round(base_gold * multiplier);

    // Evaluate reward rules
    const { rows: rules } = await db.query(
      'SELECT * FROM reward_rules WHERE active = TRUE'
    );
    const pendingInserts = [];
    const stats = { kills, max_size, duration_sec, rank };
    // Check how many games user has played (before this one)
    const { rows: statsRows } = await db.query(
      'SELECT games_played FROM user_stats WHERE user_id = $1', [req.user.userId]
    );
    const gamesPlayed = (statsRows[0]?.games_played ?? 0) + 1;

    for (const rule of rules) {
      const c = rule.condition;
      let match = false;
      if (c.type === 'kills_gte'       && kills        >= c.value) match = true;
      if (c.type === 'rank_lte'        && rank         <= c.value) match = true;
      if (c.type === 'survival_gte'    && duration_sec >= c.value) match = true;
      if (c.type === 'max_size_gte'    && max_size     >= c.value) match = true;
      if (c.type === 'games_played_eq' && gamesPlayed  === c.value) match = true;
      if (!match) continue;

      const rw = rule.reward;
      if (rw.type === 'gold') {
        pendingInserts.push({ gold_amount: rw.amount, reason: rule.name });
      } else if (rw.type === 'item') {
        pendingInserts.push({ item_id: rw.item_id, duration_hours: rw.duration_hours ?? null, reason: rule.name });
      } else if (rw.type === 'item_pool') {
        const pool = rw.pool || [];
        const picked = pool[Math.floor(Math.random() * pool.length)];
        if (picked) pendingInserts.push({ item_id: picked, duration_hours: rw.duration_hours ?? null, reason: rule.name });
      }
    }

    // DB transaction
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      // Give gold
      await client.query('UPDATE users SET gold = gold + $1 WHERE id = $2', [gold_earned, req.user.userId]);
      // Update stats
      await client.query(
        `INSERT INTO user_stats (user_id, total_kills, max_size, total_seconds, games_played)
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (user_id) DO UPDATE SET
           total_kills   = user_stats.total_kills   + EXCLUDED.total_kills,
           max_size      = GREATEST(user_stats.max_size, EXCLUDED.max_size),
           total_seconds = user_stats.total_seconds + EXCLUDED.total_seconds,
           games_played  = user_stats.games_played  + 1`,
        [req.user.userId, kills, max_size, duration_sec]
      );
      // Insert pending rewards
      for (const p of pendingInserts) {
        await client.query(
          `INSERT INTO pending_rewards (user_id, item_id, duration_hours, gold_amount, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.user.userId, p.item_id || null, p.duration_hours || null, p.gold_amount || null, p.reason]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Auto-claim ALL rewards (gold + items)
    const goldRewards = pendingInserts.filter(p => p.gold_amount);
    if (goldRewards.length) {
      const bonus = goldRewards.reduce((s, p) => s + p.gold_amount, 0);
      await db.query('UPDATE users SET gold = gold + $1 WHERE id = $2', [bonus, req.user.userId]);
    }

    // Auto-claim item rewards into inventory
    const itemRewards = pendingInserts.filter(p => p.item_id);
    for (const ir of itemRewards) {
      const expiresAt = ir.duration_hours
        ? new Date(Date.now() + ir.duration_hours * 3600 * 1000)
        : null;
      await db.query(
        `INSERT INTO user_inventory (user_id, item_id, quantity, expires_at)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (user_id, item_id) DO UPDATE
         SET quantity = user_inventory.quantity + 1,
             expires_at = GREATEST(user_inventory.expires_at, EXCLUDED.expires_at)`,
        [req.user.userId, ir.item_id, expiresAt]
      );
    }

    // Mark all pending rewards as claimed
    if (pendingInserts.length) {
      await db.query(
        `UPDATE pending_rewards SET claimed = TRUE
         WHERE user_id = $1 AND claimed = FALSE`,
        [req.user.userId]
      );
    }

    const { rows: goldRow } = await db.query('SELECT gold FROM users WHERE id = $1', [req.user.userId]);

    // Get item names for response
    const rewardDetails = [];
    for (const p of pendingInserts) {
      const detail = {
        reason: p.reason,
        type: p.gold_amount ? 'gold' : 'item',
        amount: p.gold_amount,
        item_id: p.item_id,
        duration_hours: p.duration_hours,
      };
      if (p.item_id) {
        const { rows: itemRows } = await db.query('SELECT name FROM shop_items WHERE id = $1', [p.item_id]);
        detail.item_name = itemRows[0]?.name || null;
      }
      rewardDetails.push(detail);
    }

    res.json({
      gold_earned,
      bonus_gold: goldRewards.reduce((s, p) => s + p.gold_amount, 0),
      new_total_gold: goldRow[0].gold,
      stats,
      rewards: rewardDetails,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// GET /api/match/pending-rewards  (unclaimed item rewards)
router.get('/pending-rewards', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT pr.*, si.name AS item_name, si.category, si.type, si.rarity
       FROM pending_rewards pr
       LEFT JOIN shop_items si ON si.id = pr.item_id
       WHERE pr.user_id = $1 AND pr.claimed = FALSE AND pr.item_id IS NOT NULL`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// POST /api/match/claim-reward/:id
router.post('/claim-reward/:id', verifyToken, async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM pending_rewards WHERE id = $1 AND user_id = $2 AND claimed = FALSE FOR UPDATE`,
      [req.params.id, req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ödül bulunamadı' });
    const reward = rows[0];

    if (reward.item_id) {
      const expiresAt = reward.duration_hours
        ? new Date(Date.now() + reward.duration_hours * 3600 * 1000)
        : null;
      await client.query(
        `INSERT INTO user_inventory (user_id, item_id, quantity, expires_at)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (user_id, item_id) DO UPDATE
         SET quantity = user_inventory.quantity + 1,
             expires_at = GREATEST(user_inventory.expires_at, EXCLUDED.expires_at)`,
        [req.user.userId, reward.item_id, expiresAt]
      );
    }
    await client.query('UPDATE pending_rewards SET claimed = TRUE WHERE id = $1', [reward.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Sunucu hatası' });
  } finally {
    client.release();
  }
});

module.exports = router;
