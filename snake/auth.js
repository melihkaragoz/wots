'use strict';

// ── Auth, Profile, Shop, Match Rewards UI ───────────────────────────────
const Auth = (() => {
  let currentUser  = null;
  let authToken    = localStorage.getItem('snakeToken') || null;
  let shopItems    = [];
  let userInventory = [];
  let equippedSlots = {};
  let currentShopTab = 'all';

  // ── API helpers ────────────────────────────────────────────────────────
  async function apiGet(url) {
    const headers = {};
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || r.statusText);
    }
    return r.json();
  }

  async function apiPost(url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }

  // ── Auth ───────────────────────────────────────────────────────────────
  async function init() {
    if (!authToken) { updateHeader(); return; }
    try {
      currentUser = await apiGet('/api/auth/me');
      updateHeader();
    } catch {
      authToken = null; currentUser = null;
      localStorage.removeItem('snakeToken');
      updateHeader();
    }
  }

  function updateHeader() {
    const userEl  = document.getElementById('user-info');
    const guestEl = document.getElementById('guest-info');
    if (!userEl || !guestEl) return;

    if (currentUser) {
      userEl.classList.remove('hidden');
      guestEl.classList.add('hidden');
      document.getElementById('header-name').textContent = currentUser.username;
      document.getElementById('header-gold').textContent = currentUser.gold ?? 0;
    } else {
      userEl.classList.add('hidden');
      guestEl.classList.remove('hidden');
    }
  }

  // ── Separate login/register modals ─────────────────────────────────────
  function openLoginModal() {
    UI.closeModal();
    const el = document.getElementById('login-modal');
    document.getElementById('login-error').classList.add('hidden');
    el.classList.remove('hidden');
  }

  function openRegisterModal() {
    UI.closeModal();
    const el = document.getElementById('register-modal');
    document.getElementById('register-error').classList.add('hidden');
    el.classList.remove('hidden');
  }

  function showError(id, msg) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
  }

  function setLoading(btnSelector, loading) {
    const btn = document.querySelector(btnSelector);
    if (!btn) return;
    if (loading) {
      btn._origText = btn.textContent;
      btn.textContent = 'Yükleniyor…';
      btn.disabled = true;
    } else {
      btn.textContent = btn._origText || btn.textContent;
      btn.disabled = false;
    }
  }

  async function submitLogin() {
    const email = document.getElementById('auth-email').value.trim();
    const pass  = document.getElementById('auth-pass').value;
    if (!email || !pass) return showError('login-error', 'E-posta ve şifre gerekli');
    setLoading('#login-modal .btn-primary', true);
    try {
      const data = await apiPost('/api/auth/login', { email, password: pass });
      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('snakeToken', authToken);
      updateHeader();
      reconnectSocket();
      UI.closeModal();
      prefillNick();
    } catch (e) { showError('login-error', e.message); }
    finally { setLoading('#login-modal .btn-primary', false); }
  }

  async function submitRegister() {
    const username = document.getElementById('reg-username').value.trim();
    const email    = document.getElementById('reg-email').value.trim();
    const pass     = document.getElementById('reg-pass').value;
    if (!username || !email || !pass) return showError('register-error', 'Tüm alanlar gerekli');
    setLoading('#register-modal .btn-primary', true);
    try {
      const data = await apiPost('/api/auth/register', { username, email, password: pass });
      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('snakeToken', authToken);
      updateHeader();
      reconnectSocket();
      UI.closeModal();
      prefillNick();
    } catch (e) { showError('register-error', e.message); }
    finally { setLoading('#register-modal .btn-primary', false); }
  }

  function prefillNick() {
    if (!currentUser?.username) return;
    const nickEl = document.getElementById('nick');
    if (nickEl && !nickEl.value) {
      nickEl.value = currentUser.username;
      nickEl.dispatchEvent(new Event('input'));
    }
  }

  function logout() {
    authToken = null; currentUser = null;
    localStorage.removeItem('snakeToken');
    updateHeader();
    reconnectSocket();
  }

  function reconnectSocket() {
    if (typeof socket === 'undefined') return;
    socket.auth = authToken ? { token: authToken } : {};
    socket.disconnect().connect();
  }

  function isLoggedIn() { return !!currentUser; }
  function getUsername() { return currentUser?.username || ''; }
  function setGold(n) {
    if (currentUser) currentUser.gold = n;
    const el = document.getElementById('header-gold');
    if (el) el.textContent = n;
  }

  // ── Profile ────────────────────────────────────────────────────────────
  async function openProfile() {
    if (!currentUser) return openLoginModal();
    document.getElementById('profile-content').innerHTML = '<div style="text-align:center;padding:20px;color:#888">Yükleniyor…</div>';
    document.getElementById('profile-modal').classList.remove('hidden');
    try {
      const data = await apiGet('/api/auth/me');
      currentUser = data;
      updateHeader();
      const el = document.getElementById('profile-content');
      el.innerHTML = `
        <div style="margin-bottom:10px">
          <span style="font-size:1.1rem;font-weight:700;color:#a29bfe">${esc(data.username)}</span>
          <span class="gold-badge" style="margin-left:8px">${data.gold ?? 0}</span>
        </div>
        <div class="profile-stats">
          <div class="stat-card"><div class="stat-val">${data.games_played ?? 0}</div><div class="stat-lbl">Oyun</div></div>
          <div class="stat-card"><div class="stat-val">${data.total_kills ?? 0}</div><div class="stat-lbl">Toplam Kill</div></div>
          <div class="stat-card"><div class="stat-val">${data.max_size ?? 0}</div><div class="stat-lbl">Maks Boy</div></div>
          <div class="stat-card"><div class="stat-val">${formatSec(data.total_seconds ?? 0)}</div><div class="stat-lbl">Toplam Süre</div></div>
        </div>
        <h3 style="font-size:.85rem;color:#888;margin:12px 0 6px">Donatılmış</h3>
        <div id="profile-equipped" style="font-size:.8rem;color:#aaa">${renderEquipped(data.equipped)}</div>
      `;
    } catch (e) { console.error('Profile error:', e); UI.closeModal(); }
  }

  function renderEquipped(slots) {
    if (!slots || !Object.values(slots).some(v => v)) return '<em>Hiçbir şey donatılmamış</em>';
    return Object.entries(slots).filter(([,v]) => v).map(([slot, itemId]) =>
      `<span style="display:inline-block;background:#1a1a3a;padding:3px 8px;border-radius:5px;margin:2px">${slot}: #${itemId}</span>`
    ).join(' ');
  }

  function formatSec(s) {
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'dk';
    return Math.floor(s / 3600) + 'sa ' + Math.floor((s % 3600) / 60) + 'dk';
  }

  // ── Shop ───────────────────────────────────────────────────────────────
  async function openShop() {
    if (!currentUser) return openLoginModal();
    document.getElementById('shop-tabs').innerHTML = '';
    document.getElementById('shop-grid').innerHTML = '<div style="text-align:center;padding:30px;color:#888;grid-column:1/-1">Yükleniyor…</div>';
    document.getElementById('shop-modal').classList.remove('hidden');
    try {
      const [items, inv, me] = await Promise.all([
        apiGet('/api/shop'),
        apiGet('/api/shop/inventory'),
        apiGet('/api/auth/me'),
      ]);
      shopItems = items;
      userInventory = inv;
      equippedSlots = me.equipped || {};
      currentUser = me;
      updateHeader();

      updateShopGold();
      renderShopTabs();
      renderShopGrid('all');
    } catch (e) { console.error('Shop error:', e); UI.closeModal(); }
  }

  const SHOP_CATEGORIES = {
    all: 'Tümü',
    appearance: 'Görünüm',
    upgrade: 'Yükseltme',
    active: 'Aktif',
    consumable: 'Sarf',
    inventory: 'Envanterim',
  };

  function renderShopTabs() {
    const el = document.getElementById('shop-tabs');
    el.innerHTML = Object.entries(SHOP_CATEGORIES).map(([key, label]) =>
      `<button class="shop-tab${key === currentShopTab ? ' active' : ''}" onclick="Auth.filterShop('${key}')">${label}</button>`
    ).join('');
  }

  function updateShopGold() {
    const el = document.getElementById('shop-gold');
    if (el && currentUser) el.textContent = currentUser.gold ?? 0;
  }

  function filterShop(cat) {
    currentShopTab = cat;
    renderShopTabs();
    renderShopGrid(cat);
  }

  function renderShopGrid(cat) {
    const grid = document.getElementById('shop-grid');
    const ownedIds = new Set(userInventory.map(i => i.item_id));
    const equippedIds = new Set(Object.values(equippedSlots).filter(Boolean));

    let items;
    if (cat === 'inventory') {
      items = shopItems.filter(i => ownedIds.has(i.id));
    } else if (cat === 'all') {
      items = shopItems;
    } else {
      items = shopItems.filter(i => i.category === cat);
    }

    if (!items.length) {
      grid.innerHTML = '<div style="color:#555;text-align:center;padding:30px;grid-column:1/-1">Bu kategoride ürün yok</div>';
      return;
    }

    grid.innerHTML = items.map(item => {
      const owned    = ownedIds.has(item.id);
      const equipped = equippedIds.has(item.id);
      const inv      = userInventory.find(i => i.item_id === item.id);
      const rarity   = item.rarity || 'common';

      let priceHtml = '';
      let actionHtml = '';

      if (item.duration_tiers && item.duration_tiers.length) {
        const selectId = 'dur-' + item.id;
        priceHtml = `<select class="shop-duration-select" id="${selectId}">
          ${item.duration_tiers.map(t => `<option value="${t.hours}">${t.hours}sa — ${t.price} altın</option>`).join('')}
        </select>`;
        if (owned && !item.is_consumable) {
          actionHtml = equipped
            ? `<button class="shop-btn shop-btn-unequip" onclick="Auth.unequipItem('${item.id}')">Çıkar</button>`
            : `<button class="shop-btn shop-btn-equip" onclick="Auth.equipItem('${item.id}')">Donat</button>`;
          actionHtml += `<button class="shop-btn shop-btn-buy" style="margin-top:4px" onclick="Auth.buyItem('${item.id}','${selectId}')">Süre Uzat</button>`;
        } else {
          actionHtml = `<button class="shop-btn shop-btn-buy" onclick="Auth.buyItem('${item.id}','${selectId}')">Satın Al</button>`;
        }
      } else if (owned && !item.is_consumable) {
        actionHtml = equipped
          ? `<button class="shop-btn shop-btn-unequip" onclick="Auth.unequipItem('${item.id}')">Çıkar</button>`
          : `<button class="shop-btn shop-btn-equip" onclick="Auth.equipItem('${item.id}')">Donat</button>`;
      } else if (owned && item.is_consumable) {
        priceHtml = `<span class="shop-price">${item.price} altın</span>`;
        actionHtml = `<button class="shop-btn shop-btn-buy" onclick="Auth.buyItem('${item.id}')">Satın Al (${inv?.quantity || 0}/${item.max_stack})</button>`;
      } else {
        priceHtml = `<span class="shop-price">${item.price} altın</span>`;
        actionHtml = `<button class="shop-btn shop-btn-buy" onclick="Auth.buyItem('${item.id}')">Satın Al</button>`;
      }

      return `
        <div class="shop-card${owned ? ' owned' : ''}${equipped ? ' equipped' : ''}">
          ${equipped ? '<span class="equipped-badge">DONATILDI</span>' : ''}
          <span class="rarity-badge rarity-${rarity}">${rarity}</span>
          <div class="shop-card-name">${esc(item.name)}</div>
          <div class="shop-card-desc">${esc(item.description || '')}</div>
          ${priceHtml}
          ${actionHtml}
        </div>
      `;
    }).join('');
  }

  async function buyItem(itemId, selectId) {
    try {
      const body = { item_id: itemId };
      if (selectId) {
        const sel = document.getElementById(selectId);
        if (sel) body.duration_hours = parseInt(sel.value);
      }
      const data = await apiPost('/api/shop/buy', body);
      setGold(data.new_gold);
      updateShopGold();
      userInventory = await apiGet('/api/shop/inventory');
      renderShopGrid(currentShopTab);
      showToast('Satın alındı!', '#2ed573');
    } catch (e) {
      showToast(e.message, '#e84040');
    }
  }

  async function equipItem(itemId) {
    try {
      const data = await apiPost('/api/shop/equip', { item_id: itemId });
      equippedSlots[data.slot] = itemId;
      renderShopGrid(currentShopTab);
      reconnectSocket();
    } catch (e) { showToast(e.message, '#e84040'); }
  }

  async function unequipItem(itemId) {
    const slot = Object.entries(equippedSlots).find(([, v]) => v === itemId)?.[0];
    if (!slot) return;
    try {
      await apiPost('/api/shop/unequip', { slot });
      equippedSlots[slot] = null;
      renderShopGrid(currentShopTab);
      reconnectSocket();
    } catch (e) { showToast(e.message, '#e84040'); }
  }

  // ── Match rewards ──────────────────────────────────────────────────────
  async function claimMatchRewards(stats) {
    if (!currentUser || !authToken) return null;
    try {
      const result = await apiPost('/api/match/end', stats);
      setGold(result.new_total_gold);
      return result;
    } catch (e) {
      console.warn('Match reward claim failed:', e.message);
      return null;
    }
  }

  function renderRewardsBox(el, result) {
    if (!result) { el.innerHTML = ''; return; }
    let html = '';
    html += `<div class="reward-gold-row">💰 Kazanılan altın: <strong>+${result.gold_earned}</strong></div>`;
    if (result.bonus_gold > 0) {
      html += `<div class="reward-gold-row">🎁 Bonus altın: <strong>+${result.bonus_gold}</strong></div>`;
    }
    if (result.rewards && result.rewards.length) {
      for (const r of result.rewards) {
        if (r.type === 'gold') {
          html += `<div class="reward-gold-row">🏆 ${esc(r.reason)}: <strong>+${r.amount} altın</strong></div>`;
        } else {
          html += `<div class="reward-item-row">🎁 ${esc(r.reason)}: ${esc(r.item_name || 'Item #' + r.item_id)}${r.duration_hours ? ` (${r.duration_hours}sa)` : ''}</div>`;
        }
      }
    }
    html += `<div style="color:#888;font-size:.8rem;margin-top:6px">Toplam altın: <strong style="color:#ffd700">${result.new_total_gold}</strong></div>`;
    el.innerHTML = html;
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function showToast(msg, color) {
    const old = document.getElementById('sw-err-toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.id = 'sw-err-toast';
    toast.style.cssText = `position:fixed;top:20px;left:50%;transform:translateX(-50%);background:${color || '#e84040'};color:#fff;padding:10px 22px;border-radius:8px;z-index:9999;font-size:.9rem`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ── Public API ─────────────────────────────────────────────────────────
  return {
    init,
    updateHeader,
    openLoginModal,
    openRegisterModal,
    submitLogin,
    submitRegister,
    logout,
    reconnectSocket,
    isLoggedIn,
    getUsername,
    setGold,
    openProfile,
    openShop,
    filterShop,
    buyItem,
    equipItem,
    unequipItem,
    claimMatchRewards,
    renderRewardsBox,
  };
})();
