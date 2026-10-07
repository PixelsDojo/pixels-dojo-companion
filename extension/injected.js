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
  // Tracks which poller error keys have already been logged (once-per-key pattern).
  const _pollErrorLogged = new Set();


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
      } catch (e) {
        if (!_pollErrorLogged.has('fetch-wrapper')) {
          _pollErrorLogged.add('fetch-wrapper');
          console.error(TAG, '[auth] fetch wrapper error (logged once):', e);
        }
      }

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
  //
  // Per StoreOrderItemCard.tsx (OSS client), each card's React component receives:
  //   request: { item: { name: string, image: string, tier: number|undefined }, quantity: number }
  //   reward:  { currency: { amount: number, currencyId?: string },
  //              skill:    { skillType?: SkillType, xp: number },
  //              gachaId?: string }
  //
  // Strategy A (preferred): walk the card's React fiber .return chain, find the
  //   props object with request.item.name + request.quantity. Immune to CSS renames.
  // Strategy B (fallback): query [class*="card-title"] / [class*="item-quantity"] inside
  //   the card — wildcards, no hash suffix needed.
  // Strategy C (last resort): leaf-text scan for recognisable patterns.
  //
  // Returns an array (possibly empty); sets items._via = "fiber(N)" or "text(N)".
  // Sets items._firstCardFailReason when card 0 fails all strategies (cards present but parse fails).
  // Parse "5000", "14K", "1.5K" → number, or 0.
  function _parseCoinText(s) {
    const m = String(s).replace(/,/g, '').trim().match(/^([\d.]+)([KkMm]?)$/);
    if (!m) return 0;
    let v = parseFloat(m[1]);
    if (!isFinite(v)) return 0;
    if (m[2].toLowerCase() === 'k') v *= 1000;
    if (m[2].toLowerCase() === 'm') v *= 1_000_000;
    return Math.round(v);
  }

  // Build costs[] for backward-compat with backend routes that read costs[1] for coin amount.
  // costs[0] = XP text, costs[1] = coin text. Both filled so backend always finds coins at [1].
  function _buildCostsArray(coinReward, xpReward) {
    if (coinReward > 0 || xpReward > 0) {
      return [xpReward > 0 ? String(xpReward) : '', coinReward > 0 ? String(coinReward) : ''];
    }
    return [];
  }

  // Module-level proxy for _findItemId, which lives inside startPolling().
  // startPolling() assigns this after _findItemId is defined. Always guard with
  // typeof === 'function' before calling so a missing helper never crashes extraction.
  let _taskboardFindItemId = null;

  // Extract itm_xxx from an item image URL: /i/(itm_[^/]+)/
  function _itemIdFromImageUrl(url) {
    if (typeof url !== 'string') return null;
    const m = url.match(/\/i\/(itm_[^/]+)\//);
    return m ? m[1] : null;
  }

  function extractTaskboardItems(container) {
    const cardSel = '[class*="store-item-container"], [class*="StoreItem"]';
    const cards = [...container.querySelectorAll(cardSel)];

    let fiberHits = 0, textHits = 0;
    let _firstCardFailReason = null; // set when card 0 fails all 3 strategies

    // NO .filter(Boolean) at the end — always return all cards (even empty itemName)
    // so live.length > 0 is satisfied and the backend knows the taskboard is open.
    const items = cards.map((card, idx) => {
      let failA = null, failB = null;

      // ── Strategy A: React fiber walk (up to 20 levels) ───────────────────
      // Matches StoreOrderItemCard props: { request: { item: { name }, quantity }, reward }
      const fk = Object.keys(card).find(k => k.startsWith('__reactFiber$'));
      if (fk) {
        try {
          let fiber = card[fk];
          const seenKeys = [];
          for (let i = 0; i < 20 && fiber; i++) {
            const mp = fiber.memoizedProps;
            if (mp && typeof mp === 'object') {
              const req = mp.request;
              if (req && typeof req === 'object' &&
                  req.item && typeof req.item === 'object' &&
                  typeof req.item.name === 'string' && req.item.name) {
                const itemName   = req.item.name;
                const qty        = req.quantity;
                const rwd        = mp.reward;
                const coinReward = typeof rwd?.currency?.amount === 'number' ? Math.round(rwd.currency.amount) : 0;
                const xpReward   = typeof rwd?.skill?.xp === 'number' ? Math.round(rwd.skill.xp) : 0;
                const skillType  = rwd?.skill?.skillType ?? null;
                const deliverBtn = [...card.querySelectorAll('button')].find(b => /deliver/i.test(b.textContent));
                const canFill    = typeof mp.canFill === 'boolean' ? mp.canFill : false;
                const orderIndex = typeof mp.orderIndex === 'number' ? mp.orderIndex : idx;
                // itemId: prefer image URL, then name lookup, then null
                const imgItemId  = _itemIdFromImageUrl(req.item?.image);
                const itemId     = imgItemId ?? (typeof _taskboardFindItemId === 'function' ? (_taskboardFindItemId(itemName) ?? null) : null);
                fiberHits++;
                return {
                  itemName,
                  tier: req.item.tier ?? '',
                  quantityNeeded: typeof qty === 'number' ? qty : (parseInt(qty, 10) || 0),
                  costs: _buildCostsArray(coinReward, xpReward),
                  rewardItems: [],
                  isVipLocked: [...card.classList].some(c => c.toLowerCase().includes('vip')),
                  canDeliverNow: deliverBtn != null && !deliverBtn.hasAttribute('disabled'),
                  canFill, orderIndex, itemId,
                  coinReward, xpReward, skillType,
                  _src: 'fiber',
                };
              }
              if (mp) seenKeys.push(`L${i}:[${Object.keys(mp).slice(0, 6).join(',')}]`);
            }
            fiber = fiber.return;
          }
          if (idx === 0) failA = `fiber: no mp.request.item.name in 20 levels; seen: ${seenKeys.slice(0, 4).join(' ')}`;
        } catch (e) {
          if (idx === 0) failA = `fiber: threw ${e?.message ?? e}`;
        }
      } else {
        if (idx === 0) failA = 'fiber: no __reactFiber$ key on card element';
      }

      // ── Strategy B: CSS wildcard selectors ───────────────────────────────
      // Store.module.scss class names are stable; only the 5-char hash suffix changes on redeploy.
      // [class*="card-title"]    → item name   (styles['card-title'])
      // [class*="item-quantity"] → quantity    (styles['item-quantity'])
      // [class*="card-tier"]     → tier        (styles['card-tier'])
      // [class*="coinCost"]      → reward amounts (commons.module.scss)
      const nameEl     = card.querySelector('[class*="card-title"],[class*="CardTitle"]');
      const qtyEl      = card.querySelector('[class*="item-quantity"],[class*="ItemQuantity"]');
      const tierEl     = card.querySelector('[class*="card-tier"],[class*="CardTier"]');
      const deliverBtn = [...card.querySelectorAll('button')].find(b => /deliver/i.test(b.textContent));
      // coinCost elements: [0]=XP amount, [1]=coin amount (per StoreOrderItemCard render order)
      const coinCostEls = [...card.querySelectorAll('[class*="coinCost"],[class*="coin-cost"]')];

      if (nameEl) {
        const itemName       = nameEl.textContent.trim();
        const qtyText        = qtyEl?.textContent.trim() ?? '';
        const quantityNeeded = parseInt(qtyText.replace(/^[x×]/i, ''), 10) || 0;
        const tier           = tierEl?.textContent.trim() ?? '';

        // Use coinCost elements for costs (stable text, same approach as working c0b4333).
        const costs = coinCostEls.map(el => el.textContent.trim()).filter(Boolean);
        // Also derive coinReward numerically from coinCost elements or header scan.
        let coinReward = 0;
        if (costs.length >= 2) coinReward = _parseCoinText(costs[1]);
        else if (costs.length === 1) coinReward = _parseCoinText(costs[0]);
        if (!coinReward) {
          // Fallback: scan header leaves for largest numeric value.
          const headerEl = card.querySelector('[class*="card-header"]');
          for (const el of [...(headerEl ?? card).querySelectorAll('*')].filter(e => e.childElementCount === 0)) {
            const v = _parseCoinText(el.textContent.trim());
            if (v > 100 && v > coinReward) coinReward = v;
          }
        }

        if (itemName) {
          textHits++;
          return {
            itemName, tier, quantityNeeded, costs, rewardItems: [],
            isVipLocked: [...card.classList].some(c => c.toLowerCase().includes('vip')),
            canDeliverNow: deliverBtn != null && !deliverBtn.hasAttribute('disabled'),
            canFill: false, orderIndex: idx,
            itemId: (typeof _taskboardFindItemId === 'function' ? (_taskboardFindItemId(itemName) ?? null) : null),
            coinReward, xpReward: 0, skillType: null,
            _src: 'text-class',
          };
        }
        if (idx === 0) failB = `class-sel: [class*="card-title"] found but text was empty`;
      } else {
        if (idx === 0) {
          const allClasses = [...card.querySelectorAll('*')].flatMap(e => [...e.classList]).slice(0, 20).join(' ');
          failB = `class-sel: no [class*="card-title"] inside card; inner classes: ${allClasses}`;
        }
      }

      // ── Strategy C: leaf-text scan (last resort, always returns something) ─
      const leaves = [...card.querySelectorAll('*')].filter(el => el.childElementCount === 0);

      // Quantity: span inside item-quantity div shows just the number; "x" is a text node.
      // Also catch "x5" or "×3" when rendered as a single element.
      let quantityNeeded = 0;
      if (!quantityNeeded) {
        const qEl2 = card.querySelector('[class*="item-quantity"],[class*="ItemQuantity"]');
        if (qEl2) {
          const raw = qEl2.textContent.trim().replace(/^[x×]/i, '');
          quantityNeeded = parseInt(raw, 10) || 0;
        }
      }
      if (!quantityNeeded) {
        for (const el of leaves) {
          const t = el.textContent.trim();
          const m = t.match(/^[x×]\s*(\d+)$/i);
          if (m) { quantityNeeded = parseInt(m[1], 10); break; }
        }
      }

      // Item name: longest text that isn't a number, quantity, or button text.
      const deliverBtn2 = deliverBtn ?? [...card.querySelectorAll('button')].find(b => /deliver/i.test(b.textContent));
      let itemName = '';
      for (const el of leaves) {
        if (deliverBtn2 && deliverBtn2.contains(el)) continue;
        const t = el.textContent.trim();
        if (t.length < 3) continue;
        if (/^[x×]\s*\d+$/i.test(t)) continue;
        if (/^[\d,]+\.?\d*\s*[KkMm]?$/.test(t)) continue;
        if (/^\d+\s*(?:xp|exp|pts?)$/i.test(t)) continue;
        if (/^(?:deliver|vip|tier\s*\d*)$/i.test(t)) continue;
        if (t.length > itemName.length) itemName = t;
      }

      // Coin reward: use coinCost elements if present, else scan leaves for largest number.
      const coinCostEls2 = coinCostEls.length > 0 ? coinCostEls
        : [...card.querySelectorAll('[class*="coinCost"],[class*="coin-cost"]')];
      const costs2 = coinCostEls2.map(el => el.textContent.trim()).filter(Boolean);
      let coinReward2 = 0;
      if (costs2.length >= 2) coinReward2 = _parseCoinText(costs2[1]);
      else if (costs2.length === 1) coinReward2 = _parseCoinText(costs2[0]);
      if (!coinReward2) {
        for (const el of leaves) {
          const v = _parseCoinText(el.textContent.trim());
          if (v > 100 && v > coinReward2) coinReward2 = v;
        }
      }

      if (!itemName && idx === 0) {
        const preview = leaves.slice(0, 8).map(e => `"${e.textContent.trim().slice(0, 40)}"`).join(', ');
        _firstCardFailReason = `${failA}; ${failB}; leaf-scan: no item name, leaf texts: ${preview}`;
      }

      textHits++;
      return {
        itemName, tier: '', quantityNeeded,
        costs: costs2.length > 0 ? costs2 : _buildCostsArray(coinReward2, 0),
        rewardItems: [],
        isVipLocked: [...card.classList].some(c => c.toLowerCase().includes('vip')),
        canDeliverNow: deliverBtn2 != null && !deliverBtn2.hasAttribute('disabled'),
        canFill: false, orderIndex: idx,
        itemId: itemName ? (typeof _taskboardFindItemId === 'function' ? (_taskboardFindItemId(itemName) ?? null) : null) : null,
        coinReward: coinReward2, xpReward: 0, skillType: null,
        _src: 'text-leaf',
      };
    }); // intentionally no .filter(Boolean) — empty-name items still count as live

    items._via = fiberHits > 0 ? `fiber(${fiberHits})` : `text(${textHits})`;
    items._firstCardFailReason = _firstCardFailReason;
    return items;
  }

  // Stacked/Offers: extract every offer accordion from the offers-list container.
  // timerText is returned in the payload but intentionally excluded from the diff
  // key — it's a live countdown that would trigger handleStateUpdate every tick.
  function extractOffers(container) {
    return [...container.querySelectorAll('[class*="offerAccordionContainer"]')].map(offer => {
      const requirementText = offer.querySelector('[class*="requirementText"]')?.textContent.trim()    ?? '';
      const timerText       = offer.querySelector('[class*="timerText"]')?.textContent.trim()          ?? '';
      const rewards         = [...offer.querySelectorAll('[class*="rewardIconWrapper"]')]
                                .map(el => el.getAttribute('aria-label'))
                                .filter(Boolean);
      const description     = offer.querySelector('[class*="accordionDescription"]')?.textContent.trim() ?? '';
      const claimBtn        = [...offer.querySelectorAll('button')].find(b => /claim/i.test(b.textContent));
      const eligible        = claimBtn != null && !claimBtn.hasAttribute('disabled');
      return { requirementText, timerText, rewards, description, eligible };
    });
  }

  // Crafting detail panel: extract one recipe from [class*="PageDetails"].
  //
  // All selectors use [class*="…"] wildcards — never hardcode the 5-char CSS-module
  // hash suffix; it changes on every Stacked/Crafting redeploy.
  // Text-pattern fields:  craftTimeSeconds, energyCost, vipRequired, xpSkill,
  //   xpAmount — matched against panel.textContent; text is stable across builds.
  // requiredItems: walk every img in the panel, find nearest ancestor (≤4 levels)
  //   whose text contains an N/N ratio; main item image excluded automatically
  //   because it has no sibling N/N text.
  function extractCraftingRecipe(panel) {
    const itemName = panel.querySelector('[class*="detailsTitle"]')?.textContent.trim() ?? '';
    if (!itemName) return null; // panel present but not fully rendered yet

    // tier — small overlay on the item image.
    const tierEl = panel.querySelector('[class*="tier"i]');
    const tier = tierEl?.textContent.trim() || null;

    // outputQuantity — text is "x12"-style, strip leading x.
    const qtyEl = panel.querySelector('[class*="itemQuantity"]');
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

    // requiredItems — each quantity element (e.g. "11/24") is the anchor; we walk up
    // one level to the ingredient block and find the img inside it.
    const requiredItems = [];
    panel.querySelectorAll('[class*="craftingFontQuantities"]').forEach(qtyEl => {
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

    const library = globalThis.gameLibrary?.entities;
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

  // Read a named field from generic.statics — handles plain object, native Array,
  // and Colyseus ArraySchema (which has .find() but may not pass Array.isArray()).
  function _readStaticsProp(statics, name) {
    if (!statics) return undefined;
    if (typeof statics.find === 'function') {
      try {
        const entry = statics.find(e => e != null && e.name === name);
        return entry !== undefined ? entry.value : undefined;
      } catch (_) {}
    }
    return statics[name];
  }

  // Count soil entities in room.state.entities, grouped by tier.
  // Returns an object like {4: 62, 3: 10} — empty object when no soil entities found.
  // Matches any entity whose ID contains "soil" (e.g. ent_farm_soil_04) with a _NN suffix.
  function readSoilState(room) {
    const entities = room?.state?.entities;
    if (!entities || typeof entities.forEach !== 'function') return {};

    const tierCounts = {};
    entities.forEach((mapEntity) => {
      if (!mapEntity?.entity) return;
      const id = mapEntity.entity.toLowerCase();

      // Legacy: ent_farm_soil_04 style — read tier from numeric suffix
      if (id.includes('soil')) {
        const m = id.match(/_(\d{2})$/);
        if (m) {
          const tier = parseInt(m[1], 10);
          if (tier > 0) tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
          return;
        }
      }

      // New: ent_allcrops — read soilTier from generic.statics (may be ArraySchema)
      if (/allcrops|crop|plot/i.test(id)) {
        const soilTierRaw = _readStaticsProp(mapEntity?.generic?.statics, 'soilTier');
        if (soilTierRaw != null) {
          const tier = parseInt(String(soilTierRaw), 10);
          if (!isNaN(tier) && tier > 0) tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
        }
      }
    });
    return tierCounts;
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
  function shapeLandSnapshot(mapId, industries, permissions, soilTiers) {
    return {
      landId:      mapId,
      observedAt:  Date.now(),
      permissions: permissions ?? { use: [], useByIndustry: {} },
      industries:  industries  ?? [],
      soilTiers:   soilTiers   ?? {},
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
      soilTiers:   snapshot.soilTiers,
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
  // Phaser.Game constructor Proxy — coexistence-safe
  // Works alongside other extensions (e.g. PGA) that also hook Phaser.Game:
  //   • chains any existing window.Phaser setter rather than overwriting it
  //   • wraps (not replaces) whatever Phaser.Game currently is — even a proxy
  //   • polls as a fallback so startup survives a setter overwrite
  // ---------------------------------------------------------------------------
  let _pollingStarted = false;
  const _hookedConstructors = new WeakSet();

  function attachOnce(game, via) {
    if (_pollingStarted) return;
    _pollingStarted = true;
    console.log(TAG, '[init] attached via', via);
    startPolling(game);
  }

  function hookPhaserGame(Phaser) {
    const prevGame = Phaser?.Game;
    if (!prevGame || _hookedConstructors.has(prevGame)) return;
    console.log(TAG, '[init] Phaser detected — version:', Phaser?.VERSION);
    const proxy = new Proxy(prevGame, {
      construct(target, args) {
        const instance = Reflect.construct(target, args);
        attachOnce(instance, 'constructor hook');
        return instance;
      },
    });
    _hookedConstructors.add(prevGame);
    _hookedConstructors.add(proxy);
    Phaser.Game = proxy;
  }

  function tryAttachExisting(Phaser) {
    if (_pollingStarted || !Phaser) return false;
    const games = Phaser.GAMES;
    if (Array.isArray(games)) {
      for (const g of games) {
        if (g && !g.isDestroyed) {
          attachOnce(g, 'existing game (Phaser.GAMES)');
          return true;
        }
      }
    }
    return false;
  }

  function handlePhaserReady(Phaser) {
    if (!Phaser) return;
    hookPhaserGame(Phaser);
    tryAttachExisting(Phaser);
  }

  // ---------------------------------------------------------------------------
  // window.Phaser trap — chains any existing setter (e.g. from PGA extension)
  // ---------------------------------------------------------------------------
  if (window.Phaser) {
    handlePhaserReady(window.Phaser);
  } else {
    const _existingPhaserDesc = Object.getOwnPropertyDescriptor(window, 'Phaser');
    const _prevPhaserSetter = typeof _existingPhaserDesc?.set === 'function'
      ? _existingPhaserDesc.set : null;
    if (_prevPhaserSetter) {
      console.log(TAG, '[init] chaining existing window.Phaser setter');
    }
    try {
      Object.defineProperty(window, 'Phaser', {
        configurable: true,
        enumerable: true,
        set(value) {
          if (_prevPhaserSetter) {
            try { _prevPhaserSetter.call(window, value); } catch (_) {}
          }
          try {
            Object.defineProperty(window, 'Phaser', {
              value, configurable: true, writable: true, enumerable: true,
            });
          } catch (_) {}
          handlePhaserReady(value);
        },
      });
    } catch (e) {
      console.log(TAG, '[init] defineProperty on window.Phaser failed:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Startup polling fallback — every 500 ms for up to 30 s.
  // Catches: (a) game already running when extension loads, (b) another
  // extension overwrote our setter without chaining, (c) any other edge case.
  // ---------------------------------------------------------------------------
  let _startupPollCount = 0;
  const _startupPollInterval = setInterval(() => {
    _startupPollCount++;
    if (_pollingStarted || _startupPollCount > 60) {
      clearInterval(_startupPollInterval);
      if (!_pollingStarted) {
        console.log(TAG, '[init] startup timeout — game not detected after 30s');
      }
      return;
    }
    const Ph = window.Phaser;
    if (!Ph) return;
    hookPhaserGame(Ph);
    tryAttachExisting(Ph);
  }, 500);

  // ---------------------------------------------------------------------------
  // Pollers — started once the Phaser.Game instance is captured.
  // scene[1] is the confirmed gameplay scene for Pixels Online.
  // ---------------------------------------------------------------------------
  function startPolling(game) {
    console.log(TAG, 'Polling started.');

    function getScene() {
      return game.scene.scenes[1];
    }

    // ---- Activity timers — declared at TOP before any handler ---------------
    // IMPORTANT: these must stay before every closure/handler that references them.
    const _actTimers         = new Map();  // entityMid → {entityMid,entityLabel,itemLabel,landLabel,mapId,startedAt,readyAt}
    const _notifiedTimerIds  = new Set();  // entity mids for which ready notification was sent
    // _dumpedEntityTypes intentionally NOT pre-populated — reset on page load so each
    // entity type is always dumped fresh, giving visibility into current field shapes.
    const _dumpedEntityTypes = new Set();
    let   _lastViewedRecipe  = null;       // most recent recipe panel scan; used for craft item name
    let   _lastIngredientActionAt = 0;     // epoch ms of last inventory-consuming action
    let   _staticsTick       = 0;          // incremented on every _scanStaticsCraftTimers call
    let   _craftCaptureUntil = 0;          // epoch ms — log ALL sends+msgs until this time
    const _knownPresentUIStates = new Set();  // presentUI params[1] values seen (one-time log)
    const _lastClickEntityInfo  = new Map();  // click mid → {typeId, ts}
    const _loggedCatalogMisses  = new Set();  // item ids logged as catalog misses
    // Taskboard debug: ring-buffer of the last 20 presentUI events (any ui value).
    const _recentPresentUIEvents = [];
    // Track which taskboard container selector succeeded most recently.
    let _taskboardDetectedVia = null;
    // Last logged extract count/method — only log when these change.
    let _taskboardLastLoggedCount = -1;
    let _taskboardLastLoggedVia   = '';
    // Auto-snapshot: fires once per session when the panel first has visible cards.
    let _taskboardAutoSnapshotDone = false;
    // Last debug snapshot — persists after panel closes so __pxTaskboardDebug() can return it.
    let _lastTaskboardDebugSnapshot = null;
    // How many items-content elements existed when last logged — log when count changes.
    let _itemsContentCountLogged = -1;

    // plotSeeds: "mapId:entityMid" → seedItemId — detected from inventory drop at plant time.
    // Persisted via extension storage so labels survive page refreshes.
    let _plotSeeds = {};

    // Batch counter for "not started — entity idle/empty" log noise reduction.
    let _emptyPlotBatchCount = 0;
    let _emptyPlotBatchTimer = null;
    function _logEmptyPlotBatch() {
      if (_emptyPlotBatchTimer) clearTimeout(_emptyPlotBatchTimer);
      _emptyPlotBatchTimer = setTimeout(() => {
        if (_emptyPlotBatchCount > 0) {
          console.log(`[timers] ${_emptyPlotBatchCount} plot${_emptyPlotBatchCount === 1 ? '' : 's'} empty (harvested)`);
          _emptyPlotBatchCount = 0;
        }
        _emptyPlotBatchTimer = null;
      }, 2000);
    }

    function _savePlotSeeds() {
      try { saveToCompanion('plotSeeds', { seeds: _plotSeeds }); } catch (_) {}
    }

    // Read a named field from generic.statics — handles plain object, native Array,
    // and Colyseus ArraySchema (uses module-level _readStaticsProp).
    function _staticsGet(statics, name) {
      return _readStaticsProp(statics, name);
    }

    // Scans crop entities for active grow timers (inUseBy/pid == me).
    let _staticsScanSig = '';  // last logged scan signature to detect changes

    function _scanStaticsCraftTimers() {
      try {
        _staticsTick++;
        const room = getScene()?.stateManager?.room;
        if (!room?.state?.entities) return;
        const playerId = ctx.playerId;
        if (!playerId) {
          console.warn('[timers] statics scan: ctx.playerId is empty — skipping');
          return;
        }
        const now     = Date.now();
        const mapId   = String(getScene()?.stateManager?.mapId ?? 'unknown');

        let cntEntities = 0, cntWithStatics = 0, cntPidSet = 0, cntMine = 0;
        let cntAllcrops = 0; // total allcrops entities seen this scan (for diagnostics)

        const activeMids = new Set(); // mids of all crop timers still live this scan
        let changed = false;

        room.state.entities.forEach((entity) => {
          try {
            cntEntities++;
            const statics = entity?.generic?.statics;
            // Allow null/undefined statics through for crop entities — we still want to count them.
            const typeId = String(entity?.entity ?? '');
            const mid    = String(entity?.mid ?? entity?.id ?? '');
            if (!mid) return;

            // ---- CROP TIMERS ------------------------------------------------
            if (/allcrops|crop|plot|farm/i.test(typeId)) {
              cntAllcrops++;
              // Diagnostic: log first 3 allcrops per scan while crops=0 (debug only)
              if (window.PX_COMPANION_DEBUG && cntMine === 0 && cntAllcrops <= 3) {
                const dbgInUseBy = _staticsGet(statics, 'inUseBy');
                const dbgState   = entity?.generic?.state ?? '(none)';
                const isArr      = Array.isArray(statics);
                const hasFindFn  = typeof statics?.find === 'function';
                console.log(`[timers] allcrops[${cntAllcrops}] mid=${mid} inUseBy=${dbgInUseBy ?? 'null'} state=${dbgState} isArray=${isArr} hasFindFn=${hasFindFn}`);
              }
              if (!statics || typeof statics !== 'object') return;
              cntWithStatics++;
              // Match: inUseBy or pid equals playerId — statics may be array [{name,value}] or object
              const inUseBy = _staticsGet(statics, 'inUseBy') ?? null;
              const cropPid = _staticsGet(statics, 'pid') ?? _staticsGet(statics, 'playerId') ?? null;
              const mine    = (inUseBy  && String(inUseBy).trim()  === String(playerId).trim())
                           || (cropPid  && String(cropPid).trim()  === String(playerId).trim());
              if (!mine) return;

              cntPidSet++;
              cntMine++;
              activeMids.add(mid);

              const utcTarget    = entity?.generic?.displayInfo?.utcTarget ?? null;
              const state        = String(entity?.generic?.state ?? '').toLowerCase();
              const fruitItem    = _staticsGet(statics, 'fruitItem') ?? null;
              const seedItem     = _staticsGet(statics, 'seedItem') ?? null;
              const minutesNeeded = _staticsGet(statics, 'minutesNeeded') ?? null;
              const cropLabel    = _resolveCropLabel(fruitItem, seedItem);
              const landLabel    = _landLabelFor(mapId);

              let readyAt   = null;
              let estimated = false;

              if (utcTarget && utcTarget > now) {
                readyAt = utcTarget;
              } else if (/planted|growing/i.test(state) && minutesNeeded) {
                readyAt   = now + Number(minutesNeeded) * 60_000;
                estimated = true;
              } else if (/grown|ready|harvest/i.test(state)) {
                // Already harvestable — mark ready but keep listed
                const ex = _actTimers.get(mid);
                if (ex && ex.readyAt > now) { ex.readyAt = now - 1; changed = true; }
                return;
              } else {
                return; // no usable time info yet
              }

              const existing = _actTimers.get(mid);
              const readyAtChanged = !existing || existing.readyAt !== readyAt;
              const labelChanged   = !existing || existing.itemLabel !== cropLabel;
              if (!readyAtChanged && !labelChanged) return; // no change

              if (existing?.estimated && !estimated) {
                console.log(`[timers] crop upgraded est→real: ${cropLabel} readyAt=${new Date(readyAt).toISOString()}`);
              } else if (!existing) {
                console.log(`[timers] crop scan: ${cropLabel} on ${landLabel}${estimated ? ' (est.)' : ''} readyAt=${new Date(readyAt).toISOString()}`);
              } else if (labelChanged) {
                console.log(`[timers] crop relabeled: ${existing.itemLabel}→${cropLabel}`);
              }
              _actTimers.set(mid, {
                entityMid: mid, entityLabel: 'crop', source: 'crop',
                itemLabel: cropLabel, landLabel, mapId,
                startedAt: existing?.startedAt ?? now,
                readyAt, estimated: !!estimated,
              });
              _notifiedTimerIds.delete(mid);
              return;
            }

          } catch (_) {}
        });

        // Log summary when counts change
        const sig = `${mapId}|${cntEntities}|${cntWithStatics}|${cntPidSet}|${cntMine}`;
        if (sig !== _staticsScanSig) {
          _staticsScanSig = sig;
          console.log(`[timers] statics scan: map=${mapId} entities=${cntEntities} withStatics=${cntWithStatics} crops=${cntMine} playerId=${playerId}`);
        }
        // Periodic heartbeat every 6th tick (~1 min at 10s interval)
        if (_staticsTick % 6 === 0) {
          console.log(`[timers] statics tick ${_staticsTick} map=${mapId} crops=${cntMine}`);
        }

        // Safer cleanup: only clear a crop timer if the plot entity is found on the current
        // map AND its state is explicitly empty/idle. If grown/ready, mark Ready but keep.
        for (const [mid, timer] of _actTimers) {
          if (timer.mapId !== mapId) continue; // different map — preserve
          if (timer.source !== 'crop') continue;
          if (activeMids.has(mid)) continue;    // still active this scan — no action needed
          // Check entity state directly
          let ent = null;
          room.state.entities.forEach((e) => {
            if (!ent && String(e?.mid ?? e?.id ?? '') === mid) ent = e;
          });
          if (!ent) continue; // not in room — keep timer (might be multi-map)
          const entState = String(ent?.generic?.state ?? '').toLowerCase();
          if (/grown|ready|harvest/i.test(entState)) {
            if (timer.readyAt > now) { timer.readyAt = now - 1; changed = true; }
          } else if (!entState || /empty|idle|bare|fallow/i.test(entState)) {
            _actTimers.delete(mid);
            _notifiedTimerIds.delete(mid);
            console.log(`[timers] cleared (empty plot): crop ${timer.itemLabel} mid=${mid}`);
            changed = true;
          }
        }

        if (activeMids.size > 0 || changed) _syncTimers();
      } catch (e) { console.error('[timers] statics scan error:', e); }
    }

    // itemId → display name, e.g. "itm_popberrySeeds" → "Popberry Seeds"
    // Populated in _fetchLibItems alongside _nameMap.
    let _itemIdToName = {};

    // Friendly station/entity type labels for timer display.
    // Returns null for unknown types so presentUI handler can fall back to skill name.
    function _friendlyEntityLabel(entityTypeId) {
      if (!entityTypeId) return null;
      const t = String(entityTypeId).toLowerCase();
      if (/allcrops|crop|plot|farm/i.test(t))    return 'Crop';
      if (/woodwork/i.test(t))                   return 'Woodwork';
      if (/metalwork/i.test(t))                  return 'Metalworking';
      if (/winery/i.test(t))                     return 'Winery';
      if (/textile/i.test(t))                    return 'Textile';
      if (/stove|oven|kitchen|cook/i.test(t))    return 'Stove';
      if (/forge|anvil|smith/i.test(t))          return 'Forge';
      if (/mine|rock|ore|stone/i.test(t))        return 'Mine';
      if (/loom|weav|fabric/i.test(t))           return 'Loom';
      if (/barrel|brew|ferment/i.test(t))        return 'Brew';
      if (/press|juice|extract/i.test(t))        return 'Press';
      if (/kiln|clay|pottery/i.test(t))          return 'Kiln';
      return null;
    }

    function _entityLabelFor(entityTypeId) {
      try {
        const lib = globalThis.gameLibrary?.entities?.[entityTypeId];
        const libLabel = lib?.name ?? lib?.label ?? null;
        if (libLabel) return libLabel;
        return _friendlyEntityLabel(entityTypeId) ?? 'Activity';
      } catch (_) { return 'Activity'; }
    }

    // Prettify an item id as a last-resort label when catalog lookup fails.
    // itm_axe_01 → "Axe", ach_vinegar → "Vinegar", itm_tatoFruit → "Tato Fruit"
    function _prettifyItemId(itemId) {
      if (!itemId) return null;
      const raw = String(itemId)
        .replace(/^(?:itm_|ach_)/i, '')  // strip prefix
        .replace(/_(\d+)$/, '')           // strip _01 etc
        .replace(/_/g, ' ');              // underscores to spaces
      const words = raw.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/).filter(Boolean);
      const clean = words.filter(w => !/^\d+$/.test(w));
      return (clean.length > 0 ? clean : words)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ') || null;
    }

    // Case-insensitive catalog lookup with extended fallbacks.
    // Returns null (not a prettified string) — callers decide whether to prettify.
    function _catalogName(itemId) {
      if (!itemId || typeof itemId !== 'string') return null;
      const keys = Object.keys(_itemIdToName);
      if (keys.length === 0) return null; // catalog not loaded yet
      // 1. Exact
      if (_itemIdToName[itemId] !== undefined) return _itemIdToName[itemId];
      // 2. Case-insensitive
      const lower = itemId.toLowerCase();
      for (const k of keys) {
        if (k.toLowerCase() === lower) return _itemIdToName[k];
      }
      // 3. Try with itm_ prefix if not already prefixed
      if (!lower.startsWith('itm_')) {
        const withPrefix = 'itm_' + itemId;
        if (_itemIdToName[withPrefix] !== undefined) return _itemIdToName[withPrefix];
        const withPrefixLower = 'itm_' + lower;
        for (const k of keys) {
          if (k.toLowerCase() === withPrefixLower) return _itemIdToName[k];
        }
      }
      // 4. Strip numeric suffix (e.g. _01) and retry
      const stripped = itemId.replace(/_\d+$/, '');
      if (stripped !== itemId) {
        const fromStripped = _catalogName(stripped);
        if (fromStripped) return fromStripped;
      }
      return null;
    }

    // Resolve a crop label from fruitItem/seedItem ids.
    // Never returns "Crop" when either id exists — uses prettify as final fallback.
    function _resolveCropLabel(fruitItem, seedItem) {
      if (fruitItem) {
        const cat = _catalogName(fruitItem);
        if (cat) return cat.replace(/\s+fruit$/i, '').trim() || cat;
        const pretty = _prettifyItemId(fruitItem);
        if (pretty) {
          if (!_loggedCatalogMisses.has(fruitItem)) {
            _loggedCatalogMisses.add(fruitItem);
            console.log(`[timers] catalog miss ${fruitItem} (pretty: ${pretty})`);
          }
          return pretty.replace(/\s+fruit$/i, '').trim() || pretty;
        }
      }
      if (seedItem) {
        const cat = _catalogName(seedItem);
        if (cat) return cat.replace(/\s+seeds?$/i, '').trim() || cat;
        const pretty = _prettifyItemId(seedItem);
        if (pretty) {
          if (!_loggedCatalogMisses.has(seedItem)) {
            _loggedCatalogMisses.add(seedItem);
            console.log(`[timers] catalog miss ${seedItem} (pretty: ${pretty})`);
          }
          return pretty.replace(/\s+seeds?$/i, '').trim() || pretty;
        }
      }
      return 'Crop';
    }

    // Convert an item ID to a crop-friendly display name (used by _pollEntityForTimer).
    function _itemIdToLabel(itemId) {
      if (!itemId || typeof itemId !== 'string') return null;
      const fromMap = _itemIdToName[itemId];
      if (fromMap) {
        return fromMap.replace(/\s+(?:seeds?|plant|sprout)$/i, '').trim() || fromMap;
      }
      return _prettifyItemId(itemId);
    }

    function _itemLabelFor(generic, entityTypeId) {
      try {
        const di = generic?.displayInfo;
        if (di?.title && typeof di.title === 'string' && di.title.trim()
            && !/^(?:ent_|itm_)/i.test(di.title.trim())) return di.title.trim();
        if (di?.name  && typeof di.name  === 'string' && di.name.trim()
            && !/^(?:ent_|itm_)/i.test(di.name.trim()))  return di.name.trim();

        // generic.current may be an item id ("itm_popberrySeeds") — resolve it
        if (typeof generic?.current === 'string' && generic.current.length > 0) {
          const fromId = _itemIdToLabel(generic.current);
          if (fromId) return fromId;
          // Don't fall through to return the raw id — use entity label instead
        }

        // generic.state may encode the crop: "growing_popberry" → "Popberry"
        if (typeof generic?.state === 'string') {
          const m = generic.state.match(/^(?:growing|planted|crafting)_(.+)$/i);
          if (m) {
            const word = m[1];
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
          }
        }

        return _entityLabelFor(entityTypeId);
      } catch (_) { return 'Activity'; }
    }

    function _landLabelFor(mapId) {
      if (!mapId) return 'your land';
      const s = String(mapId);
      // nftHouse486 / nftHouse_486 → "House 486"
      const houseM = s.match(/nfthouse[_-]?(\d+)/i);
      if (houseM) return `House ${houseM[1]}`;
      // farmLand486 / nftFarm486 / nftLand486 / pixelsNFTFarm-486 → "Land 486"
      const farmM = s.match(/(?:farmland|nftfarm|nftland|land|pixelsnftfarm)[_-]?(\d+)/i);
      if (farmM) return `Land ${farmM[1]}`;
      // speck → "Speck"
      if (/speck/i.test(s)) return 'Speck';
      // bare number → "Land <n>"
      if (/^\d+$/.test(s)) return `Land ${s}`;
      return s;
    }

    function _syncTimers() {
      try {
        const arr = [..._actTimers.values()];
        saveToCompanion('activityTimers', { timers: arr });
        console.log(`[timers] stored: ${arr.length} timer(s) — ` + arr.map(t => t.itemLabel).join(', '));
      } catch (e) { console.error('[timers] error in _syncTimers:', e); }
    }

    // Re-label existing timers after catalog loads — crop timers are re-labeled on next scan
    // tick naturally; craft timers need explicit relabeling using stored _achId.
    function _relabelTimers() {
      let changed = false;
      for (const [key, timer] of _actTimers) {
        if (timer.source === 'craft' && timer._achId) {
          const newItem = _catalogName('itm_' + timer._achId) ?? _catalogName(timer._achId);
          if (newItem) {
            const parts = timer.itemLabel.split(' · ');
            const newLabel = parts[0] + ' · ' + newItem;
            if (newLabel !== timer.itemLabel) {
              timer.itemLabel = newLabel;
              changed = true;
              console.log(`[timers] relabeled craft: ${newLabel}`);
            }
          }
        }
      }
      if (changed) _syncTimers();
    }

    // Actions that are never crafting/planting/mining — suppress from timer logging.
    const _TIMER_IGNORE = new Set([
      'mv', 'move', 'timerCheck', 'ping', 'pong', 'updateCamera',
      'camera', 'chat', 'emote', 'expression',
    ]);

    // Poll room.state.entities every 500ms (up to 10×) until the entity has a
    // valid future utcRefresh — the game pushes the update asynchronously.
    // Dumps entity state once per typeId so field names are visible in console.
    function _pollEntityForTimer(midStr) {
      let attempts   = 0;
      let dumped     = false;      // full state dump fired for this poll
      const maxTries = 10;
      const clickedAt = Date.now(); // capture when the action was first seen

      // Snapshot inventory NOW (before game processes the action) for seed-drop and
      // ingredient-consumption detection. 2 s later we diff results.
      const mapId0     = getScene()?.stateManager?.mapId ?? 'unknown';
      const plotKey    = mapId0 + ':' + midStr;
      const selfSnap0  = getScene()?.stateManager?.selfPlayer;
      const invBefore  = {};
      selfSnap0?.inventory?.slots?.$items?.forEach(slot => {
        if (slot?.item == null) return;
        const id = String(slot.item?.id ?? slot.item ?? '');
        if (id.startsWith('itm_'))
          invBefore[id] = (invBefore[id] ?? 0) + (slot.quantity ?? 0);
      });

      setTimeout(() => {
        try {
          const selfAfter = getScene()?.stateManager?.selfPlayer;
          if (!selfAfter) return;
          const invAfter = {};
          selfAfter?.inventory?.slots?.$items?.forEach(slot => {
            if (slot?.item == null) return;
            const id = String(slot.item?.id ?? slot.item ?? '');
            if (id.startsWith('itm_'))
              invAfter[id] = (invAfter[id] ?? 0) + (slot.quantity ?? 0);
          });
          let anyConsumed = false;
          for (const [id, before] of Object.entries(invBefore)) {
            const after = invAfter[id] ?? 0;
            if (before > after) {
              anyConsumed = true;
              if (/seeds?/i.test(id)) {
                _plotSeeds[plotKey] = id;
                console.log(`[timers] plot seed detected: ${plotKey} → ${id}`);
                _savePlotSeeds();
              }
            }
          }
          if (anyConsumed) {
            _lastIngredientActionAt = Date.now();
          }
        } catch (_) {}
      }, 2000);

      const poll = setInterval(() => {
        attempts++;
        try {
          const room = getScene()?.stateManager?.room;
          if (!room?.state?.entities) {
            if (attempts >= maxTries) {
              clearInterval(poll);
              console.log(`[timers] not started: no room.state.entities after ${maxTries} tries (mid=${midStr})`);
            }
            return;
          }

          let found   = null;
          let foundVia = 'key';
          // Key lookup first (O(1)); Colyseus MapSchema key may or may not equal entity.mid.
          if (typeof room.state.entities.get === 'function') {
            const byKey = room.state.entities.get(midStr);
            if (byKey) found = byKey;
          }
          if (!found) {
            foundVia = 'mid/id';
            room.state.entities.forEach((e) => {
              if (!found && (String(e?.mid) === midStr || String(e?.id) === midStr)) found = e;
            });
          }

          if (!found) {
            if (attempts >= maxTries) {
              clearInterval(poll);
              console.log(`[timers] not started: entity ${midStr} not found in room.state after ${maxTries} tries`);
            }
            return;
          }

          const generic = found.generic;

          // Dump once per new entity typeId (debug only; skip allcrops — shape already known).
          if (window.PX_COMPANION_DEBUG && !dumped && !_dumpedEntityTypes.has(found.entity)) {
            dumped = true;
            _dumpedEntityTypes.add(found.entity);
            if (!/allcrops|crop|plot|farm/i.test(found.entity)) {
              try {
                console.log(`[timers] entity generic dump (type=${found.entity}):`, JSON.stringify(found.generic));
              } catch(_) {}
            }
          }

          // Accept utcRefresh first, then displayInfo.utcTarget, then statics.minutesNeeded.
          const statics    = generic?.statics;
          const minutesNeeded = _staticsGet(statics, 'minutesNeeded');
          const minutesFbk = minutesNeeded
            ? (clickedAt + Number(minutesNeeded) * 60_000) : null;
          const utcRefresh = generic?.utcRefresh || generic?.displayInfo?.utcTarget
            || minutesFbk || null;

          if (!utcRefresh || utcRefresh <= Date.now()) {
            // Entity is idle/done — if we had a tracked timer for this mid, it was collected.
            if (_actTimers.has(midStr)) {
              const old = _actTimers.get(midStr);
              _actTimers.delete(midStr);
              _notifiedTimerIds.delete(midStr);
              console.log(`[timers] collected (entity idle on poll): ${old.itemLabel} on ${old.landLabel}`);
              _syncTimers();
            }
            if (attempts >= maxTries) {
              clearInterval(poll);
              // Batch "empty/idle plot" logs instead of one line per click
              _emptyPlotBatchCount++;
              _logEmptyPlotBatch();
            }
            return;
          }

          clearInterval(poll);

          const existing = _actTimers.get(midStr);
          if (existing && existing.readyAt === utcRefresh) return; // same timer already tracked

          const mapId       = getScene()?.stateManager?.mapId ?? 'unknown';
          const entityLabel = _entityLabelFor(found.entity);
          const pKey        = mapId + ':' + midStr;
          const fruitItem   = _staticsGet(statics, 'fruitItem') ?? null;
          const seedItemId  = _staticsGet(statics, 'seedItem') ?? _plotSeeds[pKey] ?? null;
          const itemLabel   = _resolveCropLabel(fruitItem, seedItemId);
          const landLabel   = _landLabelFor(mapId);
          const timer = {
            entityMid: midStr, entityLabel, source: 'crop', itemLabel, landLabel,
            mapId: String(mapId), startedAt: Date.now(), readyAt: utcRefresh,
          };
          _actTimers.set(midStr, timer);
          _notifiedTimerIds.delete(midStr);
          console.log(`[timers] started: ${itemLabel} on ${landLabel}, ready at ${new Date(utcRefresh).toISOString()}`);
          _syncTimers();

        } catch (e) {
          console.error('[timers] error in poll:', e);
          if (attempts >= maxTries) clearInterval(poll);
        }
      }, 500);
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
    // Expose to module-level extractTaskboardItems (which can't reach inside startPolling).
    _taskboardFindItemId = _findItemId;

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

        // Build direct itemId → display name map for timer labels
        const idToName = {};
        for (const [k, displayName] of Object.entries(rawI18n)) {
          if (typeof displayName !== 'string') continue;
          if (!k.endsWith('_name')) continue;
          const id = k.slice(0, -5);
          if (id.startsWith('itm_') && !idToName[id]) idToName[id] = displayName;
        }
        _itemIdToName = idToName;
        console.log(`[timers] catalog size=${Object.keys(idToName).length}`);
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
      // Global 429 backoff — stop all market fetches until the backoff window expires.
      if (_marketBackoffUntil > Date.now()) {
        console.log(TAG, '[market] _fetchMpPriceFull: skipped (429 backoff until',
          new Date(_marketBackoffUntil).toISOString() + ')');
        return null;
      }
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
        _lastMarketReqAt = Date.now();
        const res = await _origFetch(url, { headers: hdrs });
        console.log(TAG, '[market] _fetchMpPriceFull:', itemId, 'status=' + res.status);
        if (!res.ok) {
          if (res.status === 429) {
            _marketBackoffUntil = Date.now() + _MARKET_BACKOFF_MS;
            console.log(TAG, '[market] 429 received — halting all market fetches for 5 min');
          }
          return null;
        }
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
    let _priceRefreshScheduledFor     = 0; // prevents repeated calls from the 200 ms poll

    async function _refreshTaskboardPrices(calledFrom) {
      // Mutex: only one refresh running at a time.
      if (_refreshPricesRunning) {
        console.log(TAG, '[market] _refreshTaskboardPrices skip — already running (from:', calledFrom + ')');
        return;
      }
      // Min-gap: at least 60 s between runs.
      const sinceLastRun = Date.now() - _refreshPricesLastRan;
      if (_refreshPricesLastRan > 0 && sinceLastRun < _REFRESH_PRICES_MIN_GAP_MS) {
        return;
      }
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

      _refreshPricesRunning = true;
      try {
        const names = [...new Set(items.map(i => i.itemName))];
        console.log(TAG, '[market] item names to resolve (' + names.length + '):', names.join(', '));

        const lib = await _fetchLibItems();
        console.log(TAG, '[market] lib available:', !!lib, lib ? Object.keys(lib).length + ' entries' : '');

        // Sequential with ~1.5 s gap to avoid bursting the marketplace endpoint.
        for (const name of names) {
          if (_marketBackoffUntil > Date.now()) {
            console.log(TAG, '[market] _refreshTaskboardPrices: aborting mid-run due to 429 backoff');
            break;
          }
          const itemId = _findItemId(name);
          if (!itemId) {
            console.log(TAG, '[market] name→id: "' + name + '" → NO MATCH');
            continue;
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
          // Shared gate: respect global 2.5 s minimum between marketplace requests.
          const _mwait = _lastMarketReqAt + _MARKET_REQ_GAP_MS - Date.now();
          if (_mwait > 0) await new Promise(r => setTimeout(r, _mwait));
        }

        _pricesRefreshedForCapturedAt = capturedAt;
        _refreshPricesLastRan = Date.now();
        console.log(TAG, '[market] done. marketPrices keys:', Object.keys(ctx.marketPrices));
      } finally {
        _refreshPricesRunning = false;
      }
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

    // Rate-limit state: shared by taskboard refresh and collector.
    let _marketBackoffUntil      = 0;           // all market fetches halted until this timestamp
    let _lastMarketReqAt         = 0;           // shared gate: 1 marketplace request per 2.5 s
    let _refreshPricesRunning    = false;        // mutex: only one _refreshTaskboardPrices at a time
    let _refreshPricesLastRan    = 0;            // timestamp of last completed run
    const _REFRESH_PRICES_MIN_GAP_MS = 60_000;  // minimum 60 s between taskboard refreshes
    const _MARKET_BACKOFF_MS         = 5 * 60_000; // 5 min halt on any 429
    const _MARKET_REQ_GAP_MS         = 2_500;   // global minimum gap between any two marketplace requests

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
      if (_marketBackoffUntil > Date.now()) {
        console.log(TAG, '[market] collector: skipping tick (429 backoff)');
        return;
      }
      if (Date.now() - _lastMarketReqAt < _MARKET_REQ_GAP_MS) return;

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
      try {
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
          // Restore plot→seed map
          if (d.plotSeeds && typeof d.plotSeeds === 'object') {
            Object.assign(_plotSeeds, d.plotSeeds);
            console.log('[timers] plot seeds restored:', Object.keys(_plotSeeds).length);
          }
          // Restore stored activity timers; notify about any that finished while away
          try {
            if (Array.isArray(d.activityTimers)) {
              const now = Date.now();
              const pastDue = [];
              for (const t of d.activityTimers) {
                if (!t?.entityMid) continue;
                _actTimers.set(String(t.entityMid), t);
                if (t.readyAt <= now) pastDue.push(t);
              }
              if (pastDue.length > 0) {
                const byLand = {};
                for (const t of pastDue) {
                  (byLand[t.landLabel] ??= []).push(t.itemLabel);
                }
                const parts = Object.entries(byLand)
                  .map(([land, items]) => `on ${land}: ${items.join(', ')}`)
                  .join('; ');
                saveToCompanion('companionEvent', {
                  type: 'awayTimers',
                  message: `While you were away, your timers completed — please collect: ${parts}.`,
                });
              }
            }
          } catch (e) { console.error('[timers] error loading stored timers:', e); }
        }
      } catch (_) {}
    });

    // Best-effort search for the taskboard board-reset countdown.
    // Looks for a leaf element with EXACTLY "HH:MM:SS" text near the panel root.
    // Returns remaining ms or null (caller falls back to nextUtcMidnight()).
    function readTaskboardCountdownMs() {
      try {
        const storeEl = findTaskboardContainer();
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
      petAvatar:          null,           // GPlayerCore.petAvatar — active pet id/name, or null
      hasPet:             null,           // true/false once active-pet status known; null = not yet seen
      petNames:           [],             // pet name(s) if available
    };

    let displayNameCaptured = false;

    // Previous player coords and movement state for walking animation.
    let prevPlayerX = null;
    let prevPlayerY = null;
    let currentFacing = 'right';
    let lastMoveTime = 0; // Date.now() of last detected movement, for stop debounce

    // Push a snapshot whenever player position is known (not just when energy loads).
    setInterval(() => {
      try {
        if (ctx.energy !== null || Object.keys(ctx.skills).length > 0 || ctx.playerX !== null) {
          saveToCompanion('playerContext', { ...ctx });
        }
      } catch (_) {}
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
    let _petSingleLogged     = false; // one-shot log of selfPlayer.pet active-pet check
    let _petCoreLogged       = false; // one-shot log of GPlayerCore keys
    let _lastSessionId       = null;  // detect map transitions (room.sessionId change)
    const _loggedRooms       = new Set(); // roomIds already diagnosed (one-time per room)
    let lastEnergy;

    // ---- Chest / storage cache -----------------------------------------------
    const _chestCache             = {};      // { [mid]: { items, size, capturedAt, source, ... } }
    let _openingChestMid          = null;    // mid of most recently opened chest (for backup path)
    const _loggedMsgTypes         = new Set(); // one log per incoming room message type
    let _lastStorageHash          = '';      // diff guard for openWindow backup poller
    let _storageShapeLogged       = false;   // one-shot raw slot shape diagnostic
    let _lastSelfPlayerChestHash  = '';      // diff guard for selfPlayer.entities scanner
    const _chestFromSelfPlayer    = new Set(); // mids known from selfPlayer scan

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

        // Active pet — selfPlayer.pet is the equipped pet object (tokenId, stage, happiness, avatar…).
        // hasPet = selfPlayer.pet non-null; never send the raw object (may contain wallet address).
        if (ctx.hasPet == null) {
          const activePet = selfPlayer?.pet;
          if (activePet != null) {
            if (!_petSingleLogged) {
              _petSingleLogged = true;
              console.log(TAG, '[pet] selfPlayer.pet detected — keys:',
                activePet && typeof activePet === 'object' ? Object.keys(activePet).join(', ') : typeof activePet);
            }
            ctx.hasPet = true;
            const petName = activePet?.name ?? activePet?.type ?? activePet?.petType
              ?? (typeof activePet === 'string' ? activePet : null);
            if (petName && !ctx.petNames.includes(petName)) ctx.petNames = [petName];
          } else {
            if (!_petSingleLogged) {
              _petSingleLogged = true;
              console.log(TAG, '[pet] no selfPlayer.pet — keys:', Object.keys(selfPlayer ?? {}).join(', '));
            }
            ctx.hasPet = false;
          }
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
          if (window.PX_COMPANION_DEBUG) window.__pxSelf = getScene()?.stateManager?.selfPlayer;

          // Diagnostic helper — always available, no debug flag needed.
          // Run window.__pxPets() in DevTools console to inspect pet state.
          window.__pxPets = function() {
            const selfPlayer = getScene()?.stateManager?.selfPlayer;
            const room = getScene()?.stateManager?.room ?? _room;
            const sessionId = room?.sessionId ?? null;
            const coreEntry = (sessionId && room?.state?.players)
              ? (typeof room.state.players.get === 'function'
                  ? room.state.players.get(sessionId)
                  : room.state.players[sessionId])
              : null;
            const selfKeys = selfPlayer ? Object.keys(selfPlayer) : [];
            const coreKeys = coreEntry ? Object.keys(coreEntry) : [];
            const petFields = {};
            for (const k of selfKeys) {
              if (k.toLowerCase().includes('pet')) petFields[k] = selfPlayer[k];
            }
            for (const k of coreKeys) {
              if (k.toLowerCase().includes('pet')) petFields['core_' + k] = coreEntry[k];
            }
            return { selfKeys, coreKeys, petAvatar: coreEntry?.petAvatar ?? null, petFields };
          };

          // One-time room diagnostic (state keys, MapSchema sizes, storage search).
          if (!_loggedRooms.has(_sessionId)) {
            _loggedRooms.add(_sessionId);
            _logRoomDiagnostic(_room, _sessionId);
            // Unlock land report for this mapId only after the new room is confirmed.
            _landReportAllowedMapId = getScene()?.stateManager?.mapId ?? null;
            console.log('[land-report] NEW ROOM confirmed, unlocked for mapId=' + _landReportAllowedMapId);
            // Scan statics on new room so crop timers appear immediately on warp.
            setTimeout(_scanStaticsCraftTimers, 500);
          }
        }

        const _coreEntry = (_sessionId && _room?.state?.players)
          ? (typeof _room.state.players.get === 'function'
              ? _room.state.players.get(_sessionId)
              : _room.state.players[_sessionId])
          : null;

        if (_coreEntry) {
          // One-time GPlayerCore key dump for diagnostics (pet fields, owned-pets path)
          if (!_petCoreLogged) {
            _petCoreLogged = true;
            ctx._coreKeyLogged = true;
            console.log(TAG, '[pet-core] GPlayerCore ALL keys:', Object.keys(_coreEntry).join(', '));
          }
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

          // Active pet — GPlayerCore.petAvatar holds the equipped pet.
          const petAvatarRaw = _coreEntry.petAvatar ?? _coreEntry.pet ?? null;
          if (petAvatarRaw != null) {
            const petId = petAvatarRaw?.id ?? petAvatarRaw?.petId ?? petAvatarRaw?.nftId
              ?? (typeof petAvatarRaw === 'string' ? petAvatarRaw : null);
            if (petId != null) ctx.petAvatar = petId;
            ctx.hasPet = true;  // petAvatar confirms active pet
            if (!ctx._petCoreLogged) {
              ctx._petCoreLogged = true;
              console.log(TAG, '[pet-core] petAvatar raw:', petAvatarRaw,
                'keys:', petAvatarRaw && typeof petAvatarRaw === 'object' ? Object.keys(petAvatarRaw) : 'n/a',
                'resolved id:', petId);
            }
          }
        } else if (!_petCoreLogged && _sessionId) {
          // coreEntry not found yet — log once so we know room.state.players shape
          _petCoreLogged = true;
          const playersType = _room?.state?.players ? typeof _room.state.players : 'no_players';
          console.log(TAG, '[pet-core] coreEntry not found — sessionId:', _sessionId, 'room.state.players type:', playersType,
            'state keys:', _room?.state ? Object.keys(_room.state).join(', ') : 'no_state');
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
        const container = document.querySelector('[class*="offersList"]');
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
      } catch (e) {
        if (!_pollErrorLogged.has('stacked-poller')) {
          _pollErrorLogged.add('stacked-poller');
          console.error(TAG, '[stacked] poller error (logged once):', e);
        }
      }
    }, 200);

    // ---- Taskboard / Store panel — extraction + diff + cache -----------------
    // Polls the items-content container every 200 ms using multi-strategy detection.
    // Strategy order: exact hashed class → wildcard class → React-fiber scan from presentUI signal.
    // Keyed by "itemName|quantityNeeded" — NOT tier, because tier starts as '' and fills
    // in within the same render cycle, which would produce false appeared/removed events.
    // canDeliverNow flip true → dedicated event type.
    // When the panel is closed the last live snapshot is served from _taskboardCache,
    // returning [] if taskboardExpiresAt has passed (board refreshed while away).
    function taskboardItemKey(item)  { return `${item.itemName}|${item.quantityNeeded}`; }
    function taskboardItemJson(item) { return JSON.stringify(item); }
    let lastTaskboardSnapshot = null; // Map<"itemName|tier", serialised JSON>

    // Multi-strategy container finder. Returns { el, via } or null.
    function findTaskboardContainer() {
      // Strategy 1: wildcard class attribute — matches any hash variant of items-content.
      // (Store.module.scss: class name "items-content" is stable; only the 5-char hash changes on redeploy.)
      // There may be multiple matches (Buy / Sell / Orders tabs): prefer whichever has
      // cards with the "order" class modifier (StoreOrderItemCard wraps in styles.order),
      // then whichever has any store-item-container cards, then first match.
      const allContentEls = [...document.querySelectorAll('[class*="items-content"]')];
      if (allContentEls.length > 0) {
        if (allContentEls.length !== _itemsContentCountLogged) {
          _itemsContentCountLogged = allContentEls.length;
          console.log(`[taskboard] [class*="items-content"] matched ${allContentEls.length} element(s):`,
            allContentEls.map(e => [...e.classList].join(' ')));
        }
        const cardSel = '[class*="store-item-container"], [class*="StoreItem"]';
        // Prefer the tab that has cards carrying the "order" class (the Orders tab).
        let best = allContentEls.find(el =>
          el.querySelector('[class*="store-item-container"][class*="order"],[class*="StoreItem"][class*="order"]')
        );
        // Fall back to any tab that has store-item-container cards.
        if (!best) best = allContentEls.find(el => el.querySelector(cardSel));
        // Last resort: first match in DOM order.
        if (!best) best = allContentEls[0];
        const cardCount = [...best.querySelectorAll(cardSel)].length;
        return { el: best, via: `wildcard-class([class*="items-content"],${allContentEls.length} matched,${cardCount} cards)` };
      }

      // Strategy 2: look for a sibling of the title that looks like a taskboard grid.
      // The taskboard modal typically has a heading containing "taskboard" or "orders".
      const headings = [...document.querySelectorAll('h1,h2,h3,[class*="title"],[class*="Title"]')]
        .filter(h => /taskboard|orders|store/i.test(h.textContent));
      for (const h of headings) {
        // Walk up to a modal root, then down for a scrollable list container.
        let root = h.parentElement;
        for (let i = 0; i < 5 && root; i++, root = root.parentElement) {
          const candidate = root.querySelector('[class*="content"],[class*="list"],[class*="items"]');
          if (candidate && candidate !== h) return { el: candidate, via: 'heading-sibling-scan' };
        }
      }

      // Strategy 3: presentUI signal — if str_taskBoard_01 was seen recently, try a wider scan.
      const lastTB = _recentPresentUIEvents.findLast?.(e => e.ui === 'str_taskBoard_01') ??
        [..._recentPresentUIEvents].reverse().find(e => e.ui === 'str_taskBoard_01');
      if (lastTB && Date.now() - lastTB.ts < 10_000) {
        const candidate = document.querySelector('[class*="Store"],[class*="store"],[class*="Board"]');
        if (candidate) return { el: candidate, via: 'presentUI-str_taskBoard_01-fallback' };
      }

      return null;
    }

    // Build a full debug snapshot from a live container+cards. Used by the auto-snapshot
    // and by __pxTaskboardDebug() when the panel is open.
    function _buildTaskboardSnapshot(result) {
      const cardSel   = '[class*="store-item-container"], [class*="StoreItem"]';
      const cards     = [...result.el.querySelectorAll(cardSel)];
      const firstCard = cards[0] ?? null;

      let firstCardFibers = [];
      if (firstCard) {
        const fk = Object.keys(firstCard).find(k => k.startsWith('__reactFiber$'));
        if (fk) {
          let fiber = firstCard[fk];
          for (let i = 0; i < 8 && fiber; i++) {
            try {
              const mp = fiber.memoizedProps;
              firstCardFibers.push({
                level: i,
                propsKeys:   mp ? Object.keys(mp) : null,
                propsValues: mp ? JSON.stringify(mp).slice(0, 500) : null,
              });
            } catch (_) { firstCardFibers.push({ level: i, error: true }); }
            fiber = fiber.return;
          }
        }
      }

      const allContentEls = [...document.querySelectorAll('[class*="items-content"]')];

      return {
        ts:                    new Date().toISOString(),
        containerFound:        true,
        detectedVia:           result.via,
        containerClasses:      [...result.el.classList],
        allItemsContentCount:  allContentEls.length,
        allItemsContentClasses: allContentEls.map(e => [...e.classList].join(' ')),
        cardCount:             cards.length,
        cardClasses:           firstCard ? [...firstCard.classList] : [],
        recentPresentUIEvents: _recentPresentUIEvents.slice(-10),
        lastDetectedVia:       _taskboardDetectedVia,
        cachedOrders:          ctx.taskboard?.length ?? 0,
        firstCardInnerText:    firstCard?.innerText?.slice(0, 500) ?? null,
        firstCardOuterHTML:    firstCard?.outerHTML?.slice(0, 1500) ?? null,
        firstCardFibers,
      };
    }

    // Expose debug helper — always available, no debug flag required.
    // Returns a live snapshot when the panel is open; returns the last stored
    // auto-snapshot (from when cards were last visible) when the panel is closed.
    window.__pxTaskboardDebug = function() {
      const result = findTaskboardContainer();
      if (result) {
        const snap = _buildTaskboardSnapshot(result);
        return snap;
      }
      if (_lastTaskboardDebugSnapshot) {
        return Object.assign({}, _lastTaskboardDebugSnapshot, { _note: 'panel closed — last-open snapshot' });
      }
      return {
        containerFound:        false,
        detectedVia:           null,
        recentPresentUIEvents: _recentPresentUIEvents.slice(-10),
        lastDetectedVia:       _taskboardDetectedVia,
        cachedOrders:          ctx.taskboard?.length ?? 0,
        _note:                 'panel not open and no snapshot yet this session',
      };
    };

    setInterval(() => {
      try {
        const found = findTaskboardContainer();
        const container = found?.el ?? null;
        if (!container) {
          if (_taskboardDetectedVia !== null) {
            console.log('[taskboard] detection failed: no matching container (was:', _taskboardDetectedVia, ')');
            _taskboardDetectedVia = null;
          }
          // Panel closed — serve cached snapshot if present (empty if board expired).
          if (_taskboardCache) {
            const now = Date.now();
            const expired = _taskboardCache.expiresAt !== null && _taskboardCache.expiresAt <= now;
            ctx.taskboard           = expired ? [] : _taskboardCache.items;
            ctx.taskboardCapturedAt = _taskboardCache.capturedAt;
            ctx.taskboardExpiresAt  = _taskboardCache.expiresAt;
            // Fetch prices for the cached snapshot if not yet done for this version.
            // Use _priceRefreshScheduledFor so this fires at most once per capturedAt,
            // even though this branch runs every 200 ms while the panel is closed.
            if (!expired &&
                _taskboardCache.capturedAt !== _pricesRefreshedForCapturedAt &&
                _taskboardCache.capturedAt !== _priceRefreshScheduledFor) {
              _priceRefreshScheduledFor = _taskboardCache.capturedAt;
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

        // Log once when detection strategy changes (new panel open or selector changed).
        if (found.via !== _taskboardDetectedVia) {
          console.log('[taskboard] panel open detected via', found.via);
          _taskboardDetectedVia = found.via;
        }

        // NOTE: the container element does not need a __reactFiber$ key.
        // Extraction walks fibers on individual CARD elements, not the container.
        // Log once if missing (informational only — do NOT return early).
        const fiberKey = Object.keys(container).find(k => k.startsWith('__reactFiber$'));
        if (!fiberKey && !_fiberMissingLogged.has(container)) {
          console.log('[taskboard] note: container has no __reactFiber$ key — using card-level fibers', found.via);
          _fiberMissingLogged.add(container);
        }

        // Auto-snapshot: once per session as soon as cards are visible.
        // Fires regardless of whether extraction succeeds — always captures raw DOM state.
        const cardSel0 = '[class*="store-item-container"], [class*="StoreItem"]';
        const cardCount0 = [...container.querySelectorAll(cardSel0)].length;
        if (!_taskboardAutoSnapshotDone && cardCount0 > 0) {
          _taskboardAutoSnapshotDone = true;
          try {
            const snap = _buildTaskboardSnapshot(found);
            _lastTaskboardDebugSnapshot = snap;
            console.log('[taskboard] SNAPSHOT', JSON.stringify(snap));
          } catch (snapErr) {
            console.log('[taskboard] SNAPSHOT ERROR', snapErr?.message ?? snapErr, snapErr?.stack ?? '');
          }
        }

        const capturedAt  = Date.now();
        const items       = extractTaskboardItems(container);
        const extractVia  = items._via || 'unknown';

        // Log once when extracted count or extraction method changes (not every 200ms poll).
        if (items.length !== _taskboardLastLoggedCount || extractVia !== _taskboardLastLoggedVia) {
          console.log(`[taskboard] extracted ${items.length} orders (via ${extractVia})`);
          _taskboardLastLoggedCount = items.length;
          _taskboardLastLoggedVia   = extractVia;
        }

        // When cards are present but extraction returned nothing, log the exact failure reason.
        if (cardCount0 > 0 && items.length === 0 && items._firstCardFailReason) {
          console.log(`[taskboard] card 1 parse failed: ${items._firstCardFailReason}`);
        }
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
      } catch (e) {
        console.log('[taskboard] ERROR', e?.message ?? String(e), e?.stack ?? '');
      }
    }, 200);

    // ---- Crafting detail panel — extraction + persist ------------------------
    // Polls .Crafting_PageDetails__tYqnD every 200 ms.
    // Diff key: itemName + canCraftNow + sum of haveQuantity values, so we fire
    // on both "new recipe selected" and "material quantity changed for same recipe".
    // Each change saves to storage, accumulating the recipe catalog over time.
    let lastCraftingKey = null;

    setInterval(() => {
      try {
        const panel = document.querySelector('[class*="Crafting_PageDetails"],[class*="crafting_page-details"],[class*="CraftingPageDetails"]');
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
        _lastViewedRecipe = recipe;
        lastCraftingKey = diffKey;
      } catch (e) {
        if (!_pollErrorLogged.has('crafting-poller')) {
          _pollErrorLogged.add('crafting-poller');
          console.error(TAG, '[crafting] poller error (logged once):', e);
        }
      }
    }, 200);

    // ---- React fiber: Merchant Boat panel ------------------------------------
    // Selector targets the subheader element of the Merchant Boat store.
    let merchantFiberDumped = false;

    setInterval(() => {
      try {
        const props = readFiberPanel(
          '[class*="MerchantBoatStore_subheader"],[class*="merchantboatstore_subheader"],[class*="merchant-boat"] [class*="subheader"]',
          'Merchant Boat panel'
        );
        if (!props || merchantFiberDumped) return;
        console.log(TAG, 'Merchant Boat panel fiber props (shape dump):', props);
        merchantFiberDumped = true;
      } catch (_) {}
    }, 200);

    // ---- room.send wrapper — re-wraps on every new room ----------------------
    // stateManager.room is established asynchronously after game init and
    // changes after each warp.  We keep the interval running and re-wrap
    // whenever the room object changes.
    let _wrappedRoom = null;
    setInterval(() => {
      try {
        const room = getScene()?.stateManager?.room;
        if (!room || room === _wrappedRoom) return;
        _wrappedRoom = room;
        const mapId = getScene()?.stateManager?.mapId ?? 'unknown';

        // Wrap outgoing sends; callback fires on storage-open actions.
        wrapRoomSend(room, getScene, (action, mid, params) => {
          if (mid) {
            _openingChestMid = mid;
            console.log(TAG, '[room][storage] player opening chest', { action, mid });
          } else {
            console.log(TAG, '[room][storage] storage action (no mid found)', { action, params });
          }
        });
        console.log(TAG, `room.send wrapped for ${mapId} — action detection active.`);

        // Timer detection — second wrapper logs qualifying actions and starts a poll.
        try {
          const _timerWrappedSend = room.send;
          room.send = function (...args) {
            try {
              const act       = typeof args[0] === 'string' ? args[0] : '';
              const capturing = Date.now() < _craftCaptureUntil;
              if (capturing && window.PX_COMPANION_DEBUG) {
                console.log(`[timers] CAPTURE send: ${act}`, JSON.stringify(args[1] ?? null).slice(0, 300));
              }
              if (!_TIMER_IGNORE.has(act)) {
                const p   = (args[1] != null && typeof args[1] === 'object') ? args[1] : {};
                const mid = p.mid ?? p.entityMid ?? p.entity ?? p.id ?? null;
                // Track entity type for station label lookups by presentUI handler
                if (mid != null && typeof p.entity === 'string') {
                  _lastClickEntityInfo.set(String(mid), { typeId: String(p.entity), ts: Date.now() });
                }
                if (!capturing && window.PX_COMPANION_DEBUG) console.log(`[timers] action seen: ${act} ${mid != null ? String(mid) : 'none'}`);
                if (mid != null) {
                  _craftCaptureUntil = Date.now() + 15_000;
                  _pollEntityForTimer(String(mid));
                }
              }
            } catch (e) { console.error('[timers] error in send wrapper:', e); }
            return _timerWrappedSend.apply(this, args);
          };
        } catch (e) { console.error('[timers] error setting up send wrapper:', e); }

        // Hook incoming messages for diagnostics and storage detection.
        if (typeof room.onMessage === 'function') {
          try {
            room.onMessage('*', (type, message) => {
              const _typeStr   = String(type);
              const _capturing = Date.now() < _craftCaptureUntil;
              if (_capturing && window.PX_COMPANION_DEBUG) {
                console.log(`[timers] msg ${_typeStr} ${JSON.stringify(message).slice(0, 300)}`);
              }

              // presentUI: record all events in ring buffer for __pxTaskboardDebug().
              if (_typeStr === 'presentUI' && message && typeof message.ui === 'string') {
                _recentPresentUIEvents.push({ ui: message.ui, ts: Date.now() });
                if (_recentPresentUIEvents.length > 20) _recentPresentUIEvents.shift();
                // str_taskBoard_01 = taskboard panel opened signal.
                if (message.ui === 'str_taskBoard_01') {
                  console.log('[taskboard] presentUI str_taskBoard_01 received — taskboard panel opened');
                  // Reset detection cache so the next poll tries all strategies fresh.
                  _taskboardDetectedVia = null;
                }
              }

              // presentUI: craft station signal
              if (_typeStr === 'presentUI' && message && typeof message.ui === 'string'
                  && message.ui.startsWith('craft:')) {
                try {
                  const params   = Array.isArray(message.params) ? message.params : [];
                  const state    = String(params[1] ?? '');
                  const source   = String(message.source ?? '');
                  const mapId    = String(getScene()?.stateManager?.mapId ?? 'unknown');
                  const timerKey = mapId + ':' + source;
                  const now      = Date.now();

                  if (state === 'update:crafting' || state === 'update:busy') {
                    const finishMs = typeof params[3] === 'number' ? params[3] : null;
                    if (finishMs && finishMs > now) {
                      const skillRaw   = message.ui.slice('craft:'.length);
                      const skillLabel = skillRaw.charAt(0).toUpperCase() + skillRaw.slice(1);
                      const achRaw     = String(params[2] ?? '').replace(/^ach_/i, '');
                      const itemName   = achRaw
                        ? (_catalogName('itm_' + achRaw) ?? _catalogName(achRaw) ?? _prettifyItemId(achRaw))
                        : null;
                      if (achRaw && !itemName && !_loggedCatalogMisses.has(achRaw)) {
                        _loggedCatalogMisses.add(achRaw);
                        console.log(`[timers] catalog miss ${achRaw}`);
                      }
                      const existing      = _actTimers.get(timerKey);
                      const existingAch   = existing?._achId ?? null;
                      const existingItem  = existing?.itemLabel?.includes(' · ')
                        ? existing.itemLabel.split(' · ').slice(1).join(' · ') : null;
                      const resolvedItem  = itemName || existingItem || null;
                      const resolvedAch   = achRaw || existingAch || null;
                      const typeInfo      = source ? _lastClickEntityInfo.get(source) : null;
                      const stationType   = (typeInfo ? _friendlyEntityLabel(typeInfo.typeId) : null) ?? skillLabel;
                      const itemLabel     = resolvedItem ? `${stationType} · ${resolvedItem}` : stationType;
                      const landLabel     = _landLabelFor(mapId);
                      _actTimers.set(timerKey, {
                        entityMid: source, entityLabel: 'craft', source: 'craft',
                        itemLabel, landLabel, mapId, startedAt: now, readyAt: finishMs,
                        _achId: resolvedAch,
                      });
                      _notifiedTimerIds.delete(timerKey);
                      console.log(`[timers] craft: ${itemLabel} on ${landLabel}, ready at ${new Date(finishMs).toISOString()}`);
                      _syncTimers();
                    }
                  } else if (state === 'update:ready') {
                    const existing = _actTimers.get(timerKey);
                    if (existing) {
                      existing.readyAt = Math.min(existing.readyAt, now - 1);
                      _syncTimers();
                      console.log(`[timers] craft ready: ${existing.itemLabel}`);
                    }
                  } else if (state === 'available') {
                    const existing = _actTimers.get(timerKey);
                    if (existing && existing.readyAt <= now) {
                      _actTimers.delete(timerKey);
                      _notifiedTimerIds.delete(timerKey);
                      console.log(`[timers] craft collected (available): ${existing.itemLabel}`);
                      _syncTimers();
                    }
                  } else {
                    if (!_knownPresentUIStates.has(state)) {
                      _knownPresentUIStates.add(state);
                      console.log(`[timers] presentUI state: ${state}`);
                    }
                  }
                } catch (e) { console.error('[timers] presentUI error:', e); }
                return;
              }

              // Hearth Hall season detection — must run before the fast-exit below.
              if (message) {
                const _msgStr = typeof message === 'string' ? message
                  : (typeof message === 'object' ? (message.message ?? message.text ?? message.body ?? '') : '');
                if (/new bountyfall session has begun/i.test(_msgStr)) {
                  console.log('[assistant] Hearth Hall season detected');
                  saveToCompanion('companionEvent', { type: 'hearthHallSeason', data: { detectedAt: Date.now() } });
                }
              }

              // Fast exit for non-storage types outside capture window.
              if (!_capturing && !/storage|chest|container|slot/i.test(_typeStr)) return;
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
      } catch (_) {}
    }, 200);

    // ---- Activity timer check — 5 s interval --------------------------------
    setInterval(() => {
      try {
        const now  = Date.now();
        const room = getScene()?.stateManager?.room;
        let changed = false;
        for (const [mid, timer] of _actTimers) {
          // Collection check: entity is back to idle/no utcRefresh after readyAt
          if (room?.state?.entities && timer.readyAt <= now) {
            let found = null;
            room.state.entities.forEach((e) => { if (String(e?.mid) === mid) found = e; });
            if (found) {
              const utcRefresh = found.generic?.utcRefresh;
              if (!utcRefresh || utcRefresh <= 0) {
                _actTimers.delete(mid);
                _notifiedTimerIds.delete(mid);
                console.log(`[timers] collected: ${timer.itemLabel} on ${timer.landLabel}`);
                changed = true;
                continue;
              }
            }
          }
          // Notify once when timer completes
          if (timer.readyAt <= now && !_notifiedTimerIds.has(mid)) {
            _notifiedTimerIds.add(mid);
            try {
              const verb = timer.itemLabel.match(/s$/i) ? 'are' : 'is';
              saveToCompanion('companionEvent', {
                type: 'timerReady',
                message: `Your ${timer.itemLabel} ${verb} ready on ${timer.landLabel}.`,
              });
            } catch (_) {}
          }
        }
        if (changed) _syncTimers();
      } catch (e) { console.error('[timers] error:', e); }
    }, 5000);

    // ---- Catalog early load — ensures timer labels are ready from the start ----
    setTimeout(() => {
      _fetchLibItems().then(() => {
        const n = Object.keys(_itemIdToName).length;
        if (n > 0) _relabelTimers();
      }).catch(() => {});
    }, 5_000);

    // ---- Statics craft timer scan — 10 s interval ----------------------------
    setInterval(_scanStaticsCraftTimers, 10_000);

    // ---- selfPlayer.entities → chest contents (PRIMARY source) — 2 s interval ---
    // selfPlayer is GPlayerFull; its .entities MapSchema contains every chest
    // (GPlayerEntity) this player has ever opened, with storage.slots populated.
    // This replaces "capture on open" and requires NO action on the player's behalf.
    setInterval(() => {
      try {
        const selfPlayer = getScene()?.stateManager?.selfPlayer;
        if (!selfPlayer) return;

        const entities = selfPlayer.entities;
        if (!entities) return;

        const room        = getScene()?.stateManager?.room;
        const mapId       = getScene()?.stateManager?.mapId ?? null;
        const mapEntities = room?.state?.entities;

        const newEntries = {};

        // Colyseus MapSchema: try .forEach first, then .$items
        const doForEach = typeof entities.forEach === 'function'
          ? (cb) => entities.forEach(cb)
          : (entities.$items ? (cb) => entities.$items.forEach(cb) : null);
        if (!doForEach) return;

        doForEach((playerEntity, mid) => {
          if (!playerEntity?.storage) return;
          if (playerEntity.storage.transient) return; // skip trash bins
          const slots = playerEntity.storage.slots;
          if (!slots) return;

          const items = [];
          const slotForEach = typeof slots.forEach === 'function'
            ? (cb) => slots.forEach(cb)
            : (slots.$items ? (cb) => slots.$items.forEach(cb) : null);
          if (!slotForEach) return;

          slotForEach((slot) => {
            const itemId = slot?.item?.id ?? slot?.item ?? slot?.itemId ?? null;
            if (itemId == null) return;
            const qty = typeof slot?.quantity === 'number' ? slot.quantity : 0;
            items.push({ itemId: String(itemId), qty });
          });

          const midStr = String(mid);
          const mapEnt = mapEntities
            ? (typeof mapEntities.get === 'function' ? mapEntities.get(midStr) : null)
            : null;

          const entityType  = playerEntity.entity ?? mapEnt?.entity ?? null;
          const storageName = playerEntity.storage.name ?? mapEnt?.storage?.name ?? null;
          const existing    = _chestCache[midStr];
          // playerEntity.mapId is Colyseus-typed — prefer it as authoritative landId
          const entityMapId = playerEntity.mapId ? String(playerEntity.mapId) : null;

          newEntries[midStr] = {
            items,
            size:        playerEntity.storage.size ?? items.length,
            capturedAt:  Date.now(),
            source:      'selfPlayer',
            entityType:  entityType  ? String(entityType)  : null,
            storageName: storageName ? String(storageName) : null,
            landId:      entityMapId ?? (mapEnt ? mapId : null) ?? existing?.landId ?? null,
          };
        });

        const _hashable = {};
        for (const [_m, _e] of Object.entries(newEntries)) {
          _hashable[_m] = { items: _e.items, size: _e.size, entityType: _e.entityType, storageName: _e.storageName, landId: _e.landId };
        }
        const hash = JSON.stringify(_hashable);
        if (hash === _lastSelfPlayerChestHash) return;
        _lastSelfPlayerChestHash = hash;

        // Collect the landIds covered by this scan
        const scannedLandIds = new Set(Object.values(newEntries).map(e => e.landId).filter(Boolean));

        // Remove stale mids: same landId as the current scan but NOT seen in newEntries
        for (const [midStr, entry] of Object.entries(_chestCache)) {
          if (scannedLandIds.has(entry.landId) && !newEntries[midStr]) {
            delete _chestCache[midStr];
            _chestFromSelfPlayer.delete(midStr);
            saveToCompanion('chestCacheDelete', { mid: midStr });
          }
        }

        // Merge into _chestCache (entries for other maps not yet in selfPlayer are kept)
        for (const [midStr, entry] of Object.entries(newEntries)) {
          _chestCache[midStr] = entry;
          _chestFromSelfPlayer.add(midStr);
        }
        ctx.storageChests = { ..._chestCache };

        const chestCount = Object.keys(newEntries).length;
        const byMapId = {};
        for (const e of Object.values(newEntries)) {
          const loc = e.landId ?? '(unknown)';
          byMapId[loc] = (byMapId[loc] ?? 0) + 1;
        }
        const mapSummary = Object.entries(byMapId).map(([m, n]) => `${m}×${n}`).join(', ');
        console.log(TAG, `[storage] selfPlayer scan: ${chestCount} chest${chestCount !== 1 ? 's' : ''} on ${Object.keys(byMapId).length} location${Object.keys(byMapId).length !== 1 ? 's' : ''} — ${mapSummary} (current map only; other locations load from saved cache)`);

        // Persist each updated chest to chrome.storage.local via content.js
        for (const [midStr, entry] of Object.entries(newEntries)) {
          saveToCompanion('chestCache', { mid: midStr, ...entry });
        }
      } catch (_) {}
    }, 2000);

    // ---- room.state.storage — backup while chest window is open — 2 s interval -
    // Only fires when _openingChestMid is set (player has a chest window open)
    // AND selfPlayer scan hasn't already provided data for that mid.
    setInterval(() => {
      try {
        if (!_openingChestMid) return;
        if (_chestFromSelfPlayer.has(_openingChestMid)) return;

        const room    = getScene()?.stateManager?.room;
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
          if (!_storageShapeLogged) {
            console.log(TAG, '[storage] openWindow: storage cleared or empty');
          }
          return;
        }

        if (!_storageShapeLogged) {
          _storageShapeLogged = true;
          storage.forEach((slot, key) => {
            try {
              console.log(TAG, '[storage] openWindow raw slot shape', {
                key, keys: Object.keys(slot ?? {}), json: JSON.stringify(slot).slice(0, 300),
              });
            } catch (_) {}
          });
        }

        const mid    = _openingChestMid;
        const mapId  = getScene()?.stateManager?.mapId ?? null;
        const existing = _chestCache[mid];
        const entry  = {
          items, size: storage.size ?? items.length,
          capturedAt: Date.now(), source: 'openWindow',
          landId: existing?.landId ?? mapId,
        };
        _chestCache[mid]  = entry;
        ctx.storageChests = { ..._chestCache };
        console.log(TAG, `[storage] openWindow: ${items.length} items, mid=${mid}, source=openWindow`);
        saveToCompanion('chestCache', { mid, ...entry });
      } catch (_) {}
    }, 2000);

    // ---- Texture census — debug-only, one-shot, fires 5 s after game capture --
    if (window.PX_COMPANION_DEBUG) setTimeout(() => {
      try {
        const textures = game.textures;
        if (!textures) {
          console.log(TAG, 'texture census: textures manager unavailable');
          return;
        }

        const allKeys = textures.getTextureKeys();
        const matches = allKeys.filter(k => /player|avatar|char|sprite|npc/i.test(k));

        console.log(TAG, `texture census: ${allKeys.length} textures loaded, ${matches.length} regex matches`);
        console.log(TAG, 'texture census all keys:', allKeys);

        matches.forEach(key => {
          const tex = textures.get(key);
          const src = tex.source[0];
          const sheetW = src?.width  ?? '?';
          const sheetH = src?.height ?? '?';

          const frameNames = tex.getFrameNames(false);
          const frameCount = frameNames.length;

          let frameW = '?', frameH = '?';
          if (frameCount > 0) {
            const f = tex.get(frameNames[0]);
            frameW = f?.realWidth  ?? f?.width  ?? '?';
            frameH = f?.realHeight ?? f?.height ?? '?';
          } else {
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
    // Fires on the first tick that entities are ready (catches page-load-on-land),
    // then on every change.  Logs [land-report] at each decision point so Lizzy
    // can filter the DevTools console to "land-report" and see exactly what happens.
    let lastLandSnapshotKey      = null;
    let landSnapshotSkipNote     = '';   // tracks last skip reason to avoid log spam
    let _landReportAllowedMapId  = null; // set only when NEW ROOM is confirmed
    let _landCensusLoggedMapId   = null; // track which mapId had its census logged

    setInterval(() => {
      try {
        const room = getScene()?.stateManager?.room;
        if (!room?.state?.entities) {
          if (landSnapshotSkipNote !== 'no-entities') {
            landSnapshotSkipNote = 'no-entities';
            console.log('[land-report] skipped: room.state.entities not ready yet');
          }
          return;
        }

        const mapId = getScene()?.stateManager?.mapId;
        if (!mapId) {
          if (landSnapshotSkipNote !== 'no-mapid') {
            landSnapshotSkipNote = 'no-mapid';
            console.log('[land-report] skipped: no mapId from stateManager');
          }
          return;
        }

        // Guard: only send report after NEW ROOM has been confirmed for this mapId.
        if (mapId !== _landReportAllowedMapId) {
          if (landSnapshotSkipNote !== 'waiting-new-room') {
            landSnapshotSkipNote = 'waiting-new-room';
            console.log('[land-report] skipped: waiting for NEW ROOM confirmation for mapId=' + mapId);
          }
          return;
        }

        // Log top-15 entity typeIds once per land visit (debug only).
        if (window.PX_COMPANION_DEBUG && _landCensusLoggedMapId !== mapId) {
          _landCensusLoggedMapId = mapId;
          try {
            const typeCounts = {};
            room.state.entities.forEach(e => {
              const t = String(e?.entity ?? 'unknown');
              typeCounts[t] = (typeCounts[t] ?? 0) + 1;
            });
            const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
            console.log('[land-report] entity census for ' + mapId + ' (top 15):',
              sorted.map(([t, c]) => t + '×' + c).join(', '));
          } catch (_) {}
        }

        landSnapshotSkipNote = '';   // clear once we have valid state

        const industries  = readIndustryState(room) ?? [];
        const permissions = readMapPermissions(room);
        const soilTiers   = readSoilState(room);
        const snapshot    = shapeLandSnapshot(mapId, industries, permissions, soilTiers);
        const key         = landSnapshotKey(snapshot);

        if (key === lastLandSnapshotKey) return;   // stable — no log to avoid spam
        lastLandSnapshotKey = key;

        console.log(`[land-report] sending: land ${mapId}, ${industries.length} industries`);
        saveToCompanion('landSnapshot', snapshot);
        const soilTotal = Object.values(soilTiers).reduce((s, n) => s + n, 0);
        handleStateUpdate('land industry snapshot', {
          landId:        snapshot.landId,
          industryCount: snapshot.industries.length,
          soilCount:     soilTotal,
          observedAt:    snapshot.observedAt,
        });
        console.log(`[land-report] server: snapshot saved for land ${mapId}`);
      } catch (err) {
        console.error('[land-report] error in snapshot:', err);
      }
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
