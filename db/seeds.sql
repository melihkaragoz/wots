-- Snake Wars v2 – Seed Data

-- ── App Settings ───────────────────────────────────────────────────────────
INSERT INTO app_settings (key, value) VALUES
  ('offline_min_players',      '{"value": 5}'),
  ('online_room_max_capacity', '{"value": 15}'),
  ('match_duration_sec',       '{"value": 300}'),
  ('gold_per_minute',          '{"value": 1}'),
  ('gold_per_kill',            '{"value": 2}'),
  ('gold_per_100size',         '{"value": 1}'),
  ('bomb_damage',              '{"value": 100}'),
  ('bomb_radius',              '{"value": 375}'),
  ('mine_damage',              '{"value": 40}'),
  ('sw_speed',                 '{"value": 6}'),
  ('attract_range',            '{"value": 120}'),
  ('npc_respawn_delay_ticks',  '{"value": 90}'),
  ('respawn_delay_ticks',      '{"value": 90}')
ON CONFLICT (key) DO NOTHING;

-- ── Reward Rules ───────────────────────────────────────────────────────────
INSERT INTO reward_rules (name, condition, reward) VALUES
  ('5+ Kill Ödülü',         '{"type":"kills_gte","value":5}',        '{"type":"gold","amount":20}'),
  ('1. Sıra Bitirme',       '{"type":"rank_lte","value":1}',         '{"type":"gold","amount":30}'),
  ('3 Dakika Hayatta Kalma','{"type":"survival_gte","value":180}',   '{"type":"gold","amount":15}'),
  ('İlk Maç Hoşgeldin',     '{"type":"games_played_eq","value":1}',  '{"type":"item","item_id":"skin_ocean","duration_hours":null}')
ON CONFLICT DO NOTHING;

-- ── Shop Items ─────────────────────────────────────────────────────────────

-- APPEARANCE – Solid Skins (permanent, price column)
INSERT INTO shop_items (id, name, description, category, type, rarity, price, properties, sort_order) VALUES
  ('skin_crimson',   'Kırmızı',      'Klasik kırmızı yılan',          'appearance','skin','common',  50,  '{"body":"#e84040","head":"#b02020"}', 10),
  ('skin_ocean',     'Okyanus Mavisi','Derin mavi yılan',              'appearance','skin','common',  50,  '{"body":"#1e90ff","head":"#0055cc"}', 11),
  ('skin_forest',    'Orman Yeşili', 'Doğanın yeşili',                'appearance','skin','common',  50,  '{"body":"#27ae60","head":"#1a7a40"}', 12),
  ('skin_neon_pink', 'Neon Pembe',   'Göz alıcı neon pembe',          'appearance','skin','rare',    120, '{"body":"#ff00aa","head":"#cc0088"}', 13),
  ('skin_neon_cyan', 'Neon Camgöbeği','Parlak camgöbeği yılan',       'appearance','skin','rare',    120, '{"body":"#00ffee","head":"#00ccbb"}', 14),
  ('skin_galaxy',    'Galaksi',      'Uzayın derinlikleri',           'appearance','skin','epic',    300, '{"body":"#1a0033","head":"#6600cc"}', 15),
  ('skin_gold',      'Altın',        'Saf altın yılan',               'appearance','skin','epic',    300, '{"body":"#ffd700","head":"#ccaa00"}', 16),
  ('skin_obsidian',  'Obsidyen',     'Karanlığın efendisi',           'appearance','skin','legendary',600,'{"body":"#1a1a1a","head":"#444"}',  17)
ON CONFLICT (id) DO NOTHING;

