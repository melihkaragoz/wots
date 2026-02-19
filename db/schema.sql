-- Snake Wars v2 – Database Schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(30) UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  gold          INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── User Stats ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_stats (
  user_id       UUID    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_kills   INTEGER NOT NULL DEFAULT 0,
  max_size      INTEGER NOT NULL DEFAULT 0,
  total_seconds INTEGER NOT NULL DEFAULT 0,
  games_played  INTEGER NOT NULL DEFAULT 0
);

-- ── Shop Items ─────────────────────────────────────────────────────────────
-- category : appearance | upgrade | active | consumable
-- type     : skin | gradient | pattern | effect | trail |
--            magnet | boost_upgrade | bomb_radius | bomb_damage |
--            mine_resist | head_start |
--            invisibility | shield | dash |
--            revive | gold_boost
-- duration_tiers: null = permanent/consumable (use price column)
--                 JSON array = timed, price column is null
CREATE TABLE IF NOT EXISTS shop_items (
  id             VARCHAR(60)  PRIMARY KEY,
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  category       VARCHAR(30)  NOT NULL,
  type           VARCHAR(50)  NOT NULL,
  rarity         VARCHAR(20)  NOT NULL DEFAULT 'common',
  price          INTEGER,
  duration_tiers JSONB,
  properties     JSONB        NOT NULL DEFAULT '{}',
  is_consumable  BOOLEAN      NOT NULL DEFAULT FALSE,
  max_stack      INTEGER      NOT NULL DEFAULT 1,
  active         BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order     INTEGER      NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── User Inventory ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_inventory (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    VARCHAR(60) NOT NULL REFERENCES shop_items(id),
  quantity   INTEGER     NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ,           -- NULL = permanent
  bought_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, item_id)
);

-- ── User Equipped Slots ────────────────────────────────────────────────────
-- slots JSON: { "skin": "item_id", "effect": null, "passive_1": "item_id", ... }
CREATE TABLE IF NOT EXISTS user_equipped (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slots   JSONB NOT NULL DEFAULT '{}'
);

-- ── Reward Rules ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reward_rules (
  id          SERIAL      PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  condition   JSONB       NOT NULL,
  reward      JSONB       NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT TRUE
);

-- ── Pending Rewards ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_rewards (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id        VARCHAR(60) REFERENCES shop_items(id),
  duration_hours INTEGER,
  gold_amount    INTEGER,
  reason         VARCHAR(100),
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed        BOOLEAN     NOT NULL DEFAULT FALSE
);

-- ── App Settings ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(100) PRIMARY KEY,
  value      JSONB        NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_inventory_user ON user_inventory(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_expires ON user_inventory(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pending_rewards_user ON pending_rewards(user_id, claimed);
