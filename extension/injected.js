// injected.js — runs in the PAGE's own JS context (not the isolated content-script world).
//
// Hook sequence:
//   1. Trap window.Phaser via Object.defineProperty — fires the instant the
//      Phaser library is assigned to window.
//   2. Wrap Phaser.Game with a Proxy construct trap — fires the instant
//      new Phaser.Game(config) is called, giving us the live game instance.
//   3. Start seven 100 ms pollers (energy, coin balances, inventory slots,
//      skill levels, camera, entity count, map limits) — each tracks its own
//      previous value and only calls handleStateUpdate when something actually
//      changed (Voxels diff-on-change pattern).

(function () {
  'use strict';

  const TAG = '[Pixels Companion]';

  // ---------------------------------------------------------------------------
  // Auth token capture — installed before startPolling() so the first
  // authenticated game REST call is intercepted automatically.
  //
  // _origFetch is kept as a module-level reference so our own price-fetching
  // calls can bypass the wrapper and avoid looping back through it.
  //
  // The game sends MULTIPLE distinct Authorization tokens to different services:
  //   • pixels-server.pixels.xyz  — a non-JWT session token (random alphanumeric)
  //   • api.stacked.xyz           — a real JWT ("eyJ…") whose sub = MongoDB player _id
  // ---------------------------------------------------------------------------
  let _capturedAuthHeader   = null; // first auth token seen (any type)
  let _capturedSessionToken = null; // first non-JWT session token — for pixels-server calls
  let _capturedJwt          = null; // first JWT-shaped token (starts with "eyJ") — for Stacked
  const _seenAuthTokens     = new Map(); // token_prefix → url (diagnostic only)
  const _origFetch = window.fetch;


  // Must match BACKEND_URL in content.js.
  const _BACKEND_URL = 'https://content-hq-production.up.railway.app';

  function _recordAuthToken(auth, url) {
    if (!auth) return;
    const prefix = auth.replace(/^Bearer\s+/i, '').slice(0, 8);
    if (!_seenAuthTokens.has(prefix)) {
      _seenAuthTokens.set(prefix, url);
      if (window.PX_COMPANION_DEBUG) {
        const raw = auth.replace(/^Bearer\s+/i, '');
        console.log(TAG, '[auth] new token seen:', {
          preview: auth.slice(0, 28) + '…',
          isJwt: raw.startsWith('eyJ'),
          url: typeof url === 'string' ? url.replace(/\?.*$/, '') : String(url),
        });
      }
    }
    if (!_capturedAuthHeader) _capturedAuthHeader = auth;
    const rawToken = auth.replace(/^Bearer\s+/i, '');
    if (!_capturedJwt && rawToken.startsWith('eyJ')) _capturedJwt = auth;
    // Track non-JWT session token separately (pixels-server uses random alphanumeric).
    if (!_capturedSessionToken && !rawToken.startsWith('eyJ')) _capturedSessionToken = auth;
  }

  (function installAuthInterceptors() {
    // fetch wrapper — captures Authorization header from any game REST call
    window.fetch = function(resource, options) {
      const _urlStr = typeof resource === 'string' ? resource
                    : (resource instanceof Request ? resource.url : String(resource));
      try {
        const h = options?.headers;
        if (h) {
          const auth =
            (h instanceof Headers
              ? (h.get('Authorization') ?? h.get('authorization'))
              : (h['Authorization'] ?? h['authorization'])) ?? null;
          _recordAuthToken(auth, resource);
        }
      } catch (_) {}

      return _origFetch.apply(this, arguments);
    };

    // XHR fallback — covers legacy or third-party game code not using fetch.
    // XMLHttpRequest carries no URL at setRequestHeader time, so we read
    // this._companionUrl written by our open() shim below.
    const _origOpen      = XMLHttpRequest.prototype.open;
    const _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function(method, url) {
      this._companionUrl = url;
      return _origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      if (name.toLowerCase() === 'authorization') {
        _recordAuthToken(value, this._companionUrl ?? '(XHR unknown url)');
      }
      return _origSetHeader.apply(this, arguments);
    };
  })();

  /** Returns the first captured token (any shape) — used for pixels-server calls. */
  function getSessionToken() {
    return _capturedAuthHeader;
  }

  /** Returns the best token for pixels-server.pixels.xyz: non-JWT session token preferred. */
  function getPixelsToken() {
    return _capturedSessionToken ?? _capturedAuthHeader;
  }

  /** Decodes the first JWT-shaped token seen (sub claim = MongoDB player _id). */
  function getPlayerIdFromToken() {
    const jwt = _capturedJwt;
    if (!jwt) return null;
    try {
      const raw = jwt.replace(/^Bearer\s+/i, '').split('.')[1];
      const decoded = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
      return decoded.sub ?? decoded.id ?? decoded._id ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Stable local player ID — generated once and persisted in localStorage so
  // the same browser/profile always gets the same ID across page reloads and
  // extension restarts.  Does not require auth token capture.
  // ---------------------------------------------------------------------------
  const _localPlayerId = (() => {
    const KEY = 'pixels-companion-player-id';
    try {
      let id = localStorage.getItem(KEY);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(KEY, id);
      }
      return id;
    } catch (_) {
      return crypto.randomUUID(); // fallback if localStorage is blocked
    }
  })();

  // ---------------------------------------------------------------------------
  // Central output function — logs to console and notifies the companion UI
  // for event types the UI cares about (ready-to-deliver, level-up, etc.).
  // ---------------------------------------------------------------------------
  function handleStateUpdate(type, data) {
    console.log(`${TAG} ${type}:`, data);
    saveToCompanion('companionEvent', { type, data });
  }

  // ---------------------------------------------------------------------------
  // Persistence bridge.
  // injected.js runs in the page context and cannot call chrome.storage
  // directly.  postMessage passes the payload to content.js, which has
  // extension-context access and handles the actual storage write.
  // ---------------------------------------------------------------------------
  function saveToCompanion(category, data) {
    window.postMessage({ source: 'pixels-companion', category, data }, '*');
  }

  // ---------------------------------------------------------------------------
  // Slot helpers — used by the inventory poller.
  // Defined at module level since they don't close over anything in startPolling.
  // ---------------------------------------------------------------------------

  // Stable string key for one inventory slot: item identity + quantity + state.
  // item may be an object with .id, a plain string, or a number — handle all.
  function slotKey(slot) {
    const itemId = slot?.item?.id ?? slot?.item ?? null;
    return `${JSON.stringify(itemId)}|${slot?.quantity ?? 0}|${slot?.state ?? ''}`;
  }

  // Human-readable label for one slot: "itemId ×quantity"
  function slotLabel(slot) {
    return `${slot?.item?.id ?? slot?.item ?? '?'} \xd7${slot?.quantity ?? 0}`;
  }

  // ---------------------------------------------------------------------------
  // React-fiber panel reader — used by the UI panel pollers below.
  // ---------------------------------------------------------------------------

  // Tracks elements that have been logged for a missing fiber key so we only
  // log once per element instance, not every 200 ms.
  const _fiberMissingLogged = new WeakSet();

  // Find the React fiber attached to a DOM element and return its memoizedProps.
  //
  // Returns null in two cases:
  //   • selector not matched — panel is closed; expected, no log.
  //   • fiber key missing on a matched element — unexpected; logged once per
  //     element instance via _fiberMissingLogged so it can't spam.
  function readFiberPanel(selector, label) {
    const el = document.querySelector(selector);
    if (!el) return null; // panel not open — silent, this is the common case

    const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    if (!fiberKey) {
      if (!_fiberMissingLogged.has(el)) {
        console.log(TAG, `${label}: element found but no __reactFiber$ key`, el);
        _fiberMissingLogged.add(el);
      }
      return null;
    }

    return el[fiberKey]?.memoizedProps ?? null;
  }

  // ---------------------------------------------------------------------------
  // Display name capture — reads the profile name chip in the game HUD.
  // Best-effort / cosmetic only: the element is transient (only present while
  // hovering a player character) and cannot distinguish self from other players.
  // Never use this as a lookup key — use ctx.playerId for that.
  // Live format: "Lizzylizzy | PALS" — strip guild tag, return bare username.
  // ---------------------------------------------------------------------------
  function captureDisplayName() {
    const el = document.querySelector('[class*="profile_value"]');
    if (!el) return null;
    const raw = el.textContent || '';
    return raw.split('|')[0].trim() || null;
  }

  // ---------------------------------------------------------------------------
  // Panel extraction helpers — pure DOM reads, no side effects.
  // ---------------------------------------------------------------------------

  // Taskboard/Store: extract every item card from the items-content container.
  function extractTaskboardItems(container) {
    return [...container.querySelectorAll('.Store_store-item-container__yxJbY')].map(card => {
      const itemName       = card.querySelector('.Store_card-title__InPpB')?.textContent.trim()    ?? '';
      const tier           = card.querySelector('.Store_card-tier__KvnJ1')?.textContent.trim()     ?? '';
      const qtyRaw         = card.querySelector('.Store_item-quantity__cFhDE')?.textContent.trim() ?? '';
      const quantityNeeded = parseInt(qtyRaw.replace(/^[x×]/i, ''), 10) || 0;
      const costs          = [...card.querySelectorAll('.commons_coinCost__CbysW')].map(el => el.textContent.trim());
      // isVipLocked: class name contains "vip" anywhere on the card wrapper.
      const isVipLocked    = [...card.classList].some(c => c.toLowerCase().includes('vip'));
      // canDeliverNow: find the DELIVER button; absent or disabled → false.
      const deliverBtn     = [...card.querySelectorAll('button')].find(b => /deliver/i.test(b.textContent));
      const canDeliverNow  = deliverBtn != null && !deliverBtn.hasAttribute('disabled');
      // Physical item rewards (e.g. yieldstone box) — best-effort via aria-label on reward icons.
      const rewardItems    = [...card.querySelectorAll('[class*="reward"] img[aria-label], [class*="Reward"] img[aria-label]')]
        .map(el => el.getAttribute('aria-label'))
        .filter(Boolean);
      return { itemName, tier, quantityNeeded, costs, rewardItems, isVipLocked, canDeliverNow };
    });
  }

  // Stacked/Offers: extract every offer accordion from the offers-list container.
  // timerText is returned in the payload but intentionally excluded from the diff
  // key — it's a live countdown that would trigger handleStateUpdate every tick.
  function extractOffers(container) {
    return [...container.querySelectorAll('.Offers_offerAccordionContainer__GrkuL')].map(offer => {
      const requirementText = offer.querySelector('.Offers_requirementText__7HIkP')?.textContent.trim()    ?? '';
      const timerText       = offer.querySelector('.Offers_timerText__VAxWc')?.textContent.trim()          ?? '';
      const rewards         = [...offer.querySelectorAll('.Offers_rewardIconWrapper__MgOMO')]
                                .map(el => el.getAttribute('aria-label'))
                                .filter(Boolean);
      const description     = offer.querySelector('.Offers_accordionDescription__l_r2f')?.textContent.trim() ?? '';
      const claimBtn        = [...offer.querySelectorAll('button')].find(b => /claim/i.test(b.textContent));
      const eligible        = claimBtn != null && !claimBtn.hasAttribute('disabled');
      return { requirementText, timerText, rewards, description, eligible };
    });
  }

  // Crafting detail panel: extract one recipe from .Crafting_PageDetails__tYqnD.
  //
  // Confirmed selectors:  itemName (.Crafting_detailsTitle__bGjKU), panel root.
  // Unconfirmed selectors: tier, outputQuantity — use [class*="…"] wildcards;
  //   update to exact class once seen live.
  // Text-pattern fields:  craftTimeSeconds, energyCost, vipRequired, xpSkill,
  //   xpAmount — matched against panel.textContent; text is stable across builds.
  // requiredItems: walk every img in the panel, find nearest ancestor (≤4 levels)
  //   whose text contains an N/N ratio; main item image excluded automatically
  //   because it has no sibling N/N text.
  function extractCraftingRecipe(panel) {
    const itemName = panel.querySelector('.Crafting_detailsTitle__bGjKU')?.textContent.trim() ?? '';
    if (!itemName) return null; // panel present but not fully rendered yet

    // tier — small overlay on the item image; class name unconfirmed.
    const tierEl = panel.querySelector('[class*="tier"i]');
    const tier = tierEl?.textContent.trim() || null;

    // outputQuantity — confirmed selector; text is "x12"-style, strip leading x.
    const qtyEl = panel.querySelector('.ItemStyles_itemQuantity__5RwoA');
    const qtyRaw = qtyEl?.textContent.trim() ?? '';
    const outputQuantity = parseInt(qtyRaw.replace(/^[x×]/i, ''), 10) || 1;

    const panelText = panel.textContent;

    // craftTimeSeconds — parse HH:MM:SS → total seconds.
    const timeMatch = panelText.match(/\b(\d{1,2}):(\d{2}):(\d{2})\b/);
    const craftTimeSeconds = timeMatch
      ? parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseInt(timeMatch[3], 10)
      : null;

    // energyCost, vipRequired — "N Energy Required", optionally preceded by "VIP".
    const energyMatch = panelText.match(/(\d[\d,]*)\s+Energy\s+Required/i);
    const energyCost = energyMatch ? parseInt(energyMatch[1].replace(/,/g, ''), 10) : null;
    // Check for VIP in a 60-char window before the match so we're reading the
    // same requirement clause, not an unrelated mention of "VIP" elsewhere.
    const energyIdx = energyMatch ? panelText.indexOf(energyMatch[0]) : -1;
    const vipRequired = energyIdx >= 0
      ? /\bVIP\b/i.test(panelText.slice(Math.max(0, energyIdx - 60), energyIdx + energyMatch[0].length))
      : false;

    // xpSkill, xpAmount — "SkillName: +N,NNNXP"
    const xpMatch = panelText.match(/([A-Za-z][A-Za-z\s]*?):\s*\+([0-9,]+)\s*XP/i);
    const xpSkill  = xpMatch ? xpMatch[1].trim() : null;
    const xpAmount = xpMatch ? parseInt(xpMatch[2].replace(/,/g, ''), 10) : null;

    // requiredItems — confirmed quantity selector: .Crafting_craftingFontQuantities__FDoj9
    // Each quantity element (e.g. "11/24") is the anchor; we walk up one level
    // to the ingredient block and find the img inside it.
    const requiredItems = [];
    panel.querySelectorAll('.Crafting_craftingFontQuantities__FDoj9').forEach(qtyEl => {
      const m = qtyEl.textContent.trim().match(/(\d+)\s*\/\s*(\d+)/);
      if (!m) return;
      // The img should share a close parent with the quantity element.
      const block = qtyEl.parentElement;
      const img = block?.querySelector('img');
      requiredItems.push({
        itemImageUrl: img?.src ?? null,
        haveQuantity: parseInt(m[1], 10),
        needQuantity: parseInt(m[2], 10),
      });
    });

    // canCraftNow — the Create / Craft button is disabled when materials are short.
    const createBtn = [...panel.querySelectorAll('button')]
      .find(b => /create|craft/i.test(b.textContent));
    const canCraftNow = createBtn != null && !createBtn.hasAttribute('disabled');

    return {
      itemName, tier, outputQuantity, craftTimeSeconds,
      energyCost, vipRequired, xpSkill, xpAmount,
      requiredItems, canCraftNow,
      lastSeen: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Industry-state extraction — Step 2 reader / shaper / diff helpers.
  // ---------------------------------------------------------------------------

  // Convert a Colyseus ArraySchema of GGenericExecuteTracker to a plain object.
  // Numeric strings are coerced to numbers for cleaner downstream use.
  function trackersToRecord(trackers) {
    const result = {};
    if (!trackers || typeof trackers.forEach !== 'function') return result;
    trackers.forEach((tracker) => {
      if (!tracker?.name) return;
      const raw = tracker.value ?? '';
      const num = Number(raw);
      result[tracker.name] = raw !== '' && !isNaN(num) ? num : raw;
    });
    return result;
  }

  // Read room.state.entities and return only industry entities as raw extraction
  // records. Returns null when the state or game library is not yet available.
  function readIndustryState(room) {
    const entities = room?.state?.entities;
    if (!entities || typeof entities.forEach !== 'function') return null;

    const library = global.gameLibrary?.entities;
    if (!library) return null;

    const result = [];
    entities.forEach((mapEntity) => {
      if (!mapEntity?.entity) return;
      const lib = library[mapEntity.entity];
      if (!lib?.industry) return; // not an industry entity — skip

      const generic = mapEntity.generic;
      result.push({
        mid:              mapEntity.mid      ?? null,
        entityTypeId:     mapEntity.entity,
        industryCategory: lib.industry,
        state:            generic?.state     ?? null,
        utcRefresh:       generic?.utcRefresh ?? null,
        utcTarget:        generic?.displayInfo?.utcTarget ?? null,
        trackers:         trackersToRecord(generic?.trackers),
      });
    });
    return result;
  }

  // Read GMapPermissions from room.state.mapPermissions.
  // Returns a plain object or null if permissions aren't in the room state.
  function readMapPermissions(room) {
    const perms = room?.state?.mapPermissions;
    if (!perms) return null;

    const use = [];
    if (typeof perms.use?.forEach === 'function') {
      perms.use.forEach((role) => { if (role) use.push(role); });
    }

    const useByIndustry = {};
    if (typeof perms.useByIndustry?.forEach === 'function') {
      perms.useByIndustry.forEach((access, industry) => {
        const roles = [];
        if (typeof access?.roles?.forEach === 'function') {
          access.roles.forEach((r) => { if (r) roles.push(r); });
        }
        useByIndustry[industry] = roles;
      });
    }

    return { use, useByIndustry };
  }

  // Shape extraction records into the canonical land snapshot object.
  function shapeLandSnapshot(mapId, industries, permissions) {
    return {
      landId:      mapId,
      observedAt:  Date.now(),
      permissions: permissions ?? { use: [], useByIndustry: {} },
      industries:  industries  ?? [],
    };
  }

  // Stable diff key: excludes observedAt so an unchanged state doesn't
  // trigger a spurious save.  utcRefresh IS included — a finished entity
  // (null → timestamp or vice-versa) is a real change worth persisting.
  function landSnapshotKey(snapshot) {
    return JSON.stringify({
      landId:      snapshot.landId,
      permissions: snapshot.permissions,
      industries:  snapshot.industries,
    });
  }

  // ---------------------------------------------------------------------------
  // Action-detection helpers — used by the room.send wrapper below.
  // ---------------------------------------------------------------------------

  // Snapshot the three state slices we diff after each room.send call.
  // Inventory is aggregated by item id so moving items between slots doesn't
  // false-positive.  All fields default to null/empty if not yet available.
  function takeSnapshot(selfPlayer) {
    const energy = selfPlayer?.energy?.level ?? null;

    const inventory = {};
    selfPlayer?.inventory?.slots?.$items?.forEach(slot => {
      if (slot?.item == null) return;
      const id = slot.item?.id ?? slot.item;
      inventory[id] = (inventory[id] ?? 0) + (slot.quantity ?? 0);
    });

    const skills = {};
    if (typeof selfPlayer?.levels?.forEach === 'function') {
      selfPlayer.levels.forEach((entry, skillName) => {
        if (entry?.totalExp !== undefined) skills[skillName] = entry.totalExp;
      });
    }

    return { energy, inventory, skills };
  }

  // Diff two snapshots and return an array of human-readable change strings.
  // Returns [] if nothing changed (caller skips the log in that case).
  function diffSnapshots(before, after) {
    const changes = [];

    // Energy delta.
    if (before.energy !== null && after.energy !== null && before.energy !== after.energy) {
      const d = after.energy - before.energy;
      changes.push(`${d > 0 ? '+' : ''}${d} energy`);
    }

    // Skill XP deltas.
    Object.entries(after.skills).forEach(([skill, afterXp]) => {
      const beforeXp = before.skills[skill] ?? afterXp;
      if (afterXp !== beforeXp) {
        changes.push(`+${afterXp - beforeXp} ${skill} XP`);
      }
    });

    // Inventory deltas.
    const allItems = new Set([...Object.keys(before.inventory), ...Object.keys(after.inventory)]);
    allItems.forEach(item => {
      const d = (after.inventory[item] ?? 0) - (before.inventory[item] ?? 0);
      if (d !== 0) changes.push(`${d > 0 ? '+' : ''}${d} ${item}`);
    });

    return changes;
  }

  // ---------------------------------------------------------------------------
  // Panel cache timer helpers — used by the taskboard/stacked pollers.
  // ---------------------------------------------------------------------------

  // Parse a timer text string ("1h 23m 45s", "23:45", "1:23:45") into milliseconds.
  function parseTimerMs(text) {
    if (!text) return null;
    const t = text.trim();
    const colonMatch = t.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (colonMatch) {
      const a = parseInt(colonMatch[1], 10);
      const b = parseInt(colonMatch[2], 10);
      const c = colonMatch[3] !== undefined ? parseInt(colonMatch[3], 10) : null;
      return c !== null
        ? (a * 3600 + b * 60 + c) * 1000
        : (a * 60 + b) * 1000;
    }
    let ms = 0;
    const hMatch = t.match(/(\d+)\s*h/i);
    const mMatch = t.match(/(\d+)\s*m(?!s)/i);
    const sMatch = t.match(/(\d+)\s*s\b/i);
    if (hMatch) ms += parseInt(hMatch[1], 10) * 3_600_000;
    if (mMatch) ms += parseInt(mMatch[1], 10) *    60_000;
    if (sMatch) ms += parseInt(sMatch[1], 10) *     1_000;
    return ms > 0 ? ms : null;
  }

  // Returns the ms timestamp of the next 00:00:00 UTC.
  function nextUtcMidnight() {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  }

  // Replace room.send with a wrapper that snapshots state before calling through,
  // then diffs 500 ms later when the server has had time to push its response.
  // args[0] is the Colyseus action name string — included in the log for context.
  function wrapRoomSend(room, getScene, onStorageOpen) {
    const _originalSend = room.send.bind(room);

    room.send = function (...args) {
      // Detect storage-open actions to track which chest mid is being opened.
      const _act = typeof args[0] === 'string' ? args[0] : '';
      if (/storage|chest|container/i.test(_act) && onStorageOpen) {
        try {
          const _p = (args[1] != null && typeof args[1] === 'object') ? args[1] : {};
          const _mid = _p.mid ?? _p.entityMid ?? _p.entity ?? _p.id ?? null;
          onStorageOpen(_act, _mid != null ? String(_mid) : null, _p);
        } catch (_) {}
      }

      const selfPlayer = getScene()?.stateManager?.selfPlayer;
      const before = selfPlayer ? takeSnapshot(selfPlayer) : null;

      // Call through unchanged — no alteration of args or timing.
      _originalSend(...args);

      if (!before) return;

      setTimeout(() => {
        try {
          const sp = getScene()?.stateManager?.selfPlayer;
          if (!sp) return;
          const changes = diffSnapshots(before, takeSnapshot(sp));
          if (changes.length === 0) return;
          const actionLabel = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0] ?? '?');
          console.log(`${TAG} action detected (${actionLabel}):`, changes.join(', '));
        } catch (_) {}
      }, 500);
    };
  }

  // ---------------------------------------------------------------------------
  // Phaser.Game constructor Proxy
  // ---------------------------------------------------------------------------
  function hookPhaserGame(Phaser) {
    console.log(TAG, 'Phaser detected — version:', Phaser?.VERSION);

    Phaser.Game = new Proxy(Phaser.Game, {
      construct(target, args) {
        const instance = Reflect.construct(target, args);
        console.log(TAG, 'Phaser.Game instance captured.');
        startPolling(instance);
        return instance;
      },
    });
  }

  // ---------------------------------------------------------------------------
  // window.Phaser trap
  // Locks permanently on first fire so a subsequent write (e.g. a framework
  // stub being replaced by the real library) can't silently displace our hook.
  // ---------------------------------------------------------------------------
  if (window.Phaser) {
    hookPhaserGame(window.Phaser);
  } else {
    Object.defineProperty(window, 'Phaser', {
      configurable: true,
      set(value) {
        Object.defineProperty(window, 'Phaser', { value });
        hookPhaserGame(value);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Pollers — started once the Phaser.Game instance is captured.
  // scene[1] is the confirmed gameplay scene for Pixels Online.
  // ---------------------------------------------------------------------------
  function startPolling(game) {
    console.log(TAG, 'Polling started.');

    function getScene() {
      return game.scene.scenes[1];
    }

    // ---- Panel cache — in-memory mirror + storage bridge --------------------
    // Populated from chrome.storage.local on first MongoDB playerId read.
    // Updated whenever a panel is live-scanned from DOM.
    // Served back to ctx when panels are closed so stale data isn't lost.
    let _taskboardCache = null; // {items, capturedAt, expiresAt} | null
    let _stackedCache   = null; // {offers, capturedAt} | null  (each offer has expiresAt)
    let _cacheRequested = false;

    // ---- Extension-side marketplace price cache ------------------------------
    let _libItems          = null; // { itemId: {...} } — cached game library (no names)
    let _libItemsExpiresAt = 0;    // ms expiry for _libItems (1-hour TTL)
    let _nameMap           = null; // { displayName.toLowerCase(): itemId } — from i18n endpoint
    let _nameMapExpiresAt  = 0;    // ms expiry for _nameMap (1-hour TTL)
    let _mpCache           = {};   // { itemId: {lowestPrice, quantity, fetchedAt} }
    const _MP_TTL          = 10 * 60_000;  // 10 min per price entry
    const _LIB_TTL         = 60 * 60_000;  // 1 hour for game library / locale map

    // _findItemId: looks up a display name in the locale-sourced name map.
    // Pass 1 — exact case-insensitive.
    // Pass 2 — normalized (strip non-alphanumeric, ≥3 chars).
    // Pass 3 — full token overlap (all needle tokens ≥2 chars present in display name).
    function _findItemId(name) {
      if (!_nameMap) return null;
      const needle = name.toLowerCase().trim();
      // Pass 1: exact
      if (_nameMap[needle] !== undefined) return _nameMap[needle];
      // Pass 2: normalized
      const norm = needle.replace(/[^a-z0-9]/g, '');
      if (norm.length >= 3) {
        for (const [k, id] of Object.entries(_nameMap)) {
          if (k.replace(/[^a-z0-9]/g, '') === norm) return id;
        }
      }
      // Pass 3: token overlap
      const nTokens = needle.split(/\s+/).filter(t => t.length >= 2);
      if (nTokens.length >= 2) {
        for (const [k, id] of Object.entries(_nameMap)) {
          const kSet = new Set(k.split(/\s+/).filter(t => t.length >= 2));
          if (nTokens.every(t => kSet.has(t))) return id;
        }
      }
      // Pass 4: prefix match — unique start-of-name match only.
      // "gravelglass" → "Gravelglass Matrix", "clayum" → "Clayum Matrix".
      const pTokens = needle.split(/\s+/).filter(t => t.length >= 1);
      if (pTokens.length >= 1) {
        const prefixMatches = [];
        for (const [k, id] of Object.entries(_nameMap)) {
          const kTokens = k.split(/\s+/);
          if (pTokens.length <= kTokens.length && pTokens.every((t, i) => kTokens[i] === t)) {
            prefixMatches.push(id);
          }
        }
        if (prefixMatches.length === 1) return prefixMatches[0];
        if (prefixMatches.length > 1) {
          console.log(TAG, '[market] _findItemId: ambiguous prefix match for', name,
            '—', prefixMatches.length, 'candidates');
        }
      }
      return null;
    }

    function _parseMarketBody(body) {
      if (!body || typeof body !== 'object') return null;
      // Live shape (recorded 17 Sept):
      // { listings: [...], ownerUsernames, myOffers, recentSales,
      //   stats: { minPrice, avgPrice, maxPrice, volume, currency } }
      if (body.stats && typeof body.stats === 'object') {
        const stats    = body.stats;
        const listings = Array.isArray(body.listings) ? body.listings : [];
        const qty      = listings.reduce((s, l) => s + (typeof l.quantity === 'number' ? l.quantity : 0), 0);
        if (typeof stats.minPrice === 'number' && stats.minPrice > 0) {
          return { lowestPrice: stats.minPrice, quantity: qty || (typeof stats.volume === 'number' ? stats.volume : 0) };
        }
      }
      // Legacy shape A — top-level aggregated stats (older API versions).
      if (typeof body.minPrice === 'number' && body.minPrice > 0) {
        const vol = typeof body.totalVolume === 'number' ? body.totalVolume
                  : typeof body.volume      === 'number' ? body.volume : 0;
        return { lowestPrice: body.minPrice, quantity: vol };
      }
      // Legacy shape B — bare listings array.
      const raw = Array.isArray(body.listings) ? body.listings
                : Array.isArray(body.data)     ? body.data
                : Array.isArray(body.items)    ? body.items : null;
      if (raw && raw.length > 0) {
        const valid = raw
          .filter(l => typeof l.price === 'number' && l.price > 0)
          .sort((a, b) => a.price - b.price);
        if (valid.length > 0) {
          const totalQty = valid.reduce((s, l) => s + (typeof l.quantity === 'number' ? l.quantity : 1), 0);
          return { lowestPrice: valid[0].price, quantity: totalQty };
        }
      }
      return null;
    }

    async function _fetchLibItems() {
      const now = Date.now();
      const libCacheHit  = _libItems  && _libItemsExpiresAt  > now;
      const nameCacheHit = _nameMap   && _nameMapExpiresAt   > now;

      if (libCacheHit && nameCacheHit) {
        console.log(TAG, '[market] _fetchLibItems: full cache hit,',
          Object.keys(_libItems).length, 'items,', Object.keys(_nameMap).length, 'names');
        return _libItems;
      }

      const libUrl  = `https://pixels-server.pixels.xyz/v1/game/library?tenant=pixels&ver=10.5&v=${now}`;
      const nameUrl = `https://pixels-server.pixels.xyz/v1/i18n/game/en?tenant=pixels`;

      const fetches = [];
      if (!libCacheHit)  fetches.push({ key: 'lib',  url: libUrl });
      if (!nameCacheHit) fetches.push({ key: 'name', url: nameUrl });

      console.log(TAG, '[market] _fetchLibItems: fetching', fetches.map(f => f.key).join(', '));

      let rawI18n = null;

      await Promise.all(fetches.map(async ({ key, url }) => {
        try {
          const res = await _origFetch(url, { headers: { Accept: 'application/json' } });
          if (!res.ok) { console.log(TAG, '[market] _fetchLibItems:', key, 'non-ok', res.status); return; }
          const body = await res.json();
          if (key === 'lib') {
            const map = (body && typeof body === 'object')
              ? (body.items && typeof body.items === 'object' ? body.items : body)
              : null;
            if (map) {
              _libItems = map;
              _libItemsExpiresAt = Date.now() + _LIB_TTL;
              console.log(TAG, '[market] _fetchLibItems: cached', Object.keys(map).length, 'lib items');
            }
          } else {
            if (body && typeof body === 'object' && !Array.isArray(body)) {
              rawI18n = body;
            }
          }
        } catch (err) {
          console.log(TAG, '[market] _fetchLibItems:', key, 'exception', String(err));
        }
      }));

      // Build _nameMap after both fetches complete so _libItems is available for validation.
      // i18n keys are translation keys like "itm_clay_name" — NOT bare item IDs.
      // 682+ display names map to multiple keys (stale IDs + ach_ recipe keys).
      // Algorithm: group by display name → keep only itm_ IDs that exist in _libItems
      // → sort alphabetically → use first (lowest-numbered is canonical).
      // ach_ IDs are intentionally ignored (they are recipe/achievement keys, not item IDs).
      if (rawI18n && !nameCacheHit) {
        const allItems = _libItems ?? {};
        const allEntities = (typeof _libItems === 'object' && _libItems !== null &&
          '_entities' in _libItems) ? _libItems._entities : {};
        const libraryAvailable = Object.keys(allItems).length > 0;

        console.log(TAG, '[market] _fetchLibItems: i18n sample raw keys:', Object.keys(rawI18n).slice(0, 5).join(', '));

        // Step 1+2: group _name keys by display name → candidate IDs.
        const nameToIds = new Map();
        for (const [k, displayName] of Object.entries(rawI18n)) {
          if (typeof displayName !== 'string') continue;
          if (!k.endsWith('_name')) continue;
          const id = k.slice(0, -5);
          if (!nameToIds.has(displayName)) nameToIds.set(displayName, []);
          nameToIds.get(displayName).push(id);
        }

        // Step 3: validate and deduplicate.
        const reverse = {};
        let ambiguous = 0;
        let dropped = 0;

        for (const [displayName, ids] of nameToIds) {
          const rawItemIds = ids.filter(id => id.startsWith('itm_'));
          const validItemIds = libraryAvailable
            ? rawItemIds.filter(id => allItems[id] !== undefined)
            : rawItemIds;

          if (validItemIds.length > 0) {
            validItemIds.sort();
            if (validItemIds.length > 1) {
              ambiguous++;
              console.log(TAG, '[market] ambiguous:', displayName, '→', validItemIds.join(', '), '— using', validItemIds[0]);
            } else if (rawItemIds.length > validItemIds.length) {
              dropped += rawItemIds.length - validItemIds.length;
            }
            reverse[displayName.toLowerCase().trim()] = validItemIds[0];
          }

          // ent_ IDs validated against allEntities (fall back to accepting all if unavailable).
          const entIds = ids.filter(id => id.startsWith('ent_'));
          const validEntIds = Object.keys(allEntities).length > 0
            ? entIds.filter(id => allEntities[id] !== undefined)
            : entIds;
          for (const entId of validEntIds) {
            reverse[displayName.toLowerCase().trim()] = entId;
          }
          // ach_ IDs intentionally ignored — they are recipe/achievement keys, not item IDs.
        }

        _nameMap = reverse;
        _nameMapExpiresAt = Date.now() + _LIB_TTL;
        console.log(TAG, '[market] _fetchLibItems: cached', Object.keys(reverse).length,
          'validated names (' + ambiguous + ' disambiguated, ' + dropped + ' stale dropped)',
          'from', Object.keys(rawI18n).length, 'raw keys');
        const samples = Object.entries(reverse).slice(0, 3).map(([n, id]) => `"${n}"→${id}`).join(', ');
        console.log(TAG, '[market] _fetchLibItems: name→id samples:', samples);
      }

      return _libItems;
    }

    async function _fetchMpPrice(itemId, playerId) {
      const now = Date.now();
      const cached = _mpCache[itemId];
      if (cached && (now - cached.fetchedAt) < _MP_TTL) {
        console.log(TAG, '[market] _fetchMpPrice: cache hit for', itemId, '→', cached.lowestPrice, 'coins');
        return cached;
      }
      const token = getPixelsToken();
      const url = `https://pixels-server.pixels.xyz/v1/marketplace/item/${encodeURIComponent(itemId)}?pid=${encodeURIComponent(playerId)}`;
      console.log(TAG, '[market] _fetchMpPrice: fetching', url, '| token present:', !!token);
      const headers = { Accept: 'application/json' };
      if (token) headers['Authorization'] = token;
      try {
        const res = await _origFetch(url, { headers });
        console.log(TAG, '[market] _fetchMpPrice:', itemId, 'status=' + res.status);
        if (!res.ok) {
          console.log(TAG, '[market] _fetchMpPrice:', itemId, 'non-ok, returning null');
          return null;
        }
        const body = await res.json();
        const result = _parseMarketBody(body);
        console.log(TAG, '[market] _fetchMpPrice:', itemId,
          result ? ('→ lowestPrice=' + result.lowestPrice + ' qty=' + result.quantity)
                 : ('parse failed — raw: ' + JSON.stringify(body).slice(0, 500)));
        if (result) _mpCache[itemId] = { ...result, fetchedAt: now };
        return result;
      } catch (err) {
        console.log(TAG, '[market] _fetchMpPrice:', itemId, 'exception', String(err));
        return null;
      }
    }

    // Fire-and-forget POST of a single item's price to the backend.
    // listings must already have {id, price, qty, purchasedQty, createdAt} — no ownerId.
    function _postPriceToBackend(itemId, minPrice, avgPrice, volume, listings) {
      try {
        const payload = JSON.stringify({
          items: [{ itemId, minPrice, avgPrice, volume: volume ?? 0, listings: listings ?? [] }],
        });
        _origFetch(`${_BACKEND_URL}/api/market/prices`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body:    payload,
        }).then(r => {
          if (r.ok) r.json().then(d => console.log(TAG, '[market] backend POST:', itemId, '→ accepted=' + d.accepted));
          else console.log(TAG, '[market] backend POST non-ok:', r.status, 'for', itemId);
        }).catch(err => console.log(TAG, '[market] backend POST exception:', String(err)));
      } catch (err) {
        console.log(TAG, '[market] _postPriceToBackend exception:', String(err));
      }
    }

    // Fetches full listing data for one item.
    // Returns lowestPrice, quantity (total available), avgPrice, volume, and
    // a per-listing array with purchasedQty + createdAt for server-side demand tracking.
    // No ownerId or ownerUsername is retained.
    async function _fetchMpPriceFull(itemId, pid) {
      const now    = Date.now();
      const cached = _mpCache[itemId];
      if (cached && (now - cached.fetchedAt) < _MP_TTL) {
        return {
          lowestPrice: cached.lowestPrice,
          quantity:    cached.quantity,
          avgPrice:    cached.avgPrice ?? cached.lowestPrice,
          volume:      cached.volume   ?? cached.quantity,
          listings:    cached.listings ?? [],
        };
      }
      const token = getPixelsToken();
      const url   = `https://pixels-server.pixels.xyz/v1/marketplace/item/${encodeURIComponent(itemId)}?pid=${encodeURIComponent(pid)}`;
      const hdrs  = { Accept: 'application/json' };
      if (token) hdrs['Authorization'] = token;
      try {
        const res = await _origFetch(url, { headers: hdrs });
        console.log(TAG, '[market] _fetchMpPriceFull:', itemId, 'status=' + res.status);
        if (!res.ok) return null;
        const body = await res.json();

        const parsed = _parseMarketBody(body);
        if (!parsed) return null;

        // avgPrice from stats if available, else fall back to lowestPrice.
        const stats    = (body.stats && typeof body.stats === 'object') ? body.stats : {};
        const avgPrice = typeof stats.avgPrice     === 'number' ? stats.avgPrice
                       : typeof stats.averagePrice === 'number' ? stats.averagePrice
                       : typeof stats.avg          === 'number' ? stats.avg
                       : parsed.lowestPrice;
        const volume   = typeof stats.volume       === 'number' ? stats.volume
                       : typeof stats.totalVolume  === 'number' ? stats.totalVolume
                       : (parsed.quantity ?? 0);

        // Extract per-listing purchasedQty + createdAt for demand tracking.
        // Privacy: we strip ownerId / ownerUsername — only send _id, price, qty.
        const rawListings = Array.isArray(body.listings) ? body.listings : [];
        const listings = rawListings
          .filter(l => l._id != null && typeof l.price === 'number' && l.price > 0)
          .map(l => ({
            id:           String(l._id),
            price:        l.price,
            qty:          typeof l.quantity === 'number' ? l.quantity : 1,
            purchasedQty: typeof l.purchasedQuantity === 'number' ? l.purchasedQuantity : 0,
            createdAt:    typeof l.createdAt === 'number' ? l.createdAt
                        : typeof l.createdAt === 'string' ? new Date(l.createdAt).getTime()
                        : 0,
          }));

        _mpCache[itemId] = { lowestPrice: parsed.lowestPrice, quantity: parsed.quantity,
                             avgPrice, volume, listings, fetchedAt: now };
        return { lowestPrice: parsed.lowestPrice, quantity: parsed.quantity, avgPrice, volume, listings };
      } catch (err) {
        console.log(TAG, '[market] _fetchMpPriceFull exception:', itemId, String(err));
        return null;
      }
    }

    // Tracks the capturedAt of the taskboard snapshot for which prices were last
    // refreshed, so we only re-fetch when the snapshot actually changes.
    let _pricesRefreshedForCapturedAt = 0;

    async function _refreshTaskboardPrices(calledFrom) {
      const items = ctx.taskboard;
      const pid   = ctx.playerId;
      console.log(TAG, '[market] _refreshTaskboardPrices triggered from:', calledFrom,
        '| items:', items ? items.length : 0,
        '| playerId:', pid || '(none)');
      if (!items || items.length === 0) { console.log(TAG, '[market] aborting — no taskboard items'); return; }
      if (!pid) { console.log(TAG, '[market] aborting — playerId not set yet'); return; }

      const capturedAt = ctx.taskboardCapturedAt ?? 0;
      if (capturedAt && capturedAt === _pricesRefreshedForCapturedAt) {
        console.log(TAG, '[market] skip — already refreshed for capturedAt=' + capturedAt);
        return;
      }

      const names = [...new Set(items.map(i => i.itemName))];
      console.log(TAG, '[market] item names to resolve (' + names.length + '):', names.join(', '));

      const lib = await _fetchLibItems();
      console.log(TAG, '[market] lib available:', !!lib, lib ? Object.keys(lib).length + ' entries' : '');

      await Promise.all(names.map(async name => {
        const itemId = _findItemId(name);
        if (!itemId) {
          console.log(TAG, '[market] name→id: "' + name + '" → NO MATCH');
          return;
        }
        console.log(TAG, '[market] name→id: "' + name + '" → ' + itemId);
        // Enrich matching taskboard items with their resolved itemId so the backend
        // can look them up in the player's inventory and storage chests.
        items.forEach(item => { if (item.itemName === name && !item.itemId) item.itemId = itemId; });
        const listing = await _fetchMpPriceFull(itemId, pid);
        if (listing) {
          ctx.marketPrices[itemId] = { lowestPrice: listing.lowestPrice, quantity: listing.quantity };
          console.log(TAG, '[market] price stored: "' + name + '" (' + itemId + ') lowestPrice=' + listing.lowestPrice + ' qty=' + listing.quantity);
          _postPriceToBackend(itemId, listing.lowestPrice, listing.avgPrice, listing.volume, listing.listings);
        } else {
          console.log(TAG, '[market] price fetch returned null for "' + name + '" (' + itemId + ')');
        }
      }));

      _pricesRefreshedForCapturedAt = capturedAt;
      console.log(TAG, '[market] done. marketPrices keys:', Object.keys(ctx.marketPrices));
    }

    // ---- Background market price collector ------------------------------------
    // Starts ~30 s after playerId + auth token are first available.
    // Priority order comes from GET /api/market/priority-items (sorted by
    // recipe-usage count DESC so high-demand ingredients are fetched first).
    // Throttle: 1 marketplace request per 2 s, max 50 per browser session.
    // Items updated within the last 6 h are skipped (isStale === false).
    // Taskboard items jump to the front of the queue when the board is opened.

    const _COLLECTOR_INTERVAL_MS = 2_000;
    const _MAX_SESSION_FETCHES   = 100;

    let _collectorScheduled     = false;
    let _collectorStarted       = false;
    let _sessionFetchCount      = 0;
    let _collectorQueue         = [];
    let _collectorTimer         = null;
    let _collectorInFlight      = false;
    let _collectorPaused        = false;   // true after 3 consecutive failures
    let _collectorConsecFails   = 0;       // consecutive failed fetches
    const _COLLECTOR_PAUSE_AFTER = 3;      // pause after this many consecutive failures
    const _STAPLE_RECHECK_MS    = 2 * 60 * 60 * 1000;  // re-check staples every 2 h
    let _stapleIds              = [];      // item IDs marked isStaple by priority-items

    async function _loadPriorityQueue() {
      try {
        const res = await _origFetch(`${_BACKEND_URL}/api/market/priority-items`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) { console.log(TAG, '[market] priority-items: non-ok', res.status); return []; }
        const body = await res.json();
        if (!Array.isArray(body.items)) return [];
        // Cache staple IDs for the 2-hour re-check timer
        _stapleIds = body.items
          .filter(it => it.isStaple && typeof it.itemId === 'string')
          .map(it => it.itemId);
        const stale = body.items.filter(it => it.isStale && typeof it.itemId === 'string');
        console.log(TAG, '[market] priority-items:', body.total, 'total,', stale.length, 'stale,', _stapleIds.length, 'staples');
        return stale.map(it => it.itemId);
      } catch (err) {
        console.log(TAG, '[market] _loadPriorityQueue exception:', String(err));
        return [];
      }
    }

    // Prepend itemIds to the queue, removing duplicates (taskboard / staple re-check → front).
    function _enqueueFront(itemIds) {
      const frontSet = new Set(itemIds);
      _collectorQueue = [...itemIds, ..._collectorQueue.filter(id => !frontSet.has(id))];
    }

    // Re-enqueue stale staples and restart the collector timer if it stopped.
    async function _recheckStaples() {
      if (_collectorPaused) return;
      // Ask backend which staples are now stale (2 h threshold)
      try {
        const res = await _origFetch(`${_BACKEND_URL}/api/market/priority-items`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const body = await res.json();
        if (!Array.isArray(body.items)) return;
        const staleStaples = body.items
          .filter(it => it.isStaple && it.isStale && typeof it.itemId === 'string')
          .map(it => it.itemId);
        if (staleStaples.length === 0) return;
        _enqueueFront(staleStaples);
        if (!_collectorTimer) {
          _collectorTimer = setInterval(_processNextCollectorItem, _COLLECTOR_INTERVAL_MS);
        }
        console.log(TAG, '[market] staple re-check: enqueued', staleStaples.length, 'stale staples');
      } catch (err) {
        console.log(TAG, '[market] _recheckStaples exception:', String(err));
      }
    }

    function _processNextCollectorItem() {
      if (_collectorInFlight || _collectorPaused) return;

      if (_collectorQueue.length === 0 || _sessionFetchCount >= _MAX_SESSION_FETCHES) {
        clearInterval(_collectorTimer);
        _collectorTimer = null;
        if (_sessionFetchCount >= _MAX_SESSION_FETCHES) {
          console.log(TAG, '[market] collector idle (session limit reached)');
        } else {
          console.log(TAG, '[market] collector idle');
        }
        return;
      }

      const itemId = _collectorQueue.shift();
      const pid    = ctx.playerId;
      if (!pid) { _collectorQueue.unshift(itemId); return; }

      _collectorInFlight = true;
      _sessionFetchCount++;

      _fetchMpPriceFull(itemId, pid).then(listing => {
        if (listing) {
          _collectorConsecFails = 0; // reset on success
          ctx.marketPrices[itemId] = { lowestPrice: listing.lowestPrice, quantity: listing.quantity };
          console.log(TAG, '[market] collected', itemId,
            '→ min=' + listing.lowestPrice, 'avg=' + listing.avgPrice,
            'vol=' + listing.volume, 'listings=' + (listing.listings ? listing.listings.length : 0),
            '(' + _sessionFetchCount + '/' + _MAX_SESSION_FETCHES + ', ' + _collectorQueue.length + ' left)');
          _postPriceToBackend(itemId, listing.lowestPrice, listing.avgPrice, listing.volume, listing.listings);
        } else {
          _collectorConsecFails++;
          console.log(TAG, '[market] collected', itemId, '→ no listing (consec fails=' + _collectorConsecFails + ')');
          if (_collectorConsecFails >= _COLLECTOR_PAUSE_AFTER) {
            _collectorPaused = true;
            clearInterval(_collectorTimer);
            _collectorTimer = null;
            console.log(TAG, '[market] collector paused — requests failing (' + _collectorConsecFails + ' in a row)');
          }
        }
      }).catch(err => {
        _collectorConsecFails++;
        console.log(TAG, '[market] collector exception:', itemId, String(err),
          '(consec fails=' + _collectorConsecFails + ')');
        if (_collectorConsecFails >= _COLLECTOR_PAUSE_AFTER) {
          _collectorPaused = true;
          clearInterval(_collectorTimer);
          _collectorTimer = null;
          console.log(TAG, '[market] collector paused — requests failing (' + _collectorConsecFails + ' in a row)');
        }
      }).finally(() => {
        _collectorInFlight = false;
      });
    }

    async function _startBackgroundCollector() {
      if (_collectorStarted) return;
      _collectorStarted = true;

      const priorityIds = await _loadPriorityQueue();
      if (priorityIds.length === 0) {
        console.log(TAG, '[market] collector started (0 stale items — already up to date)');
      } else {
        const seen = new Set();
        _collectorQueue = priorityIds.filter(id => { if (seen.has(id)) return false; seen.add(id); return true; });
        console.log(TAG, '[market] collector started (' + _collectorQueue.length + ' items queued)');
        _collectorTimer = setInterval(_processNextCollectorItem, _COLLECTOR_INTERVAL_MS);
      }

      // Re-check staple prices every 2 h while the page is open
      setInterval(_recheckStaples, _STAPLE_RECHECK_MS);
    }

    // Listen for cache data posted back by content.js (requestPanelCache reply).
    window.addEventListener('message', event => {
      if (event.source !== window) return;
      if (!event.data || event.data.source !== 'pixels-companion-host') return;
      if (event.data.category === 'panelCache') {
        const d = event.data.data ?? {};
        if (d.taskboard) _taskboardCache = d.taskboard;
        if (d.stacked)   _stackedCache   = d.stacked;
        if (d.chestCaches && typeof d.chestCaches === 'object') {
          for (const [mid, entry] of Object.entries(d.chestCaches)) {
            _chestCache[mid] = entry;
          }
          if (Object.keys(d.chestCaches).length > 0) {
            ctx.storageChests = { ..._chestCache };
            console.log(TAG, '[storage] loaded chest caches:', Object.keys(d.chestCaches));
          }
        }
      }
    });

    // Best-effort search for the taskboard board-reset countdown.
    // Looks for a leaf element with EXACTLY "HH:MM:SS" text near the panel root.
    // Returns remaining ms or null (caller falls back to nextUtcMidnight()).
    function readTaskboardCountdownMs() {
      try {
        const storeEl = document.querySelector('.Store_items-content__FtMRE');
        if (!storeEl) return null;
        let root = storeEl.parentElement;
        for (let i = 0; i < 3 && root; i++, root = root.parentElement) {
          const all = root.querySelectorAll('*');
          for (const el of all) {
            if (storeEl.contains(el)) continue;
            const text = el.childElementCount === 0 ? el.textContent.trim() : '';
            if (!text) continue;
            const m = text.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
            if (m) {
              const ms = (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000;
              if (ms > 0 && ms < 90 * 3_600_000) return ms;
            }
          }
        }
      } catch (_) {}
      return null;
    }

    // ---- Live player context snapshot ----------------------------------------
    // Accumulates structured state from each poller so it can be forwarded to
    // the companion panel when the user sends a message.
    const ctx = {
      energy:        null,
      coins:         {},   // currencyId → balance
      inventory:     {},   // itemId → quantity
      skills:        {},   // skillName → {level, totalExp}
      walletAddress: null,
      playerX:       null, // world X coordinate — used to position floating sprite
      playerY:       null, // world Y coordinate
      isMoving:      false, // true when player moved since last sample
      facing:        'right', // 'left' | 'right' — last known walk direction
      taskboard:     [],   // live snapshot of visible taskboard order cards
      stackedOffers:      [],   // live snapshot of visible Stacked offers
      playerId:           _localPlayerId, // GPlayerCore.mid once loaded; UUID fallback until then
      playerDisplayName:  null,           // GPlayerCore.username (guild-tag suffix stripped)
      guildHandle:        null,           // GPlayerCore.guild.handle
      guildRole:          null,           // GPlayerCore.guild.role
      factionId:          null,           // GPlayerCore.faction raw number (1/2/3)
      faction:            null,           // human-readable: Wildgroves / Seedwrights / Reapers
      vipActive:          false,          // memberships.vip present and not expired
      vipTier:            null,           // memberships.vip.count (1–6), or null when inactive
      energyMax:          null,           // 1000 base + VIP_STACK_BONUS[vipTier]
      taskboardCapturedAt:    null,       // ms timestamp when taskboard was last read live
      taskboardExpiresAt:     null,       // ms timestamp when taskboard refreshes (UTC midnight or countdown)
      stackedOffersCapturedAt: null,      // ms timestamp when stacked offers were last read live
      marketPrices:           {},         // { itemId: {lowestPrice, quantity} } — extension-fetched
      storageChests:          {},         // { [chestMid]: { items, size, capturedAt } }
    };

    let displayNameCaptured = false;

    // Previous player coords and movement state for walking animation.
    let prevPlayerX = null;
    let prevPlayerY = null;
    let currentFacing = 'right';
    let lastMoveTime = 0; // Date.now() of last detected movement, for stop debounce

    // Push a snapshot whenever player position is known (not just when energy loads).
    setInterval(() => {
      if (ctx.energy !== null || Object.keys(ctx.skills).length > 0 || ctx.playerX !== null) {
        saveToCompanion('playerContext', { ...ctx });
      }
    }, 200);

    // ---- Player energy -------------------------------------------------------
    // selfPlayer's full shape is unknown until the first live read. We dump the
    // whole object once so we can identify the energy field name, then poll
    // selfPlayer.energy as the initial guess — update the single marked line
    // below once the shape dump reveals the real field name.
    // Faction id → human-readable name. Confirmed live: 1=Wildgroves, 2=Seedwrights, 3=Reapers.
    const FACTION_NAMES = { 1: 'Wildgroves', 2: 'Seedwrights', 3: 'Reapers' };

    // VIP stacking bonus on top of the 1000 base max energy.
    const BASE_ENERGY      = 1000;
    const VIP_STACK_BONUS  = { 1: 400, 2: 400, 3: 400, 4: 700, 5: 1200, 6: 2000 };

    let selfPlayerDumped     = false;
    let walletDumped         = false; // one-time log of cryptoWallets type/wallet/address
    let unknownFactionLogged = false;
    let vipLogged            = false; // one-time log of GPlayerCore.memberships shape
    let _lastSessionId       = null;  // detect map transitions (room.sessionId change)
    const _loggedRooms       = new Set(); // roomIds already diagnosed (one-time per room)
    let lastEnergy;

    // ---- Chest / storage cache -----------------------------------------------
    const _chestCache       = {};    // { [mid]: { items, size, capturedAt } }
    let _openingChestMid    = null;  // mid of most recently opened chest
    const _loggedMsgTypes   = new Set(); // one log per incoming room message type
    let _lastStorageHash    = '';    // diff guard for storage slot polling
    let _storageShapeLogged = false; // one-shot raw slot shape diagnostic

    // ---- Room diagnostic helpers (storage/chest discovery) ------------------

    function _logRoomDiagnostic(room, sessionId) {
      try {
        const state    = room.state;
        const stateKeys = state ? Object.keys(state) : [];

        console.log(TAG, '[room] NEW ROOM', {
          'room.name':   room.name,
          'room.roomId': room.roomId,
          sessionId,
          stateKeys,
        });

        // Log size of every MapSchema/ArraySchema in room.state.
        for (const key of stateKeys) {
          const val = state[key];
          if (!val || typeof val !== 'object') continue;
          if (typeof val.size === 'number') {
            console.log(TAG, `[room] state.${key}: MapSchema size=${val.size}`);
          } else if (Array.isArray(val)) {
            console.log(TAG, `[room] state.${key}: Array length=${val.length}`);
          }
        }

        // Search for storage-like entries.
        _searchStorageEntities(state, sessionId);
      } catch (e) {
        console.log(TAG, '[room] diagnostic error:', e);
      }
    }

    function _searchStorageEntities(state, sessionId) {
      const STORAGE_RE = /chest|storage|box|stash/i;
      const logged     = new Set(); // deduplicate by typeId

      // ── room.state.storage — top-level MapSchema (may be player inventory) ──
      if (state.storage && typeof state.storage.size === 'number') {
        console.log(TAG, '[room][storage] room.state.storage: MapSchema size=' + state.storage.size);
        let entryCount = 0;
        const doForEach = typeof state.storage.forEach === 'function'
          ? (cb) => state.storage.forEach(cb)
          : (cb) => { for (const [k, v] of Object.entries(state.storage)) cb(v, k); };
        doForEach((entry, key) => {
          if (entryCount >= 2) return;
          entryCount++;
          try {
            console.log(TAG, '[room][storage] room.state.storage entry key=' + key + ':', {
              keys:    Object.keys(entry),
              json:    JSON.stringify(entry).slice(0, 500),
            });
          } catch (_) {
            console.log(TAG, '[room][storage] room.state.storage entry key=' + key + ': (not serialisable)', typeof entry);
          }
        });
      } else {
        console.log(TAG, '[room][storage] room.state.storage: not present');
      }

      // ── room.state.entities — map entities placed on this map ───────────────
      if (state.entities && typeof state.entities.forEach === 'function') {
        state.entities.forEach((ent) => {
          const typeId  = String(ent.entity ?? ent.type ?? '');
          const typeKey = typeId.slice(0, 40);
          const hasStorage = ent.items || ent.inventory || ent.slots || ent.storage;
          if (!STORAGE_RE.test(typeId) && !hasStorage) return;
          if (logged.has('map:' + typeKey)) return;
          logged.add('map:' + typeKey);
          // typeof + raw value to diagnose why .storage may appear as undefined
          let rawStorageStr = '(none)';
          try { rawStorageStr = JSON.stringify(ent.storage).slice(0, 300); } catch (_) {}
          const desc = Object.getOwnPropertyDescriptor(ent, 'storage');
          console.log(TAG, '[room][storage] room.state.entities entry:', {
            typeId,
            mid:              ent.mid,
            keys:             Object.keys(ent),
            storageTypeof:    typeof ent.storage,
            storageRaw:       rawStorageStr,
            storageIsGetter:  desc ? (typeof desc.get === 'function') : 'no-own-desc',
            rawEntJson:       JSON.stringify(ent).slice(0, 500),
          });
        });
      }

      // ── room.state.players[sessionId].entities — player-placed entities ──────
      const playerRow = state.players
        ? (typeof state.players.get === 'function'
            ? state.players.get(sessionId)
            : state.players[sessionId])
        : null;
      const playerEntities = playerRow?.entities;
      if (playerEntities && typeof playerEntities.forEach === 'function') {
        playerEntities.forEach((ent) => {
          const typeId  = String(ent.entity ?? ent.type ?? '');
          const typeKey = typeId.slice(0, 40);
          const hasStorage = ent.items || ent.inventory || ent.slots || ent.storage;
          if (!STORAGE_RE.test(typeId) && !hasStorage) return;
          if (logged.has('playerEnt:' + typeKey)) return;
          logged.add('playerEnt:' + typeKey);
          const storageSummary = ent.storage
            ? {
                size:         ent.storage.size,
                transient:    ent.storage.transient,
                name:         ent.storage.name,
                slotsSize:    ent.storage.slots?.size ?? 0,
                slotsPreview: ent.storage.slots
                  ? JSON.stringify([...ent.storage.slots].slice(0, 3))
                  : undefined,
              }
            : undefined;
          console.log(TAG, '[room][storage] players[sessionId].entities entry:', {
            typeId,
            keys:    Object.keys(ent),
            storage: storageSummary,
          });
        });
        if (logged.size === 0) {
          console.log(TAG, '[room][storage] players[sessionId].entities: ' +
            playerEntities.size + ' entities, none match storage keywords or carry items field');
        }
      } else {
        console.log(TAG, '[room][storage] players[sessionId].entities: not present or not iterable');
      }
    }

    // Extract items from a storage/chest message and cache by mid.
    function _tryExtractChestItems(mid, message) {
      const rawSlots = message.slots ?? message.items ?? message.storage ?? message.inventory ?? null;
      if (!rawSlots) return false;
      const items = [];
      const processSlots = (slots) => {
        if (Array.isArray(slots)) {
          for (const s of slots) {
            const itemId = s?.item?.id ?? s?.itemId ?? s?.item ?? null;
            if (itemId === null || itemId === undefined) continue;
            const qty = typeof s?.quantity === 'number' ? s.quantity
                      : typeof s?.qty      === 'number' ? s.qty : 0;
            items.push({ itemId: String(itemId), qty });
          }
        } else if (slots && typeof slots === 'object') {
          for (const [k, s] of Object.entries(slots)) {
            const itemId = s?.item?.id ?? s?.itemId ?? s?.item ?? k ?? null;
            if (itemId === null || itemId === undefined) continue;
            const qty = typeof s?.quantity === 'number' ? s.quantity
                      : typeof s?.qty      === 'number' ? s.qty : 0;
            items.push({ itemId: String(itemId), qty });
          }
        }
      };
      processSlots(rawSlots);
      if (items.length === 0) return false;
      const entry = { items, size: message.size ?? items.length, capturedAt: Date.now() };
      _chestCache[mid] = entry;
      ctx.storageChests = { ..._chestCache };
      console.log(TAG, '[room][storage] chest cached from message', { mid, itemCount: items.length });
      saveToCompanion('chestCache', { mid, ...entry });
      return true;
    }

    setInterval(() => {
      try {
        const selfPlayer = getScene()?.stateManager?.selfPlayer;
        if (!selfPlayer) return;

        if (!selfPlayerDumped) {
          console.log(TAG, 'selfPlayer (one-time shape dump):', selfPlayer);
          selfPlayerDumped = true;
        }

        // ── Position + movement (always runs, not gated by energy) ────────────
        // stateManager.selfPlayer is the Colyseus game-state schema (energy, inventory, etc.)
        // and has no x/y/position fields. The camera follows the player, so its worldView
        // center IS the player's world position — use that instead.
        const _wv = getScene()?.cameras?.main?.worldView;
        if (_wv && _wv.width > 0) {
          ctx.playerX = _wv.x + _wv.width / 2;
          ctx.playerY = _wv.y + _wv.height / 2;
        }

        const dx = ctx.playerX !== null && prevPlayerX !== null ? ctx.playerX - prevPlayerX : 0;
        const dy = ctx.playerY !== null && prevPlayerY !== null ? ctx.playerY - prevPlayerY : 0;
        const moved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;
        const now = Date.now();

        if (moved) {
          if (Math.abs(dx) >= Math.abs(dy)) currentFacing = dx > 0 ? 'right' : 'left';
          lastMoveTime = now;
          if (!ctx.isMoving) {
            ctx.isMoving = true;
            if (window.PX_COMPANION_DEBUG) console.log(TAG, '[anim] started moving, facing:', currentFacing);
          }
        } else if (ctx.isMoving && (now - lastMoveTime) >= 150) {
          // 150 ms no-movement debounce before declaring stopped.
          ctx.isMoving = false;
          if (window.PX_COMPANION_DEBUG) console.log(TAG, '[anim] stopped moving');
        }
        ctx.facing = currentFacing;
        prevPlayerX = ctx.playerX;
        prevPlayerY = ctx.playerY;

        // ── Energy (non-gating — position/movement already updated above) ─────
        const energy = selfPlayer.energy?.level;
        if (energy === undefined) {
          console.log(TAG, 'energy.level undefined — raw selfPlayer.energy:', selfPlayer.energy);
          // Don't return — wallet address below still needs to run.
        } else {
          if (energy !== lastEnergy) {
            handleStateUpdate(
              'energy changed',
              lastEnergy !== undefined ? `${lastEnergy} → ${energy}` : `${energy} (initial)`
            );
            lastEnergy = energy;
          }
          ctx.energy = energy; // bare current value; energyMax is sent separately as ctx.energyMax
        }

        // Wallet address — cryptoWallets is a MapSchema directly on selfPlayer.
        // Prefer the Ronin entry: Pixels marketplace and Stacked both run on Ronin.
        if (!ctx.walletAddress) {
          const cw = selfPlayer?.cryptoWallets;
          if (cw && typeof cw.forEach === 'function') {
            let roninAddr = null, fallbackAddr = null;
            cw.forEach((w, key) => {
              if (!walletDumped) {
                console.log(TAG, '[Pixels Companion] cryptoWallets entry — key:', key,
                  'type:', w?.type, 'wallet:', w?.wallet, 'address:', w?.address);
              }
              const t    = (w?.type ?? '').toLowerCase();
              const addr = w?.address ?? w?.wallet ?? null;
              if (addr) {
                if (t === 'ronin' || t.includes('ron')) roninAddr = addr;
                else if (!fallbackAddr) fallbackAddr = addr;
              }
            });
            walletDumped = true;
            ctx.walletAddress = roninAddr ?? fallbackAddr ?? null;
          }
          // Fallback: try scalar or legacy paths.
          if (!ctx.walletAddress) {
            ctx.walletAddress = selfPlayer?.walletAddress
              ?? selfPlayer?.account?.walletAddress
              ?? selfPlayer?.userId
              ?? null;
          }
          if (!ctx.walletAddress && !ctx._walletShapeLogged) {
            console.log(TAG, 'walletAddress still null — selfPlayer top-level keys:', Object.keys(selfPlayer ?? {}));
            ctx._walletShapeLogged = true;
          }
        }

        // Guild, faction, username, mid — sourced from GPlayerCore.
        // Re-read on every tick; also re-reads naturally on map transitions (sessionId changes).
        const _room      = getScene()?.stateManager?.room;
        const _sessionId = _room?.sessionId ?? null;

        if (_sessionId && _sessionId !== _lastSessionId) {
          // Map transition — reset display-name capture so username is re-read from new entry.
          _lastSessionId    = _sessionId;
          displayNameCaptured = false;

          // Expose room + stateManager for DevTools inspection.
          window.__pxRoom  = _room;
          window.__pxState = getScene()?.stateManager;

          // One-time room diagnostic (state keys, MapSchema sizes, storage search).
          if (!_loggedRooms.has(_sessionId)) {
            _loggedRooms.add(_sessionId);
            _logRoomDiagnostic(_room, _sessionId);
          }
        }

        const _coreEntry = (_sessionId && _room?.state?.players)
          ? (typeof _room.state.players.get === 'function'
              ? _room.state.players.get(_sessionId)
              : _room.state.players[_sessionId])
          : null;

        if (_coreEntry) {
          // Player ID — use stable MongoDB account ID; UUID stays until mid is available.
          if (_coreEntry.mid) {
            ctx.playerId = _coreEntry.mid;
            // Load panel cache from storage once the real playerId is known.
            if (!_cacheRequested) {
              _cacheRequested = true;
              saveToCompanion('requestPanelCache', { playerId: _coreEntry.mid });
            }
            // Schedule background price collector 30 s after playerId + token are ready.
            if (!_collectorScheduled && getSessionToken()) {
              _collectorScheduled = true;
              console.log(TAG, '[market] collector scheduled in 30 s');
              setTimeout(() => _startBackgroundCollector().catch(() => {}), 30_000);
            }
          }

          // Display name — strip " | GuildTag" suffix if present.
          if (_coreEntry.username) {
            ctx.playerDisplayName = _coreEntry.username.split(' | ')[0].trim();
            displayNameCaptured   = true;
          }

          ctx.guildHandle = _coreEntry.guild?.handle ?? null;
          ctx.guildRole   = _coreEntry.guild?.role   ?? null;

          const rawFaction = _coreEntry.faction;
          if (!unknownFactionLogged) {
            console.log(TAG, '[Pixels Companion][faction] raw value:', rawFaction, 'typeof:', typeof rawFaction);
            unknownFactionLogged = true;
          }
          const factionNum = Number(rawFaction);
          ctx.factionId    = Number.isFinite(factionNum) && factionNum > 0 ? factionNum : null;
          if (ctx.factionId !== null) {
            ctx.faction = FACTION_NAMES[ctx.factionId] ?? null;
            if (!ctx.faction) {
              console.log(TAG, 'Unknown factionId:', ctx.factionId, '— add to FACTION_NAMES');
            }
          } else {
            ctx.faction = null;
          }

          // VIP — confirmed path: memberships.vip.count is the tier, expiration validated.
          const mem      = _coreEntry.memberships;
          const vipEntry = mem?.vip ?? (mem && typeof mem.get === 'function' ? mem.get('vip') : null);
          const vipActive = !!(vipEntry && Number(vipEntry.expiration) > Date.now());
          ctx.vipActive  = vipActive;
          if (vipActive) {
            const n = Number(vipEntry.count);
            ctx.vipTier = (Number.isFinite(n) && n > 0) ? Math.min(Math.max(Math.round(n), 1), 6) : null;
          } else {
            ctx.vipTier = null;
          }
          if (!vipLogged) {
            const em = BASE_ENERGY + (VIP_STACK_BONUS[Number(ctx.vipTier)] ?? 0);
            console.log(TAG, '[Pixels Companion][vip] vipActive:', ctx.vipActive,
              'vipTier:', ctx.vipTier, 'energyMax:', em);
            vipLogged = true;
          }
        }

        // energyMax = base 1000 + VIP stacking bonus. Defaults to 1000 when vipTier is unknown.
        ctx.energyMax = BASE_ENERGY + (VIP_STACK_BONUS[Number(ctx.vipTier)] ?? 0);

        // Display name fallback — DOM read if GPlayerCore entry not yet available.
        if (!displayNameCaptured) {
          const name = captureDisplayName();
          if (name) {
            ctx.playerDisplayName = name;
            displayNameCaptured = true;
            if (window.PX_COMPANION_DEBUG) console.log(TAG, '[displayName] DOM fallback captured:', ctx.playerDisplayName);
          }
        }
      } catch (_) {}
    }, 100);

    // ---- Camera position -----------------------------------------------------
    // Diff on rounded x,y so fractional sub-pixel movement doesn't spam output.
    let lastCamKey;

    setInterval(() => {
      try {
        const wv = getScene()?.cameras?.main?.worldView;
        if (!wv) return;

        const key = `${Math.round(wv.x)},${Math.round(wv.y)}`;
        if (key !== lastCamKey) {
          handleStateUpdate('camera moved', {
            x: Math.round(wv.x),
            y: Math.round(wv.y),
            width: wv.width,
            height: wv.height,
          });
          // Send raw camera frame data for the floating sprite coordinate conversion.
          // scrollX/scrollY = world coords of top-left viewport edge (= worldView.x/y).
          // worldWidth/Height = world units visible in the canvas (accounts for zoom).
          saveToCompanion('cameraFrame', {
            scrollX:     wv.x,
            scrollY:     wv.y,
            worldWidth:  wv.width,
            worldHeight: wv.height,
          });
          lastCamKey = key;
        }
      } catch (_) {}
    }, 100);

    // ---- Entity count --------------------------------------------------------
    // entities is a Map or plain object; normalise to a count either way.
    let lastEntityCount;

    setInterval(() => {
      try {
        const entities = getScene()?.entities;
        if (entities == null) return;

        const count = entities instanceof Map
          ? entities.size
          : Object.keys(entities).length;

        if (count !== lastEntityCount) {
          handleStateUpdate(
            'entity count changed',
            lastEntityCount !== undefined ? `${lastEntityCount} → ${count}` : `${count} (initial)`
          );
          lastEntityCount = count;
        }
      } catch (_) {}
    }, 100);

    // ---- Coin balances -------------------------------------------------------
    // coinInventory.$items is a Map; each value is {currencyId, balance}.
    // Diff each currency independently so a gold change and a Pixel change
    // in the same tick are both logged as separate events.
    let lastCoinSnapshot = null; // Map<currencyId, number>

    setInterval(() => {
      try {
        const items = getScene()?.stateManager?.selfPlayer?.coinInventory?.$items;
        if (!items) return;

        // Build current snapshot: currencyId → balance
        const current = new Map();
        items.forEach((entry) => {
          if (entry?.currencyId != null) current.set(entry.currencyId, entry.balance ?? 0);
        });
        if (current.size === 0) return;

        // Update ctx snapshot.
        current.forEach((balance, currencyId) => { ctx.coins[currencyId] = balance; });

        if (lastCoinSnapshot === null) {
          // First read — log initial balance for every currency held.
          current.forEach((balance, currencyId) => {
            handleStateUpdate('balance initial', `${currencyId} ${balance}`);
          });
          lastCoinSnapshot = current;
          return;
        }

        // Diff every currency id seen now and every id seen before.
        const allIds = new Set([...current.keys(), ...lastCoinSnapshot.keys()]);
        allIds.forEach((currencyId) => {
          const prev = lastCoinSnapshot.get(currencyId);
          const next = current.get(currencyId);
          if (prev !== next) {
            handleStateUpdate(
              'balance changed',
              `${currencyId} ${prev ?? '(new)'} → ${next ?? '(removed)'}`
            );
          }
        });
        lastCoinSnapshot = current;
      } catch (_) {}
    }, 100);

    // ---- Inventory slots -----------------------------------------------------
    // inventory.slots.$items is a Map of slot-number → {item, quantity, state}.
    // Each slot is serialised to a stable key string for cheap comparison; when
    // the key changes we report whether the slot was filled, changed, or cleared.
    let lastInventorySnapshot = null; // Map<slotNumber, string> — serialised key only

    setInterval(() => {
      try {
        const inventory = getScene()?.stateManager?.selfPlayer?.inventory;
        if (!inventory) return;
        const slotItems = inventory.slots?.$items;
        if (!slotItems) return;

        // Build snapshot of occupied slots only (skip null/empty entries).
        const current = new Map(); // slotNum → {key: string, slot: object}
        slotItems.forEach((slot, slotNum) => {
          if (slot?.item != null) current.set(slotNum, { key: slotKey(slot), slot });
        });

        // Update ctx inventory: aggregate quantity by item id across all slots.
        ctx.inventory = {};
        current.forEach(({ slot }) => {
          const id = slot?.item?.id ?? slot?.item;
          if (id != null) ctx.inventory[id] = (ctx.inventory[id] ?? 0) + (slot?.quantity ?? 0);
        });

        if (lastInventorySnapshot === null) {
          handleStateUpdate('inventory initial', `${current.size} occupied slots`);
          lastInventorySnapshot = new Map([...current].map(([k, v]) => [k, v.key]));
          return;
        }

        // Diff each slot that appeared in either snapshot.
        const allSlots = new Set([...current.keys(), ...lastInventorySnapshot.keys()]);
        allSlots.forEach((slotNum) => {
          const prevKey = lastInventorySnapshot.get(slotNum);
          const next    = current.get(slotNum);
          const nextKey = next?.key;

          if (!prevKey && nextKey) {
            handleStateUpdate('inventory slot filled',   `slot ${slotNum}: ${slotLabel(next.slot)}`);
          } else if (prevKey && !nextKey) {
            handleStateUpdate('inventory slot emptied', `slot ${slotNum} cleared`);
          } else if (prevKey !== nextKey) {
            handleStateUpdate('inventory slot changed',  `slot ${slotNum}: ${slotLabel(next.slot)}`);
          }
        });
        lastInventorySnapshot = new Map([...current].map(([k, v]) => [k, v.key]));
      } catch (_) {}
    }, 100);

    // ---- Skill levels --------------------------------------------------------
    // selfPlayer.levels is a Colyseus map-like collection; iterate with
    // .forEach((entry, skillName) => ...).  Each entry has .level (number) and
    // .totalExp (number), keyed by skill name (e.g. "woodwork", "mining").
    // Diff each skill independently so a woodwork XP gain and a mining
    // level-up in the same tick are logged as separate events.
    // If any entry is missing the expected fields, its raw shape is logged once
    // (tracked per-skill so new unexpected entries aren't suppressed).
    let lastLevelsSnapshot = null;       // Map<skillName, {level, totalExp}>
    const levelsShapeWarned = new Set(); // skills whose shape was already flagged

    setInterval(() => {
      try {
        const levels = getScene()?.stateManager?.selfPlayer?.levels;
        if (!levels || typeof levels.forEach !== 'function') return;

        // Build current snapshot.
        const current = new Map(); // skillName → {level, totalExp}
        levels.forEach((entry, skillName) => {
          if (entry == null) return;

          // Guard: if expected fields are absent, log the raw entry once.
          if (entry.level === undefined || entry.totalExp === undefined) {
            if (!levelsShapeWarned.has(skillName)) {
              console.log(TAG, `levels.${skillName} unexpected shape:`, entry);
              levelsShapeWarned.add(skillName);
            }
            return;
          }

          current.set(skillName, { level: entry.level, totalExp: entry.totalExp });
        });
        if (current.size === 0) return;

        // Update ctx skills snapshot.
        current.forEach(({ level, totalExp }, skillName) => {
          ctx.skills[skillName] = { level, totalExp };
        });

        if (lastLevelsSnapshot === null) {
          // First read — log every skill as initial state.
          current.forEach(({ level, totalExp }, skillName) => {
            handleStateUpdate('skill initial', `${skillName} level ${level} (${totalExp} XP)`);
          });
          lastLevelsSnapshot = current;
          return;
        }

        // Diff each skill: level and XP are independent events.
        current.forEach(({ level, totalExp }, skillName) => {
          const prev = lastLevelsSnapshot.get(skillName);
          if (!prev) {
            handleStateUpdate('skill initial', `${skillName} level ${level} (${totalExp} XP)`);
            return;
          }
          if (prev.level !== level) {
            handleStateUpdate('skill leveled up', `${skillName}: ${prev.level} → ${level}`);
          }
          if (prev.totalExp !== totalExp) {
            handleStateUpdate('skill XP', `${skillName}: ${prev.totalExp} → ${totalExp}`);
          }
        });
        lastLevelsSnapshot = current;
      } catch (_) {}
    }, 100);

    // ---- Map limits + map ID -------------------------------------------------
    // stateManager.mapLimits.$items: Map of limit-key → {max, used}.
    // Confirmed keys: producer, crafting, business, petcare, exploration, total.
    // stateManager.mapId: primitive that changes when the player changes maps.
    // When mapId changes we reset the limits snapshot so every limit is
    // re-reported as initial for the new map instead of being diffed against
    // the previous land's values.
    let lastMapId           = undefined;
    let lastMapLimitsSnapshot = null; // Map<string, {max: number, used: number}>

    setInterval(() => {
      try {
        const stateManager = getScene()?.stateManager;
        if (!stateManager) return;

        // mapId ----------------------------------------------------------------
        const mapId = stateManager.mapId;
        if (mapId !== undefined && mapId !== lastMapId) {
          handleStateUpdate('map changed', mapId);
          lastMapId = mapId;
          lastMapLimitsSnapshot = null; // re-report all limits for the new map
        }

        // mapLimits ------------------------------------------------------------
        const limitItems = stateManager.mapLimits?.$items;
        if (!limitItems) return;

        const current = new Map(); // limit-key → {max, used}
        limitItems.forEach((value, key) => {
          if (value != null) current.set(key, { max: value.max, used: value.used });
        });
        if (current.size === 0) return;

        if (lastMapLimitsSnapshot === null) {
          // First read for this map — log every limit as initial.
          current.forEach(({ max, used }, key) => {
            handleStateUpdate('map limit initial', `${key}: ${used}/${max}`);
          });
          lastMapLimitsSnapshot = current;
          return;
        }

        // Diff each limit key independently.
        current.forEach(({ max, used }, key) => {
          const prev = lastMapLimitsSnapshot.get(key);
          if (!prev || prev.used !== used || prev.max !== max) {
            const prevStr = prev ? `${prev.used}/${prev.max}` : '(new)';
            handleStateUpdate('map limit changed', `${key}: ${prevStr} → ${used}/${max}`);
          }
        });
        lastMapLimitsSnapshot = current;
      } catch (_) {}
    }, 100);

    // ---- Stacked / Offers panel — extraction + diff + cache -----------------
    // Polls .Offers_offersList__4asoP every 200 ms.
    // Keyed by requirementText. timerText is excluded from the diff key (live
    // countdown changes every second) but parsed into expiresAt per offer.
    // When the panel is closed the last live snapshot is served from _stackedCache,
    // filtering out any offer whose expiresAt has passed.
    function offerDiffKey(o) {
      return JSON.stringify({
        requirementText: o.requirementText,
        rewards:         o.rewards,
        description:     o.description,
        eligible:        o.eligible,
      });
    }
    let lastOffersSnapshot = null; // Map<requirementText, diffKey string>

    setInterval(() => {
      try {
        const container = document.querySelector('.Offers_offersList__4asoP');
        if (!container) {
          // Panel closed — serve cached snapshot, filtering out expired offers.
          if (_stackedCache) {
            const now = Date.now();
            ctx.stackedOffers = _stackedCache.offers.filter(
              o => o.expiresAt === null || o.expiresAt > now,
            );
            ctx.stackedOffersCapturedAt = _stackedCache.capturedAt;
          } else {
            ctx.stackedOffers = [];
            ctx.stackedOffersCapturedAt = null;
          }
          lastOffersSnapshot = null;
          return;
        }

        const fiberKey = Object.keys(container).find(k => k.startsWith('__reactFiber$'));
        if (!fiberKey) {
          if (!_fiberMissingLogged.has(container)) {
            console.log(TAG, 'Offers panel: element found but no __reactFiber$ key', container);
            _fiberMissingLogged.add(container);
          }
          return;
        }

        const capturedAt = Date.now();
        const rawOffers  = extractOffers(container);
        // Annotate each offer with expiresAt parsed from its live timerText.
        const offers = rawOffers.map(o => {
          const ms = parseTimerMs(o.timerText);
          return { ...o, expiresAt: ms !== null ? capturedAt + ms : null };
        });
        ctx.stackedOffers         = offers;
        ctx.stackedOffersCapturedAt = capturedAt;

        // Always keep in-memory cache up-to-date.
        _stackedCache = { offers, capturedAt };

        if (offers.length === 0) {
          lastOffersSnapshot = null;
          return;
        }

        if (lastOffersSnapshot === null) {
          offers.forEach(o => {
            handleStateUpdate('offer initial', o);
            // One-time timer diagnostic per offer.
            console.log(TAG, '[stacked] timerText:', JSON.stringify(o.timerText),
              '→ expiresAt:', o.expiresAt ? new Date(o.expiresAt).toISOString() : 'null (no timer)');
          });
          lastOffersSnapshot = new Map(offers.map(o => [o.requirementText, offerDiffKey(o)]));
          // Persist on first live read (real playerId required).
          if (_cacheRequested) {
            saveToCompanion('savePanelCache', { playerId: ctx.playerId, stacked: _stackedCache });
          }
          return;
        }

        const current = new Map(offers.map(o => [o.requirementText, { key: offerDiffKey(o), offer: o }]));
        let snapshotChanged = false;

        // New or changed offers.
        current.forEach(({ key, offer }, reqText) => {
          const prevKey = lastOffersSnapshot.get(reqText);
          if (!prevKey) {
            handleStateUpdate('offer appeared', offer);
            snapshotChanged = true;
          } else if (prevKey !== key) {
            handleStateUpdate(offer.eligible ? 'offer eligible' : 'offer changed', offer);
            snapshotChanged = true;
          }
        });

        // Removed offers — also fire reopen reminder so player knows new offers may be waiting.
        let anyRemoved = false;
        lastOffersSnapshot.forEach((_, reqText) => {
          if (!current.has(reqText)) {
            handleStateUpdate('offer removed', { requirementText: reqText });
            anyRemoved = true;
            snapshotChanged = true;
          }
        });

        if (anyRemoved) {
          saveToCompanion('companionEvent', { type: 'stacked_offer_claimed' });
        }

        if (snapshotChanged && _cacheRequested) {
          saveToCompanion('savePanelCache', { playerId: ctx.playerId, stacked: _stackedCache });
        }

        lastOffersSnapshot = new Map([...current].map(([k, v]) => [k, v.key]));
      } catch (_) {}
    }, 200);

    // ---- Taskboard / Store panel — extraction + diff + cache -----------------
    // Polls .Store_items-content__FtMRE every 200 ms.
    // Keyed by "itemName|quantityNeeded" — NOT tier, because tier starts as '' and fills
    // in within the same render cycle, which would produce false appeared/removed events.
    // canDeliverNow flip true → dedicated event type.
    // When the panel is closed the last live snapshot is served from _taskboardCache,
    // returning [] if taskboardExpiresAt has passed (board refreshed while away).
    function taskboardItemKey(item)  { return `${item.itemName}|${item.quantityNeeded}`; }
    function taskboardItemJson(item) { return JSON.stringify(item); }
    let lastTaskboardSnapshot = null; // Map<"itemName|tier", serialised JSON>

    setInterval(() => {
      try {
        const container = document.querySelector('.Store_items-content__FtMRE');
        if (!container) {
          // Panel closed — serve cached snapshot if present (empty if board expired).
          if (_taskboardCache) {
            const now = Date.now();
            const expired = _taskboardCache.expiresAt !== null && _taskboardCache.expiresAt <= now;
            ctx.taskboard           = expired ? [] : _taskboardCache.items;
            ctx.taskboardCapturedAt = _taskboardCache.capturedAt;
            ctx.taskboardExpiresAt  = _taskboardCache.expiresAt;
            // Fetch prices for the cached snapshot if not yet done for this version.
            if (!expired && _taskboardCache.capturedAt !== _pricesRefreshedForCapturedAt) {
              _refreshTaskboardPrices('cache-path').catch(() => {});
            }
          } else {
            ctx.taskboard           = [];
            ctx.taskboardCapturedAt = null;
            ctx.taskboardExpiresAt  = null;
          }
          lastTaskboardSnapshot = null;
          return;
        }

        const fiberKey = Object.keys(container).find(k => k.startsWith('__reactFiber$'));
        if (!fiberKey) {
          if (!_fiberMissingLogged.has(container)) {
            console.log(TAG, 'Store panel: element found but no __reactFiber$ key', container);
            _fiberMissingLogged.add(container);
          }
          return;
        }

        const capturedAt  = Date.now();
        const items       = extractTaskboardItems(container);
        // Read reset countdown from the panel; fall back to next UTC midnight.
        const countdownMs = readTaskboardCountdownMs();
        const expiresAt   = countdownMs !== null ? capturedAt + countdownMs : nextUtcMidnight();

        ctx.taskboard           = items;
        ctx.taskboardCapturedAt = capturedAt;
        ctx.taskboardExpiresAt  = expiresAt;

        // Always keep in-memory cache current.
        _taskboardCache = { items, capturedAt, expiresAt };

        if (items.length === 0) return;

        if (lastTaskboardSnapshot === null) {
          items.forEach(item => handleStateUpdate('taskboard initial', item));
          lastTaskboardSnapshot = new Map(items.map(item => [taskboardItemKey(item), taskboardItemJson(item)]));
          // Persist on first live read (real playerId required).
          if (_cacheRequested) {
            saveToCompanion('savePanelCache', { playerId: ctx.playerId, taskboard: _taskboardCache });
          }
          _refreshTaskboardPrices('initial-snapshot').catch(() => {});
          return;
        }

        const current = new Map(items.map(item => [
          taskboardItemKey(item),
          { json: taskboardItemJson(item), item },
        ]));

        let snapshotChanged = false;

        // New or changed items.
        current.forEach(({ json, item }, key) => {
          const prevJson = lastTaskboardSnapshot.get(key);
          if (!prevJson) {
            handleStateUpdate('taskboard item appeared', item);
            snapshotChanged = true;
          } else if (prevJson !== json) {
            const prev = JSON.parse(prevJson);
            if (!prev.canDeliverNow && item.canDeliverNow) {
              handleStateUpdate('taskboard ready to deliver', item);
            } else {
              handleStateUpdate('taskboard item changed', item);
            }
            snapshotChanged = true;
          }
        });

        // Removed items.
        lastTaskboardSnapshot.forEach((_, key) => {
          if (!current.has(key)) {
            const [itemName, tier] = key.split('|');
            handleStateUpdate('taskboard item removed', { itemName, tier });
            snapshotChanged = true;
          }
        });

        if (snapshotChanged && _cacheRequested) {
          saveToCompanion('savePanelCache', { playerId: ctx.playerId, taskboard: _taskboardCache });
        }
        if (snapshotChanged) {
          _refreshTaskboardPrices('snapshot-changed').catch(() => {});
        }

        lastTaskboardSnapshot = new Map([...current].map(([k, v]) => [k, v.json]));
      } catch (_) {}
    }, 200);

    // ---- Crafting detail panel — extraction + persist ------------------------
    // Polls .Crafting_PageDetails__tYqnD every 200 ms.
    // Diff key: itemName + canCraftNow + sum of haveQuantity values, so we fire
    // on both "new recipe selected" and "material quantity changed for same recipe".
    // Each change saves to storage, accumulating the recipe catalog over time.
    let lastCraftingKey = null;

    setInterval(() => {
      try {
        const panel = document.querySelector('.Crafting_PageDetails__tYqnD');
        if (!panel) return; // panel not open, silent

        const fiberKey = Object.keys(panel).find(k => k.startsWith('__reactFiber$'));
        if (!fiberKey) {
          if (!_fiberMissingLogged.has(panel)) {
            console.log(TAG, 'Crafting panel: element found but no __reactFiber$ key', panel);
            _fiberMissingLogged.add(panel);
          }
          return;
        }

        const recipe = extractCraftingRecipe(panel);
        if (!recipe) return;

        const haveSum = recipe.requiredItems.reduce((s, r) => s + r.haveQuantity, 0);
        const diffKey = `${recipe.itemName}|${recipe.canCraftNow}|${haveSum}`;
        if (diffKey === lastCraftingKey) return;

        handleStateUpdate('recipe viewed', recipe);
        saveToCompanion('recipe', recipe);
        lastCraftingKey = diffKey;
      } catch (_) {}
    }, 200);

    // ---- React fiber: Merchant Boat panel ------------------------------------
    // Selector targets the subheader element of the Merchant Boat store.
    let merchantFiberDumped = false;

    setInterval(() => {
      try {
        const props = readFiberPanel(
          '#__next > div > div.room-layout > div > div.commons_modalBackdrop__EOPaN > div > div.MerchantBoatStore_subheader__1vjBk',
          'Merchant Boat panel'
        );
        if (!props || merchantFiberDumped) return;
        console.log(TAG, 'Merchant Boat panel fiber props (shape dump):', props);
        merchantFiberDumped = true;
      } catch (_) {}
    }, 200);

    // ---- room.send wrapper — one-shot setup ---------------------------------
    // stateManager.room is established asynchronously after game init, so we
    // poll for it rather than reading at startPolling time.  Once found, we
    // wrap it once and clear the interval so no further overhead is incurred.
    let roomWrapped = false;
    const roomDetectInterval = setInterval(() => {
      try {
        const room = getScene()?.stateManager?.room;
        if (!room || roomWrapped) return;
        roomWrapped = true;

        // Wrap outgoing sends; callback fires on storage-open actions.
        wrapRoomSend(room, getScene, (action, mid, params) => {
          if (mid) {
            _openingChestMid = mid;
            console.log(TAG, '[room][storage] player opening chest', { action, mid });
          } else {
            console.log(TAG, '[room][storage] storage action (no mid found)', { action, params });
          }
        });
        console.log(TAG, 'room.send wrapped — action detection active.');

        // Hook incoming messages for diagnostics and storage detection.
        if (typeof room.onMessage === 'function') {
          try {
            room.onMessage('*', (type, message) => {
              const _typeStr = String(type);
              // Fast exit for non-storage types — keeps updatePlayer/high-frequency
              // messages near-zero cost (no JSON.stringify, no regex).
              if (!/storage|chest|container|slot/i.test(_typeStr)) return;
              // Log each storage-related type exactly once.
              if (!_loggedMsgTypes.has(_typeStr)) {
                _loggedMsgTypes.add(_typeStr);
                console.log(TAG, '[room][msg] type=' + JSON.stringify(type), {
                  keys:    message && typeof message === 'object' ? Object.keys(message) : typeof message,
                  preview: JSON.stringify(message).slice(0, 600),
                });
              }
              const mid = _openingChestMid
                ?? (message && typeof message === 'object'
                    ? (message.mid ?? message.entityMid ?? null) : null);
              console.log(TAG, '[room][storage] storage message', {
                type, mid, preview: JSON.stringify(message).slice(0, 600),
              });
              if (mid && message && typeof message === 'object') {
                _tryExtractChestItems(String(mid), message);
              }
            });
            console.log(TAG, '[room] onMessage wildcard hooked.');
          } catch (e) {
            console.log(TAG, '[room] onMessage hook failed:', e);
          }
        }

        clearInterval(roomDetectInterval);
      } catch (_) {}
    }, 200);

    // ---- Storage slot polling — 2 s interval --------------------------------
    // Polls room.state.storage for changes; caches chest contents by mid when
    // items appear. This catches the case where no explicit message is sent.
    setInterval(() => {
      try {
        const room = getScene()?.stateManager?.room;
        const storage = room?.state?.storage;
        if (!storage || typeof storage.forEach !== 'function') return;
        const items = [];
        storage.forEach((slot, key) => {
          const itemId = slot?.item?.id ?? slot?.item ?? slot?.itemId ?? null;
          if (itemId === null || itemId === undefined) return;
          const qty = typeof slot?.quantity === 'number' ? slot.quantity
                    : typeof slot?.qty      === 'number' ? slot.qty : 0;
          items.push({ key: String(key), itemId: String(itemId), qty });
        });
        const hash = JSON.stringify(items);
        if (hash === _lastStorageHash) return;
        _lastStorageHash = hash;
        if (items.length === 0) {
          console.log(TAG, '[room][storage] storage cleared (chest closed?)');
          return; // don't overwrite cache with empty
        }
        // One-shot: log raw slot shape + toJSON for diagnosis
        if (!_storageShapeLogged) {
          _storageShapeLogged = true;
          storage.forEach((slot, key) => {
            try {
              console.log(TAG, '[room][storage] raw slot shape', {
                key, keys: Object.keys(slot ?? {}), json: JSON.stringify(slot).slice(0, 300),
              });
            } catch (_) {}
          });
          try {
            const sj = typeof storage.toJSON === 'function' ? storage.toJSON() : null;
            console.log(TAG, '[room][storage] storage.toJSON():', JSON.stringify(sj).slice(0, 600));
            console.log(TAG, '[room][storage] storage top-level keys:', Object.keys(storage));
          } catch (_) {}
        }
        const mid = _openingChestMid ?? 'unknown';
        const entry = { items, size: storage.size ?? items.length, removeOnly: !!storage.removeOnly, capturedAt: Date.now() };
        _chestCache[mid] = entry;
        ctx.storageChests = { ..._chestCache };
        console.log(TAG, '[room][storage] chest contents captured (polled)', { mid, itemCount: items.length });
        saveToCompanion('chestCache', { mid, ...entry });
      } catch (_) {}
    }, 2000);

    // ---- Texture census — one-shot, fires 5 s after game capture -----------
    // Enough time for the gameplay scene's preload() to finish loading assets.
    // Logs every texture matching /player|avatar|char|sprite|npc/i with full
    // sheet dimensions, per-frame dimensions, and frame count.
    // Also logs the complete key list so the regex can be tuned if nothing hits.
    setTimeout(() => {
      try {
        const textures = game.textures;
        if (!textures) {
          console.log(TAG, 'texture census: textures manager unavailable');
          return;
        }

        const allKeys = textures.getTextureKeys(); // excludes __DEFAULT, __MISSING
        const matches = allKeys.filter(k => /player|avatar|char|sprite|npc/i.test(k));

        console.log(TAG, `texture census: ${allKeys.length} textures loaded, ${matches.length} regex matches`);
        console.log(TAG, 'texture census all keys:', allKeys);

        matches.forEach(key => {
          const tex = textures.get(key);
          const src = tex.source[0];
          const sheetW = src?.width  ?? '?';
          const sheetH = src?.height ?? '?';

          // getFrameNames(false) excludes the __BASE sentinel so we get only
          // real animation/atlas frames.
          const frameNames = tex.getFrameNames(false);
          const frameCount = frameNames.length;

          let frameW = '?', frameH = '?';
          if (frameCount > 0) {
            const f = tex.get(frameNames[0]);
            frameW = f?.realWidth  ?? f?.width  ?? '?';
            frameH = f?.realHeight ?? f?.height ?? '?';
          } else {
            // Plain image with no atlas — whole sheet is the single frame.
            const base = tex.get('__BASE');
            frameW = base?.realWidth  ?? sheetW;
            frameH = base?.realHeight ?? sheetH;
          }

          console.log(
            TAG,
            `texture [${key}]:`,
            `sheet ${sheetW}\xd7${sheetH}px,`,
            `frame ${frameW}\xd7${frameH}px,`,
            `${frameCount > 0 ? frameCount : 1} frame${frameCount !== 1 ? 's' : ''}`,
          );
        });
      } catch (err) {
        console.error(TAG, 'texture census error:', err);
      }
    }, 5000);
    // ---- Land industry state — diff-on-change, 1 s interval -----------------
    // Waits for room.state.entities to exist, then reads industry entities on
    // every tick.  Saves to storage only when the snapshot content changes —
    // utcRefresh is part of the diff key, so a finishing entity IS a real change.
    // Logs a compact summary on every save so progress is visible in DevTools.
    let lastLandSnapshotKey = null;

    setInterval(() => {
      try {
        const room = getScene()?.stateManager?.room;
        if (!room?.state?.entities) return;

        const mapId = getScene()?.stateManager?.mapId;
        if (!mapId) return;

        const industries = readIndustryState(room);
        if (!industries) return;

        const permissions = readMapPermissions(room);
        const snapshot    = shapeLandSnapshot(mapId, industries, permissions);
        const key         = landSnapshotKey(snapshot);

        if (key === lastLandSnapshotKey) return;
        lastLandSnapshotKey = key;

        saveToCompanion('landSnapshot', snapshot);
        handleStateUpdate('land industry snapshot', {
          landId:        snapshot.landId,
          industryCount: snapshot.industries.length,
          observedAt:    snapshot.observedAt,
        });
      } catch (_) {}
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Debug helpers — remove before shipping the production UI.
  // ---------------------------------------------------------------------------

  // Call from the DevTools console to prove the full bridge and storage layer
  // work end-to-end before wiring real game-state data into it:
  //
  //   addTestNote("hello from the game page")
  //
  // Expected console output (from content.js after the write):
  //   [Pixels Companion] storage updated: { notes: [{id, text, createdAt}], ... }
  window.addTestNote = function (text) {
    saveToCompanion('note', { text });
  };

  // Call from the DevTools console to download everything in storage as a
  // JSON file.  Triggers a Blob download via content.js (which has DOM access):
  //
  //   exportCompanionData()
  //
  // Expected: browser downloads "pixels-companion-export-YYYY-MM-DD.json"
  window.exportCompanionData = function () {
    saveToCompanion('__export', {});
  };

  // Scan localStorage for anything that looks like a JWT (three dot-separated
  // base64url segments, length > 80).  Call from DevTools to confirm the
  // storage key if a fallback is needed:
  //
  //   diagLocalStorageJWTs()
  //
  // Expected output: array of { key, preview } for each candidate.
  window.diagLocalStorageJWTs = function () {
    const found = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k);
      if (v && v.split('.').length === 3 && v.length > 80) {
        found.push({ key: k, preview: v.slice(0, 40) + '…' });
      }
    }
    console.log(TAG, 'localStorage JWT candidates:', found);
    return found;
  };

  // Verify token capture + endpoint shape.  Call from DevTools once the game
  // has been running for a few seconds (after the first auth'd fetch fires):
  //
  //   testMarketplaceFetch('itm_someItemId', 'somePlayerId')
  //
  // If getSessionToken() returns null, open the marketplace panel first to
  // trigger a game fetch and then try again.
  window.testMarketplaceFetch = async function (itemId, playerId) {
    const token = getSessionToken();
    if (!token) {
      console.warn(TAG, 'No token captured yet — open the marketplace panel to trigger a game fetch first.');
      return null;
    }
    const url = `https://pixels-server.pixels.xyz/v1/marketplace/item/${itemId}?pid=${playerId}`;
    const res = await _origFetch(url, {
      headers: {
        Authorization: token,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Origin: 'https://pixels.xyz',
        Referer: 'https://pixels.xyz/',
      },
    });
    const data = await res.json().catch(() => '(non-JSON response)');
    console.log(TAG, 'marketplace test — status:', res.status, 'data:', data);
    return data;
  };

})();