-- APPEARANCE – Gradient (permanent)
INSERT INTO shop_items (id, name, description, category, type, rarity, price, properties, sort_order) VALUES
  ('gradient_sunset',  'Gün Batımı',  'Turuncu→Mor gradyan',          'appearance','gradient','rare',  180, '{"from":"#ff6b35","to":"#6c3483"}', 20),
  ('gradient_ocean',   'Okyanus',     'Mavi→Yeşil gradyan',           'appearance','gradient','rare',  180, '{"from":"#1e90ff","to":"#2ed573"}', 21),
  ('gradient_fire',    'Ateş',        'Kırmızı→Sarı gradyan',         'appearance','gradient','epic',  350, '{"from":"#ff2200","to":"#ffdd00"}', 22),
  ('gradient_rainbow', 'Gökkuşağı',   'Tüm renklerin dansı',          'appearance','gradient','legendary',700,'{"colors":["#ff0000","#ff7700","#ffff00","#00cc00","#0000ff","#cc00cc"]}',23)
ON CONFLICT (id) DO NOTHING;

-- APPEARANCE – Patterns (permanent)
INSERT INTO shop_items (id, name, description, category, type, rarity, price, properties, sort_order) VALUES
  ('pattern_polka',  'Puantiyeli',  'Renkli puantiyeli desen',        'appearance','pattern','rare',  200, '{"pattern":"polka","color1":"#fff","color2":"#ff4757","size":8}', 30),
  ('pattern_stripe', 'Çizgili',    'Zarif çizgili yılan',             'appearance','pattern','rare',  200, '{"pattern":"stripe","color1":"#fff","color2":"#1e90ff","size":10}',31),
  ('pattern_camo',   'Kamuflaj',   'Ormana karış',                    'appearance','pattern','epic',  380, '{"pattern":"camo","color1":"#4a7c59","color2":"#2d5a27","size":14}',32)
ON CONFLICT (id) DO NOTHING;

-- APPEARANCE – Effects (permanent)
INSERT INTO shop_items (id, name, description, category, type, rarity, price, properties, sort_order) VALUES
  ('effect_glitter', 'Simli',       'Etrafında altın parıltılar',     'appearance','effect','epic',   350, '{"fx":"glitter","color":"#ffd700","density":12}', 40),
  ('effect_fire',    'Alev Efekti', 'Ateş saçan yılan',               'appearance','effect','epic',   350, '{"fx":"fire","color":"#ff4500","density":10}',    41),
  ('effect_ice',     'Buz Efekti',  'Buz kristalleri',                'appearance','effect','rare',   220, '{"fx":"ice","color":"#a0e4ff","density":8}',      42)
ON CONFLICT (id) DO NOTHING;

-- APPEARANCE – Trail (permanent)
INSERT INTO shop_items (id, name, description, category, type, rarity, price, properties, sort_order) VALUES
  ('trail_fire',    'Ateş İzi',    'Geçtiğin yerlerde ateş yanar',   'appearance','trail','epic',    400, '{"fx":"fire","colors":["#ff4500","#ff8c00"]}', 50),
  ('trail_rainbow', 'Gökkuşağı İzi','Renkli gökkuşağı izi',          'appearance','trail','legendary',650,'{"fx":"rainbow"}',                            51),
  ('trail_ice',     'Buz İzi',     'Dondurucu buz izi',              'appearance','trail','rare',    250, '{"fx":"ice","colors":["#a0e4ff","#0077ff"]}',  52)
ON CONFLICT (id) DO NOTHING;

-- UPGRADE – Passive upgrades (timed, duration_tiers)
INSERT INTO shop_items (id, name, description, category, type, rarity, duration_tiers, properties, sort_order) VALUES
  ('upgrade_magnet',      'Mıknatıs',          '+100px meyve çekim menzili',    'upgrade','magnet',       'rare',
   '[{"label":"1 Saat","hours":1,"price":40},{"label":"1 Gün","hours":24,"price":120},{"label":"3 Gün","hours":72,"price":280},{"label":"1 Hafta","hours":168,"price":500}]',
   '{"attract_range":220}', 60),
  ('upgrade_boost',       'Güçlü Boost',        'Daha hızlı boost, daha az eriyiş','upgrade','boost_upgrade', 'rare',
   '[{"label":"1 Saat","hours":1,"price":40},{"label":"1 Gün","hours":24,"price":120},{"label":"3 Gün","hours":72,"price":280},{"label":"1 Hafta","hours":168,"price":500}]',
   '{"speed_mult":3.8,"drain_div":9}', 61),
  ('upgrade_bomb_radius', 'Bomba Menzil +50',  'Bomba patlamaya 50px daha geniş','upgrade','bomb_radius',  'common',
   '[{"label":"1 Saat","hours":1,"price":30},{"label":"1 Gün","hours":24,"price":90},{"label":"3 Gün","hours":72,"price":210},{"label":"1 Hafta","hours":168,"price":380}]',
   '{"radius_bonus":50}', 62),
  ('upgrade_bomb_damage', 'Bomba Hasar +50',   'Bombadan 50 puan daha fazla hasar','upgrade','bomb_damage', 'common',
   '[{"label":"1 Saat","hours":1,"price":30},{"label":"1 Gün","hours":24,"price":90},{"label":"3 Gün","hours":72,"price":210},{"label":"1 Hafta","hours":168,"price":380}]',
   '{"damage_bonus":50}', 63),
  ('upgrade_mine_resist', 'Mayın Zırhı',       'Mayın hasarını %30 azalt',      'upgrade','mine_resist',  'rare',
   '[{"label":"1 Saat","hours":1,"price":35},{"label":"1 Gün","hours":24,"price":100},{"label":"3 Gün","hours":72,"price":240},{"label":"1 Hafta","hours":168,"price":430}]',
   '{"resist_pct":0.30}', 64),
  ('upgrade_head_start',  'Büyük Başlangıç',   'Oyuna +20 boy ile başla',       'upgrade','head_start',   'common',
   '[{"label":"1 Saat","hours":1,"price":25},{"label":"1 Gün","hours":24,"price":75},{"label":"3 Gün","hours":72,"price":175},{"label":"1 Hafta","hours":168,"price":320}]',
   '{"bonus_size":20}', 65)
ON CONFLICT (id) DO NOTHING;

-- ACTIVE – Activatable abilities (timed, duration_tiers)
INSERT INTO shop_items (id, name, description, category, type, rarity, duration_tiers, properties, sort_order) VALUES
  ('active_invisibility', 'Görünmezlik',  '3sn görünmez, 30sn bekleme',  'active','invisibility','rare',
   '[{"label":"1 Saat","hours":1,"price":50},{"label":"1 Gün","hours":24,"price":150},{"label":"3 Gün","hours":72,"price":350},{"label":"1 Hafta","hours":168,"price":620}]',
   '{"duration_sec":3,"cooldown_sec":30}', 70),
  ('active_shield',       'Kalkan',       'Bir darbe emer, 60sn bekleme', 'active','shield',       'rare',
   '[{"label":"1 Saat","hours":1,"price":50},{"label":"1 Gün","hours":24,"price":150},{"label":"3 Gün","hours":72,"price":350},{"label":"1 Hafta","hours":168,"price":620}]',
   '{"charges":1,"cooldown_sec":60}', 71),
  ('active_dash',         'Ani Hız',      '5sn hız patlaması, 45sn bekleme','active','dash',        'rare',
   '[{"label":"1 Saat","hours":1,"price":40},{"label":"1 Gün","hours":24,"price":120},{"label":"3 Gün","hours":72,"price":280},{"label":"1 Hafta","hours":168,"price":500}]',
   '{"duration_sec":5,"speed_mult":2.0,"cooldown_sec":45}', 72)
ON CONFLICT (id) DO NOTHING;

-- CONSUMABLE – Per-use items (price column, quantity based)
INSERT INTO shop_items (id, name, description, category, type, rarity, price, properties, is_consumable, max_stack, sort_order) VALUES
  ('consumable_revive',      'Diriliş',       'Ölünce %70 boyla yeniden doğ',  'consumable','revive',     'rare',   80,  '{"size_keep_ratio":0.7}',                 TRUE, 5, 80),
  ('consumable_gold_boost',  '2× Altın',      'Bu maçta 2 kat altın kazan',    'consumable','gold_boost', 'common', 40,  '{"multiplier":2.0}',                      TRUE, 5, 81)
ON CONFLICT (id) DO NOTHING;
