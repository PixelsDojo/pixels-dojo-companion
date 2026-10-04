// content.js — runs in Chrome's isolated content-script world.
//
// Content scripts share the DOM with the page but get a separate JS environment:
// window.Phaser, game state, etc. are all invisible from here. The only way to
// reach them is to inject a real <script> tag so the browser loads our code as
// a normal page script, inside the page's own JS context.
//
// injected.js is declared in web_accessible_resources so the page is allowed to
// load it from the chrome-extension:// URL.
//
// Bridge: injected.js can't call chrome.storage directly (it runs in the page
// context, not an extension context).  Instead it calls saveToCompanion(), which
// posts a window message with source:"pixels-companion".  This file listens for
// those messages and handles the actual chrome.storage.local reads/writes.

(function () {
  'use strict';

  const TAG = '[Pixels Companion]';

  // Railway backend URL — update this after deployment.
  // Set to an empty string to disable backend reporting without removing any code.
  const BACKEND_URL = 'https://content-hq-production.up.railway.app';

  // ---------------------------------------------------------------------------
  // Inject injected.js into the page's own JS context.
  // ---------------------------------------------------------------------------
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  // Remove the tag from the DOM once the script has loaded — it has already
  // executed by then and leaving it in serves no purpose.
  script.onload = () => script.remove();
  // document.head may not exist yet at document_start; fall back to
  // document.documentElement (the <html> tag), which always exists.
  (document.head || document.documentElement).appendChild(script);

  // ---------------------------------------------------------------------------
  // Storage helpers — thin promise wrappers around chrome.storage.local,
  // namespaced under a single "pixelsCompanion" root key so we never collide
  // with anything else in extension storage.
  //
  // NOTE: storageSetKey and storageUpdateKey use a read-modify-write pattern.
  // If two writes arrive in the same event-loop turn they can race and the
  // second write wins.  This is acceptable for the current use case (single
  // tab, low-frequency writes).  If write frequency increases, switch to a
  // queued writer or chrome.storage.local.get inside the set callback.
  // ---------------------------------------------------------------------------
  const STORAGE_ROOT = 'pixelsCompanion';

  function _extContextOk() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

  /** Resolves with the entire pixelsCompanion root object (never null). */
  function storageGetAll() {
    if (!_extContextOk()) return Promise.resolve({});
    return new Promise(resolve =>
      chrome.storage.local.get(STORAGE_ROOT, result =>
        resolve(result[STORAGE_ROOT] ?? {})));
  }

  /** Resolves with the value of one top-level key inside the root (may be undefined). */
  function storageGetKey(key) {
    return storageGetAll().then(root => root[key]);
  }

  /** Writes one top-level key inside the root, leaving other keys untouched. */
  function storageSetKey(key, value) {
    return storageGetAll().then(root => {
      if (!_extContextOk()) return;
      root[key] = value;
      return new Promise((resolve, reject) =>
        chrome.storage.local.set({ [STORAGE_ROOT]: root }, () =>
          chrome.runtime.lastError
            ? reject(chrome.runtime.lastError)
            : resolve()));
    });
  }

  /**
   * Reads the current value of one top-level key, applies updaterFn to it,
   * and writes the result back.
   * @param {string}   key
   * @param {Function} updaterFn   (currentValue) => nextValue
   * @param {*}        defaultValue  used when the key is absent
   */
  function storageUpdateKey(key, updaterFn, defaultValue = null) {
    return storageGetKey(key).then(current =>
      storageSetKey(key, updaterFn(current ?? defaultValue)));
  }

  /** Deletes one top-level key from the root object. */
  function storageDeleteKey(key) {
    return storageGetAll().then(root => {
      if (!_extContextOk()) return;
      delete root[key];
      return new Promise((resolve, reject) =>
        chrome.storage.local.set({ [STORAGE_ROOT]: root }, () =>
          chrome.runtime.lastError
            ? reject(chrome.runtime.lastError)
            : resolve()));
    });
  }

  // ---------------------------------------------------------------------------
  // Category-specific storage functions.
  //
  // Schemas:
  //   notes:         Array<{id, text, createdAt}>
  //   goals:         Array<{id, description, targetCurrency, targetAmount,
  //                          createdAt, checkpoints: [{date, balance}]}>
  //   timers:        Array<{id, label, fireAt, dismissed}>
  //   hearthhall:    {cycleIndex, cyclesPerBatch, lastCycleDate, shardsAccumulated}
  //   landSnapshots: { [landId]: {landId, observedAt, permissions, industries} }
  // ---------------------------------------------------------------------------

  function makeId() {
    // Short collision-resistant id: ms timestamp in base36 + random suffix.
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  // ---- notes ----------------------------------------------------------------
  function addNote(text) {
    return storageUpdateKey('notes', notes => [
      ...notes,
      { id: makeId(), text, createdAt: new Date().toISOString() },
    ], []);
  }

  // ---- goals ----------------------------------------------------------------
  function addGoal({ description, targetCurrency, targetAmount }) {
    return storageUpdateKey('goals', goals => [
      ...goals,
      {
        id: makeId(),
        description,
        targetCurrency,
        targetAmount,
        createdAt: new Date().toISOString(),
        checkpoints: [],
      },
    ], []);
  }

  // ---- timers ---------------------------------------------------------------
  function addTimer({ label, fireAt }) {
    return storageUpdateKey('timers', timers => [
      ...timers,
      { id: makeId(), label, fireAt, dismissed: false },
    ], []);
  }

  // ---- hearthhall -----------------------------------------------------------
  // Single object — callers write the full shape; default fills in on first use.
  const HEARTHHALL_DEFAULT = {
    cycleIndex:        0,
    cyclesPerBatch:    9,   // confirmed: up to 9 orders active per guild
    lastCycleDate:     null,
    shardsAccumulated: 0,
  };

  function setHearthhall(data) {
    return storageSetKey('hearthhall', { ...HEARTHHALL_DEFAULT, ...data });
  }

  // ---- landSnapshots --------------------------------------------------------
  // Stores the latest snapshot for each land keyed by landId.
  // observedAt (ms epoch) is already in the snapshot — no separate lastSeen.
  function setLandSnapshot(snapshot) {
    if (!snapshot?.landId) return Promise.resolve();
    return storageUpdateKey('landSnapshots', snaps => ({
      ...snaps,
      [snapshot.landId]: snapshot,
    }), {});
  }

  // Fire-and-forget POST to the Railway backend.
  // Errors are logged but never propagate — a network hiccup must not affect
  // the local storage write.
  function reportToBackend(snapshot) {
    if (!BACKEND_URL || !snapshot?.landId) return;
    console.log(TAG, '[land-report] sending', snapshot.landId, 'soilTiers=' + JSON.stringify(snapshot.soilTiers || {}));
    fetch(`${BACKEND_URL}/api/land-report`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(snapshot),
    }).then(r => {
      console.log(TAG, '[land-report] server', r.status);
    }).catch(err => {
      console.warn(TAG, 'land-report: fetch failed', err);
    });
  }

  // ---- recipes --------------------------------------------------------------
  // Object keyed by itemName — each view of a crafting panel upserts the entry
  // for that item and updates lastSeen.  The catalog accumulates across sessions
  // as different recipes are opened, without needing to view everything at once.
  function setRecipe(data) {
    return storageUpdateKey('recipes', recipes => ({
      ...recipes,
      [data.itemName]: data,
    }), {});
  }

  // ---------------------------------------------------------------------------
  // Dispatcher — routes a validated postMessage event to the right writer,
  // then reads back and logs the full root so every write is observable.
  // ---------------------------------------------------------------------------
  async function dispatch(category, data) {
    try {
      // Export is read-only — handle before the write switch so it can return
      // early without triggering the post-write readback log.
      if (category === '__export') {
        const all = await storageGetAll();
        const date = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
        const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `pixels-companion-export-${date}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log(TAG, `exported ${Object.keys(all).length} categories to ${a.download}`);
        return;
      }

      switch (category) {
        case 'note':         await addNote(data.text);     break;
        case 'goal':         await addGoal(data);          break;
        case 'timer':        await addTimer(data);         break;
        case 'hearthhall':   await setHearthhall(data);    break;
        case 'landSnapshot':
          await setLandSnapshot(data);
          reportToBackend(data); // fire-and-forget — does not block storage write
          break;
        case 'recipe':       await setRecipe(data);        break;
        // playerContext — in-memory only; companion UI reads companion.latestPlayerContext
        case 'playerContext':
          companion.latestPlayerContext = data;
          companion.onPlayerContext(data);
          return; // skip post-write readback log
        // companionEvent — forward notable game events to the companion panel
        case 'companionEvent':
          companion.onGameEvent(data);
          return;
        // cameraFrame — live camera data used to position the floating sprite
        case 'cameraFrame':
          companion.onCameraFrame(data);
          return;
        // requestPanelCache — injected.js asks for saved taskboard/stacked/chest snapshots
        case 'requestPanelCache': {
          const pid = data?.playerId ?? 'unknown';

          // Merge backend chests into local cache (backend is source of truth across reinstalls)
          if (pid !== 'unknown') {
            try {
              const resp = await fetch(`${BACKEND_URL}/api/player-storage?playerId=${encodeURIComponent(pid)}`);
              if (resp.ok) {
                const backendChests = await resp.json();
                for (const [mid, chest] of Object.entries(backendChests)) {
                  const localKey = `chestCache_${mid}`;
                  const local = await storageGetKey(localKey);
                  // backend wins if newer or local is absent
                  if (!local || (chest.capturedAt ?? 0) > (local.capturedAt ?? 0)) {
                    await storageSetKey(localKey, chest);
                  }
                }
              }
            } catch (_) { /* offline — use local cache */ }
          }

          const [taskboard, stacked, allStorage, activityTimers, plotSeeds] = await Promise.all([
            storageGetKey(`panelCacheTaskboard_${pid}`),
            storageGetKey(`panelCacheStacked_${pid}`),
            storageGetAll(),
            storageGetKey(`activityTimers_${pid}`),
            storageGetKey('plotSeeds'),
          ]);
          const chestCaches = {};
          for (const [key, val] of Object.entries(allStorage)) {
            if (key.startsWith('chestCache_')) {
              chestCaches[key.slice('chestCache_'.length)] = val;
            }
          }
          window.postMessage({
            source:   'pixels-companion-host',
            category: 'panelCache',
            data:     {
              taskboard:      taskboard      ?? null,
              stacked:        stacked        ?? null,
              chestCaches,
              activityTimers: activityTimers ?? [],
              plotSeeds:      plotSeeds      ?? {},
            },
          }, '*');
          return;
        }

        // chestCache — injected.js persists contents of one opened chest
        case 'chestCache': {
          const mid = data?.mid ?? 'unknown';
          const chestVal = {
            items:       data.items       ?? [],
            size:        data.size        ?? 0,
            removeOnly:  data.removeOnly  ?? false,
            capturedAt:  data.capturedAt  ?? Date.now(),
            storageName: data.storageName ?? null,
            landId:      data.landId      ?? null,
            entityType:  data.entityType  ?? null,
            source:      data.source      ?? null,
          };
          await storageSetKey(`chestCache_${mid}`, chestVal);
          // Also persist to backend so data survives reinstall
          const pid = companion.latestPlayerContext?.playerId;
          if (pid) {
            fetch(`${BACKEND_URL}/api/player-storage/chest`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ playerId: pid, mid, ...chestVal }),
            }).catch(() => { /* fire-and-forget */ });
          }
          return;
        }
        // chestCacheDelete — injected.js signals that a chest was removed from the current map
        case 'chestCacheDelete': {
          const mid = data?.mid;
          if (!mid) return;
          await storageDeleteKey(`chestCache_${mid}`);
          const pid2 = companion.latestPlayerContext?.playerId;
          if (pid2) {
            fetch(`${BACKEND_URL}/api/player-storage/chest?playerId=${encodeURIComponent(pid2)}&mid=${encodeURIComponent(mid)}`, {
              method: 'DELETE',
            }).catch(() => { /* fire-and-forget */ });
          }
          return;
        }
        // savePanelCache — injected.js persists a taskboard/stacked snapshot
        case 'savePanelCache': {
          const pid = data?.playerId ?? 'unknown';
          const writes = [];
          if (data?.taskboard !== undefined)
            writes.push(storageSetKey(`panelCacheTaskboard_${pid}`, data.taskboard));
          if (data?.stacked !== undefined)
            writes.push(storageSetKey(`panelCacheStacked_${pid}`, data.stacked));
          await Promise.all(writes);
          return;
        }
        // activityTimers — injected.js persists the full timer list
        case 'activityTimers': {
          const pid = companion.latestPlayerContext?.playerId ?? 'unknown';
          await storageSetKey(`activityTimers_${pid}`, data.timers ?? []);
          console.log('[timers] content: saved ' + (data.timers ?? []).length + ' timers for pid=' + pid);
          window.dispatchEvent(new CustomEvent('px-timers-updated'));
          return;
        }
        // activityTimerCollected — remove one timer from persisted list
        case 'activityTimerCollected': {
          const pid2 = companion.latestPlayerContext?.playerId ?? 'unknown';
          const key  = `activityTimers_${pid2}`;
          const prev = (await storageGetKey(key)) ?? [];
          const next = prev.filter((t) => t.entityMid !== data.entityMid);
          await storageSetKey(key, next);
          return;
        }
        // plotSeeds — map of "mapId:mid" → seedItemId for crop timer labels
        case 'plotSeeds': {
          await storageSetKey('plotSeeds', data.seeds ?? {});
          return;
        }
        default:
          console.warn(TAG, 'Unknown storage category:', category);
          return;
      }

      // Read the full root back after every write so reads/writes can be
      // confirmed in the DevTools console without a separate inspection step.
      const all = await storageGetAll();
      console.log(TAG, 'storage updated:', all);
    } catch (err) {
      console.error(TAG, 'storage error:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // postMessage listener — the bridge entry point.
  //
  // Security model:
  //   event.source === window   — rejects cross-frame / cross-tab messages.
  //     Messages from iframes or other windows will have a different source.
  //     Messages from other extension content scripts in the same tab will
  //     have the same source, so this check alone is not sufficient.
  //   event.data.source === 'pixels-companion'  — namespace guard.
  //     Any page script or extension that knows this string could forge a
  //     message.  Acceptable here because the data is game state, not
  //     credentials.  Tighten with a nonce scheme if sensitivity increases.
  // ---------------------------------------------------------------------------
  window.addEventListener('message', event => {
    // Reject messages that didn't originate in this tab's top-level window.
    if (event.source !== window) return;
    // Reject anything that isn't tagged as ours.
    if (!event.data || event.data.source !== 'pixels-companion') return;

    const { category, data } = event.data;
    if (!category) return;

    dispatch(category, data);
  });

  // ---------------------------------------------------------------------------
  // Companion UI — injects a floating sprite + speech-bubble chat panel.
  // Uses only vanilla DOM/CSS; no React or Jotai.
  //
  // Visual states:
  //   Closed — #px-float-sprite follows the player via a requestAnimationFrame
  //             loop that converts world→screen coords using camera data from
  //             injected.js.  Clicking the sprite (or corner toggle) opens panel.
  //   Open   — #px-companion-panel appears above the sprite as speech bubbles.
  //             The float sprite stays visible beneath the panel (z-index layering:
  //             panel 99998, sprite 99997).  Clicking the sprite again closes.
  //
  // First-launch onboarding: hasSeenIntro is checked in storage on init; if
  // absent, the panel auto-opens after 4 s and shows a greeting, then the flag
  // is set so it never repeats.
  // ---------------------------------------------------------------------------
  const companion = (() => {
    let latestPlayerContext = null;
    let latestCameraFrame   = null; // {scrollX, scrollY, worldWidth, worldHeight}
    let currentPersona = 'pixin';   // overwritten by saved preference in init()
    let isOpen = false;
    let isBusy = false;
    let msgCounter = 0;
    let spriteShown     = false; // true once the user has clicked torii at least once
    let introSeen       = false; // Pixin first-ever intro — loaded from storage in init()
    let royagiIntroSeen = false; // Royagi first-ever intro
    let nyankoIntroSeen = false; // Nyanko first-ever intro

    // Walking animation state machine.
    // state: 'idle' | 'start-trans' | 'walk' | 'stop-trans'
    // dir: 'left' | 'right'
    // transStart: performance.now() timestamp when a trans state began
    const TRANS_HOLD_MS = 100;
    const spriteAnim = { state: 'idle', dir: 'right', transStart: 0 };

    // Notebook / Diary modal state
    let notebookOpen = false;
    let notebookTab  = 'diary';
    let diaryPage    = 1;
    let timerCountdownInterval = null;

    // Storage modal state
    let storageOpen       = false;
    let _storageMode      = 'browse'; // 'browse' | 'totals'
    let _storageMeta      = null;     // { itemId: { name, imageUrl } } — lazy loaded
    let _storageMetaLoading = false;

    const CASUAL_GREETINGS = ["What's up?", "How can I help?", "What do you need?"];

    // ---- Personal assistant state -------------------------------------------
    let playerProfile    = null;   // {playStyle,goal,goalTarget,hasPet,petCount,petDetected,storage,taskboardMaxPrice,taskboardTooExpensive}
    let profileLoaded    = false;  // true once storage was read for current player
    let _profileBackendLoaded = false; // true once _loadPlayerPrefsFromBackend has settled
    let _profileSetupActive = false;
    let _profileSetupData   = {};   // accumulated answers; also used as a draft for resume
    let nowDoingNote     = '';     // "Now doing" note text
    let nowDoingSetAt    = 0;      // ms timestamp when note was set
    let nowDoingLastRemindedMap = null; // last map where reminder was shown
    let hearthHallSeasonStart = null;  // ms timestamp of detected HH season
    let _briefPlanPostedDate  = null;  // UTC date string when post-brief plan was last posted
    let _briefShownDate       = null;  // in-memory guard to prevent double-posting morning brief

    // ---- Sprite data URL helpers ----------------------------------------------
    // CSS url() inside an injected <style> tag is subject to the host page's
    // CSP (img-src). pixels.xyz excludes chrome-extension: from img-src, so
    // bare chrome.runtime.getURL() references are blocked silently.
    // Fetching each sprite as a blob then converting to a data URL sidesteps
    // this: data: URLs are always allowed by browsers for img-src.
    function fetchDataUrl(assetPath) {
      return fetch(chrome.runtime.getURL(assetPath))
        .then(r => r.blob())
        .then(blob => new Promise(resolve => {
          const fr = new FileReader();
          fr.onloadend = () => resolve(fr.result);
          fr.readAsDataURL(blob);
        }));
    }

    // ---- Persona persistence -------------------------------------------------
    function loadPersona() {
      return storageGetKey('companionPersona').then(p =>
        ['pixin', 'goat', 'cat'].includes(p) ? p : null);
    }

    function savePersona(p) {
      storageSetKey('companionPersona', p).catch(err =>
        console.warn(TAG, 'save persona failed:', err));
    }

    // ---- Accent colour — change this one constant to re-skin the toggle button.
    const ACCENT_LIME = '#C6F432'; // Pixels Dojo lime; swap to e.g. '#FF3EA5' for hot pink

    // ---- Inject styles -------------------------------------------------------
    function injectStyles(urls) {
      const s = document.createElement('style');
      s.id = 'px-companion-styles';
      s.textContent = `
        /* ── Corner toggle button ─────────────────────────────────────────── */
        @keyframes px-toggle-pulse {
          0%   { box-shadow: 0 0 0 0px ${ACCENT_LIME}a5, 0 2px 10px rgba(0,0,0,0.45); }
          65%  { box-shadow: 0 0 0 9px ${ACCENT_LIME}00, 0 2px 10px rgba(0,0,0,0.45); }
          100% { box-shadow: 0 0 0 0px ${ACCENT_LIME}00, 0 2px 10px rgba(0,0,0,0.45); }
        }
        #px-companion-toggle {
          position: fixed;
          bottom: 96px;
          right: 16px;
          width: 50px;
          height: 50px;
          border-radius: 50%;
          background: ${ACCENT_LIME};
          border: 2px solid rgba(0,0,0,0.18);
          box-shadow: 0 0 0 0px ${ACCENT_LIME}a5, 0 2px 10px rgba(0,0,0,0.45);
          cursor: pointer;
          z-index: 99999;
          display: flex;
          align-items: center;
          justify-content: center;
          user-select: none;
          animation: px-toggle-pulse 2.8s ease-out infinite;
          transition: filter 0.15s, box-shadow 0.15s;
          padding: 0;
          overflow: hidden;
        }
        #px-companion-toggle:hover {
          filter: brightness(1.12);
          box-shadow: 0 0 0 5px ${ACCENT_LIME}55, 0 2px 12px rgba(0,0,0,0.5);
          animation: none;
        }
        #px-companion-toggle.px-open {
          filter: brightness(1.08);
          box-shadow: 0 0 0 3px ${ACCENT_LIME}77, 0 2px 10px rgba(0,0,0,0.45);
          animation: none;
        }
        #px-companion-toggle img {
          width: 36px;
          height: 36px;
          image-rendering: pixelated;
          display: block;
          filter: brightness(0);
        }

        /* ── Floating sprite — tracks player, always visible ─────────────── */
        /* Layout box: 48×64. scale(2) from bottom center = 96×128 visual.   */
        #px-float-sprite {
          position: fixed;
          width: 48px;
          height: 64px;
          background-repeat: no-repeat;
          image-rendering: pixelated;
          transform: scale(2);
          transform-origin: bottom center;
          z-index: 99997;
          cursor: pointer;
          display: none;
          filter: drop-shadow(0 3px 10px rgba(0,0,0,0.6));
          transition: filter 0.15s;
        }
        #px-float-sprite.px-float-visible { display: block; }
        #px-float-sprite:hover {
          filter: drop-shadow(0 3px 10px rgba(0,0,0,0.6))
                  drop-shadow(0 0 8px rgba(98,42,255,0.7));
        }

        /* ── Panel — transparent container, positioned above sprite by JS ── */
        #px-companion-panel {
          position: fixed;
          width: min(448px, 92vw);
          z-index: 99998;
          display: none;
          flex-direction: column;
          align-items: stretch;
          font-family: 'Press Start 2P', 'VT323', monospace, sans-serif;
          bottom: 200px;
          left: 50%;
          transform: translateX(-50%);
          max-height: calc(100vh - 220px); /* fallback; JS overrides per-frame */
          overflow: hidden; /* enforce max-height so #px-messages can scroll */
        }
        #px-companion-panel.px-visible { display: flex; }

        /* ── Top bar: persona tabs (left) + action buttons (right) ─────────── */
        #px-dismiss-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 4px;
          margin-bottom: 5px;
        }

        /* ── Persona text tabs ──────────────────────────────────────────── */
        #px-persona-row {
          display: flex;
          gap: 3px;
          flex-shrink: 0;
        }
        .px-persona-tab {
          background: #fffaf2;
          border: 2px solid #222;
          border-radius: 6px;
          color: #222;
          font-family: inherit;
          font-size: 7px;
          cursor: pointer;
          padding: 3px 5px;
          white-space: nowrap;
          box-shadow: 2px 2px 0 #222;
          transition: background 0.12s;
          line-height: 1;
        }
        .px-persona-tab:hover { background: #f0e6d4; }
        .px-persona-tab-active {
          background: rgba(98,42,255,0.1);
          border-color: rgba(98,42,255,0.9);
          box-shadow: 2px 2px 0 rgba(98,42,255,0.6);
          text-decoration: underline;
          text-underline-offset: 2px;
        }

        /* ── Header right: Diary + Dismiss ──────────────────────────────── */
        #px-header-right {
          display: flex;
          gap: 3px;
          flex-shrink: 0;
        }
        .px-hdr-btn {
          background: #fffaf2;
          border: 2px solid #222;
          border-radius: 6px;
          color: #222;
          font-family: inherit;
          font-size: 7px;
          cursor: pointer;
          padding: 3px 5px;
          white-space: nowrap;
          box-shadow: 2px 2px 0 #222;
          transition: background 0.12s;
          line-height: 1;
        }
        .px-hdr-btn:hover { background: #f0e6d4; }
        #px-dismiss-all-btn:hover { background: #ffe0e0; border-color: #c44; box-shadow: 2px 2px 0 #c44; }
        #px-close-btn:hover { background: #f0e6d4; }
        #px-premium-btn {
          background: rgba(98,42,255,0.08);
          border-color: rgba(98,42,255,0.5);
          box-shadow: 2px 2px 0 rgba(98,42,255,0.3);
          color: rgba(98,42,255,0.9);
        }
        #px-premium-btn:hover {
          background: rgba(98,42,255,0.18);
          border-color: rgba(98,42,255,0.8);
        }

        /* ── Premium modal overlay ─────────────────────────────────────────── */
        #px-premium-modal {
          display: none;
          position: fixed;
          inset: 0;
          z-index: 100000;
          background: rgba(0,0,0,0.55);
          align-items: center;
          justify-content: center;
        }
        #px-premium-modal.px-modal-visible { display: flex; }
        #px-premium-modal-box {
          background: #fffaf2;
          border: 2px solid #222;
          border-radius: 12px;
          box-shadow: 4px 4px 0 #222;
          padding: 18px 20px;
          max-width: 300px;
          width: calc(100vw - 40px);
          font-family: 'Press Start 2P', 'VT323', monospace, sans-serif;
          font-size: 9px;
          line-height: 1.7;
          position: relative;
        }
        #px-premium-modal-close {
          position: absolute;
          top: 8px;
          right: 10px;
          background: none;
          border: none;
          font-family: inherit;
          font-size: 12px;
          cursor: pointer;
          color: #222;
          padding: 2px 4px;
          line-height: 1;
        }
        #px-premium-modal-close:hover { color: #622aff; }
        #px-premium-modal h3 {
          font-size: 9px;
          margin: 0 0 10px;
          color: rgba(98,42,255,0.9);
        }
        #px-premium-modal p {
          margin: 0 0 8px;
          color: #333;
        }
        #px-premium-modal .px-premium-soon {
          display: inline-block;
          margin-top: 8px;
          background: rgba(98,42,255,0.1);
          border: 1.5px solid rgba(98,42,255,0.4);
          border-radius: 6px;
          padding: 4px 8px;
          color: rgba(98,42,255,0.9);
          font-size: 8px;
        }

        /* ── Messages scroll area ───────────────────────────────────────── */
        #px-messages {
          display: flex;
          flex-direction: column;
          gap: 6px;
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: scroll !important;
          padding: 2px 8px 8px 2px;
        }
        #px-messages::-webkit-scrollbar {
          display: block !important;
          width: 16px !important;
        }
        #px-messages::-webkit-scrollbar-track {
          background: rgba(60,20,140,0.55) !important;
          border-radius: 8px !important;
        }
        #px-messages::-webkit-scrollbar-thumb {
          background: #fff !important;
          border: 2px solid rgba(60,20,140,0.8) !important;
          border-radius: 8px !important;
          min-height: 48px !important;
        }
        #px-messages::-webkit-scrollbar-thumb:hover {
          background: #f0eaff !important;
        }
        #px-messages::-webkit-scrollbar-button {
          display: none !important;
        }

        /* ── Empty state placeholder ────────────────────────────────────── */
        .px-empty {
          background: #fffaf2;
          color: rgba(0,0,0,0.4);
          border: 2px solid #ccc;
          border-radius: 10px;
          padding: 8px 10px;
          font-size: 10px;
          text-align: center;
          font-style: italic;
          line-height: 1.6;
          align-self: flex-start;
          max-width: min(436px, calc(92vw - 12px));
        }

        /* ── Speech bubble ──────────────────────────────────────────────── */
        .px-msg {
          background: #fffaf2;
          color: #111;
          border: 2px solid #222;
          border-radius: 10px;
          padding: 8px 10px;
          max-width: min(436px, calc(92vw - 12px));
          word-wrap: break-word;
          white-space: pre-line;
          font-size: 10px;
          line-height: 1.6;
          font-weight: 400;
          position: relative;
          box-shadow: 3px 3px 0 #222;
          align-self: flex-start;
        }
        .px-msg-player {
          background: rgba(98,42,255,0.88);
          color: #fff;
          border: 2px solid rgba(50,20,140,0.9);
          box-shadow: 3px 3px 0 rgba(50,20,140,0.9);
          align-self: flex-end;
          border-radius: 10px 10px 2px 10px;
          text-shadow: none;
        }
        .px-msg-loading {
          opacity: 0.6;
          font-style: italic;
        }

        /* ── Tail pointing down toward the sprite ───────────────────────── */
        /* Lives outside #px-messages so it is never clipped by overflow.    */
        #px-panel-tail {
          align-self: flex-start;
          margin-left: 20px;
          margin-top: -2px;
          flex-shrink: 0;
          width: 0;
          height: 0;
          border-left: 7px solid transparent;
          border-right: 7px solid transparent;
          border-top: 11px solid #222;
          position: relative;
        }
        #px-panel-tail::after {
          content: '';
          position: absolute;
          top: -13px;
          left: -5px;
          width: 0;
          height: 0;
          border-left: 5px solid transparent;
          border-right: 5px solid transparent;
          border-top: 9px solid #fffaf2;
        }

        /* ── Input row ──────────────────────────────────────────────────── */
        #px-input-row {
          display: flex;
          align-items: center;
          gap: 5px;
          margin-top: 6px;
        }
        #px-input {
          flex: 1;
          background: #fffaf2;
          border: 2px solid #222;
          border-radius: 8px;
          color: #222;
          font-family: inherit;
          font-size: 10px;
          padding: 5px 8px;
          outline: none;
          box-sizing: border-box;
          box-shadow: 2px 2px 0 #222;
        }
        #px-input:focus {
          border-color: rgba(98,42,255,0.8);
          box-shadow: 2px 2px 0 rgba(98,42,255,0.6);
        }
        #px-input:disabled { opacity: 0.5; }
        #px-input::placeholder { color: rgba(0,0,0,0.3); }
        #px-send {
          width: 30px;
          height: 30px;
          flex-shrink: 0;
          background: #fffaf2;
          border: 2px solid #222;
          border-radius: 8px;
          color: #222;
          font-size: 14px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          box-shadow: 2px 2px 0 #222;
          transition: background 0.12s;
        }
        #px-send:hover:not(:disabled) {
          background: rgba(98,42,255,0.12);
          border-color: rgba(98,42,255,0.8);
        }
        #px-send:disabled { opacity: 0.25; cursor: default; }
        #px-pin-btn {
          width: 30px; height: 30px; flex-shrink: 0;
          background: #fffaf2; border: 2px solid #222; border-radius: 8px;
          color: #222; font-size: 14px; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          padding: 0; box-shadow: 2px 2px 0 #222; transition: background 0.12s;
        }
        #px-pin-btn:hover { background: rgba(98,42,255,0.12); border-color: rgba(98,42,255,0.8); }
        /* ── Choice buttons (profile setup, morning brief, etc.) ─────────── */
        .px-msg-choices {
          display: flex; flex-wrap: wrap; gap: 4px;
          margin-top: 6px;
        }
        .px-choice-btn {
          background: rgba(98,42,255,0.1); border: 1.5px solid rgba(98,42,255,0.6);
          border-radius: 6px; color: rgba(98,42,255,0.95); font-family: inherit;
          font-size: 9px; cursor: pointer; padding: 4px 8px; white-space: nowrap;
          box-shadow: 1px 1px 0 rgba(98,42,255,0.3); transition: background 0.1s;
        }
        .px-choice-btn:hover { background: rgba(98,42,255,0.22); }
        .px-profile-input {
          flex: 1; background: #fffaf2; border: 1.5px solid #888; border-radius: 6px;
          color: #222; font-family: inherit; font-size: 9px; padding: 4px 6px;
          outline: none; box-sizing: border-box; min-width: 0;
        }
        .px-profile-input:focus { border-color: rgba(98,42,255,0.8); }

        /* ── Notebook / Diary modal ──────────────────────────────────────── */
        #px-notebook-modal {
          display: none;
          position: fixed;
          inset: 0;
          z-index: 100000;
          background: rgba(0,0,0,0.55);
          align-items: center;
          justify-content: center;
        }
        #px-notebook-modal.px-modal-visible { display: flex; }
        #px-notebook-modal-box {
          background: #fffaf2;
          border: 2px solid #222;
          border-radius: 12px;
          box-shadow: 4px 4px 0 #222;
          width: min(520px, 96vw);
          max-height: calc(100vh - 40px);
          display: flex;
          flex-direction: column;
          font-family: 'Press Start 2P', 'VT323', monospace, sans-serif;
          font-size: 9px;
          overflow: hidden;
        }
        #px-nb-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px 8px;
          border-bottom: 2px solid #222;
          flex-shrink: 0;
        }
        #px-nb-tabs { display: flex; gap: 4px; }
        .px-nb-tab {
          background: #fffaf2;
          border: 2px solid #222;
          border-radius: 6px;
          color: #222;
          font-family: inherit;
          font-size: 8px;
          cursor: pointer;
          padding: 4px 10px;
          box-shadow: 2px 2px 0 #222;
          transition: background 0.12s;
          line-height: 1;
        }
        .px-nb-tab:hover { background: #f0e6d4; }
        .px-nb-tab-active {
          background: rgba(98,42,255,0.1);
          border-color: rgba(98,42,255,0.9);
          box-shadow: 2px 2px 0 rgba(98,42,255,0.6);
        }
        #px-notebook-modal-close {
          background: none; border: none;
          font-family: inherit; font-size: 14px;
          cursor: pointer; color: #222; padding: 2px 4px; line-height: 1;
        }
        #px-notebook-modal-close:hover { color: #622aff; }
        .px-nb-panel {
          display: none;
          flex-direction: column;
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          padding: 10px 12px 14px;
          gap: 14px;
        }
        .px-nb-panel-active { display: flex; }
        .px-nb-diary-card {
          background: #fff8ee;
          border: 1.5px solid #ccc;
          border-radius: 8px;
          padding: 8px 10px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .px-nb-diary-date { font-size: 8px; color: rgba(98,42,255,0.8); margin-bottom: 2px; }
        .px-nb-diary-text { font-size: 8px; line-height: 1.7; color: #333; white-space: pre-line; }
        .px-nb-diary-rows { display: flex; flex-direction: column; gap: 3px; }
        .px-nb-diary-row  { display: flex; align-items: center; gap: 4px; font-size: 7px; line-height: 1.4; }
        .px-nb-diary-icon { width: 12px; height: 12px; object-fit: contain; image-rendering: pixelated; flex-shrink: 0; }
        .px-nb-diary-gain { color: #1a7a1a; font-weight: bold; }
        .px-nb-diary-loss { color: #c0392b; font-weight: bold; }
        .px-nb-diary-label { color: #333; }
        .px-nb-diary-skill { color: #555; font-style: italic; }
        /* Today's XP section */
        .px-xp-card {
          background: #f0f7ff;
          border: 1.5px solid #b0c8e8;
          border-radius: 8px;
          padding: 8px 10px;
          margin-bottom: 8px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .px-xp-header {
          display: flex; align-items: center; justify-content: space-between;
          font-size: 9px; color: rgba(30,90,180,0.9);
          border-bottom: 1.5px solid rgba(30,90,180,0.25);
          padding-bottom: 4px; margin-bottom: 2px;
        }
        .px-xp-toggle {
          font-size: 7px; color: rgba(98,42,255,0.8); cursor: pointer;
          background: none; border: none; padding: 0; font-family: inherit;
          text-decoration: underline dotted;
        }
        .px-xp-row {
          display: flex; align-items: center; gap: 4px;
          font-size: 7px; line-height: 1.4;
        }
        .px-xp-skill { color: #333; flex: 1; }
        .px-xp-gain  { color: #1a7a1a; font-weight: bold; margin-left: auto; }
        .px-xp-lvlup { color: rgba(98,42,255,0.85); font-size: 7px; }
        .px-xp-total {
          display: flex; justify-content: space-between;
          font-size: 7.5px; font-weight: bold; color: #444;
          border-top: 1px solid #cce0f5; padding-top: 3px; margin-top: 2px;
        }
        .px-nb-pag-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
        .px-nb-pag-btn {
          background: #fffaf2; border: 2px solid #222; border-radius: 6px;
          color: #222; font-family: inherit; font-size: 7px;
          cursor: pointer; padding: 3px 6px; box-shadow: 2px 2px 0 #222;
        }
        .px-nb-pag-btn:hover { background: #f0e6d4; }
        .px-nb-pag-info { font-size: 7px; color: #666; }
        .px-nb-section { display: flex; flex-direction: column; gap: 6px; }
        .px-nb-section-header {
          font-size: 9px; color: rgba(98,42,255,0.9);
          border-bottom: 1.5px solid rgba(98,42,255,0.3);
          padding-bottom: 4px;
        }
        .px-nb-subsection-header {
          font-size: 8px; color: #555; margin-top: 4px;
          display: flex; align-items: center; gap: 6px;
        }
        .px-nb-empty { font-size: 8px; color: rgba(0,0,0,0.4); font-style: italic; padding: 3px 0; }
        .px-nb-loading { font-size: 8px; color: rgba(0,0,0,0.35); padding: 3px 0; }
        .px-nb-goal-item { display: flex; align-items: center; gap: 6px; }
        .px-nb-goal-check { flex-shrink: 0; cursor: pointer; width: 12px; height: 12px; }
        .px-nb-goal-text { flex: 1; font-size: 8px; line-height: 1.5; word-break: break-word; }
        .px-nb-goal-done { text-decoration: line-through; opacity: 0.5; }
        .px-nb-timer-item { display: flex; align-items: center; gap: 6px; }
        .px-nb-timer-label { flex: 1; font-size: 8px; word-break: break-word; }
        .px-nb-timer-countdown {
          font-size: 7px; color: rgba(98,42,255,0.8);
          white-space: nowrap; flex-shrink: 0;
        }
        .px-nb-shopping-item { display: flex; align-items: center; gap: 6px; }
        .px-nb-shopping-text { flex: 1; font-size: 8px; word-break: break-word; }
        .px-nb-totals-header { font-size: 7px; color: #555; margin-top: 4px; margin-bottom: 2px; }
        .px-nb-total-row { font-size: 8px; padding: 1px 0; }
        .px-nb-add-row { display: flex; gap: 4px; align-items: center; }
        .px-nb-input {
          flex: 1; background: #fffaf2; border: 2px solid #222; border-radius: 6px;
          color: #222; font-family: inherit; font-size: 8px; padding: 4px 6px;
          outline: none; box-sizing: border-box; box-shadow: 2px 2px 0 #222; min-width: 0;
        }
        .px-nb-input:focus { border-color: rgba(98,42,255,0.8); box-shadow: 2px 2px 0 rgba(98,42,255,0.6); }
        .px-nb-input-sm { flex: 0 0 52px; max-width: 52px; }
        .px-nb-add-btn {
          background: rgba(98,42,255,0.1); border: 2px solid rgba(98,42,255,0.7);
          border-radius: 6px; color: rgba(98,42,255,0.9); font-family: inherit;
          font-size: 7px; cursor: pointer; padding: 4px 8px;
          box-shadow: 2px 2px 0 rgba(98,42,255,0.3); flex-shrink: 0; white-space: nowrap;
        }
        .px-nb-add-btn:hover { background: rgba(98,42,255,0.2); }
        .px-nb-del-btn {
          background: none; border: none; color: #aaa; font-family: inherit;
          font-size: 11px; cursor: pointer; padding: 0 2px; flex-shrink: 0; line-height: 1;
        }
        .px-nb-del-btn:hover { color: #c44; }
        .px-nb-calc-btn {
          background: rgba(98,42,255,0.08); border: 1.5px solid rgba(98,42,255,0.4);
          border-radius: 4px; color: rgba(98,42,255,0.8); font-family: inherit;
          font-size: 7px; cursor: pointer; padding: 2px 6px; line-height: 1;
        }
        .px-nb-calc-btn:hover { background: rgba(98,42,255,0.18); }

        /* ── Sprite animation classes — used by #px-float-sprite ─────────── */
        /* Pixin — 2 frames, 96×64, 48px/frame, 2000ms */
        .px-sprite-pixin {
          background-image: url('${urls.pixin}');
          background-size: 96px 64px;
          animation: px-pixinIdle 2000ms steps(1) infinite;
        }
        /* Royagi/Goat — 5 frames, 240×64, 48px/frame, 3400ms */
        .px-sprite-goat {
          background-image: url('${urls.goat}');
          background-size: 240px 64px;
          animation: px-royagiIdle 3400ms steps(1) infinite;
        }
        /* Nyanko/Cat — 3 frames, 144×64, 48px/frame, 1700ms */
        .px-sprite-cat {
          background-image: url('${urls.cat}');
          background-size: 144px 64px;
          animation: px-nyankoIdle 1700ms steps(1) infinite;
        }
        @keyframes px-pixinIdle {
          0%,   49.9% { background-position:    0 0; }
          50%,  100%  { background-position:  -48px 0; }
        }
        @keyframes px-royagiIdle {
          0%,    29.4% { background-position:    0 0; }
          29.5%, 58.8% { background-position:  -48px 0; }
          58.9%, 88.2% { background-position:  -96px 0; }
          88.3%, 94.1% { background-position: -144px 0; }
          94.2%, 100%  { background-position: -192px 0; }
        }
        @keyframes px-nyankoIdle {
          0%,    88.2% { background-position:    0 0; }
          88.3%, 94.1% { background-position:  -48px 0; }
          94.2%, 100%  { background-position:  -96px 0; }
        }

        /* ── Walk / transition sprites ──────────────────────────────────── */
        /* Pixin transition — 1 frame, 48×64 */
        .px-sprite-pixin-trans-left {
          background-image: url('${urls.pixinTransLeft}');
          background-size: 48px 64px;
        }
        .px-sprite-pixin-trans-right {
          background-image: url('${urls.pixinTransRight}');
          background-size: 48px 64px;
        }
        /* Pixin walk — 4 frames, 192×64, 100ms/frame */
        .px-sprite-pixin-walk-left {
          background-image: url('${urls.pixinWalkLeft}');
          background-size: 192px 64px;
          animation: px-pixinWalk 400ms steps(1) infinite;
        }
        .px-sprite-pixin-walk-right {
          background-image: url('${urls.pixinWalkRight}');
          background-size: 192px 64px;
          animation: px-pixinWalk 400ms steps(1) infinite;
        }
        @keyframes px-pixinWalk {
          0%   { background-position:    0 0; }
          25%  { background-position:  -48px 0; }
          50%  { background-position:  -96px 0; }
          75%  { background-position: -144px 0; }
        }

        /* Nyanko transition — 1 frame, 48×64 */
        .px-sprite-nyanko-trans-left {
          background-image: url('${urls.nyankoTransLeft}');
          background-size: 48px 64px;
        }
        .px-sprite-nyanko-trans-right {
          background-image: url('${urls.nyankoTransRight}');
          background-size: 48px 64px;
        }
        /* Nyanko walk — 4 frames, 192×64, 100ms/frame */
        .px-sprite-nyanko-walk-left {
          background-image: url('${urls.nyankoWalkLeft}');
          background-size: 192px 64px;
          animation: px-nyankoWalk 400ms steps(1) infinite;
        }
        .px-sprite-nyanko-walk-right {
          background-image: url('${urls.nyankoWalkRight}');
          background-size: 192px 64px;
          animation: px-nyankoWalk 400ms steps(1) infinite;
        }
        @keyframes px-nyankoWalk {
          0%   { background-position:    0 0; }
          25%  { background-position:  -48px 0; }
          50%  { background-position:  -96px 0; }
          75%  { background-position: -144px 0; }
        }

        /* Royagi transition — 1 frame, 48×64 (native faces right) */
        .px-sprite-goat-trans-right {
          background-image: url('${urls.royagiTrans}');
          background-size: 48px 64px;
        }
        /* Mirror via higher-specificity rule so it overrides #px-float-sprite scale(2) */
        #px-float-sprite.px-sprite-goat-trans-left {
          background-image: url('${urls.royagiTrans}');
          background-size: 48px 64px;
          transform: scale(-2, 2);
          transform-origin: bottom center;
        }
        /* Royagi walk — 10 frames, 480×64, 250ms/frame */
        .px-sprite-goat-walk-left {
          background-image: url('${urls.royagiWalkLeft}');
          background-size: 480px 64px;
          animation: px-royagiWalk 2500ms steps(1) infinite;
        }
        .px-sprite-goat-walk-right {
          background-image: url('${urls.royagiWalkRight}');
          background-size: 480px 64px;
          animation: px-royagiWalk 2500ms steps(1) infinite;
        }
        @keyframes px-royagiWalk {
          0%   { background-position:    0 0; }
          10%  { background-position:  -48px 0; }
          20%  { background-position:  -96px 0; }
          30%  { background-position: -144px 0; }
          40%  { background-position: -192px 0; }
          50%  { background-position: -240px 0; }
          60%  { background-position: -288px 0; }
          70%  { background-position: -336px 0; }
          80%  { background-position: -384px 0; }
          90%  { background-position: -432px 0; }
        }

        /* ── Storage pop-up modal ──────────────────────────────────────────── */
        #px-storage-modal {
          display: none; position: fixed; inset: 0; z-index: 100000;
          background: rgba(0,0,0,0.55); align-items: center; justify-content: center;
        }
        #px-storage-modal.px-modal-visible { display: flex; }
        #px-storage-modal-box {
          background: #fffaf2; border: 2px solid #222; border-radius: 12px;
          box-shadow: 4px 4px 0 #222; width: min(640px, 97vw);
          max-height: calc(100vh - 40px); display: flex; flex-direction: column;
          font-family: 'Press Start 2P', 'VT323', monospace, sans-serif;
          font-size: 9px; overflow: hidden;
        }
        #px-storage-modal-header {
          display: flex; align-items: center; gap: 6px;
          padding: 10px 12px 8px; border-bottom: 2px solid #222; flex-shrink: 0;
          flex-wrap: wrap;
        }
        #px-storage-modal-title { font-size: 10px; }
        .px-storage-mode-btn {
          background: #fffaf2; border: 2px solid #222; border-radius: 6px;
          color: #222; font-family: inherit; font-size: 7px; cursor: pointer;
          padding: 3px 8px; box-shadow: 2px 2px 0 #222; line-height: 1;
        }
        .px-storage-mode-btn:hover { background: #f0e6d4; }
        .px-storage-mode-active {
          background: rgba(98,42,255,0.1); border-color: rgba(98,42,255,0.9);
          box-shadow: 2px 2px 0 rgba(98,42,255,0.6);
        }
        #px-storage-search {
          background: #fffaf2; border: 1.5px solid #888; border-radius: 6px;
          color: #222; font-family: inherit; font-size: 8px; padding: 3px 7px;
          outline: none; flex: 1; min-width: 80px; max-width: 180px;
        }
        #px-storage-search:focus { border-color: rgba(98,42,255,0.7); }
        #px-storage-modal-close {
          background: none; border: none; font-family: inherit; font-size: 14px;
          cursor: pointer; color: #222; padding: 2px 4px; line-height: 1; flex-shrink: 0;
          margin-left: auto;
        }
        #px-storage-modal-close:hover { color: #622aff; }
        #px-storage-content {
          flex: 1 1 auto; min-height: 0; overflow-y: auto;
          padding: 10px 12px 14px; display: flex; flex-direction: column; gap: 12px;
        }
        #px-storage-content::-webkit-scrollbar { display: block !important; width: 10px !important; }
        #px-storage-content::-webkit-scrollbar-track { background: rgba(60,20,140,0.2) !important; border-radius: 5px !important; }
        #px-storage-content::-webkit-scrollbar-thumb { background: rgba(98,42,255,0.4) !important; border-radius: 5px !important; min-height: 40px !important; }
        #px-storage-modal .px-st-section-hdr {
          font-size: 9px !important; color: rgba(98,42,255,0.9) !important;
          border-bottom: 1.5px solid rgba(98,42,255,0.3) !important; padding-bottom: 4px !important;
          margin-bottom: 5px !important; display: flex !important;
          align-items: center !important; justify-content: space-between !important;
        }
        #px-storage-modal .px-st-section-count { font-size: 7px !important; color: #888 !important; }
        #px-storage-modal .px-st-chest {
          background: #fff8ee !important; border: 1.5px solid #ddd !important;
          border-radius: 8px !important; padding: 7px 9px !important;
          display: flex !important; flex-direction: column !important; gap: 5px !important;
          margin-bottom: 5px !important;
        }
        #px-storage-modal .px-st-chest-hdr {
          display: flex !important; align-items: center !important; gap: 6px !important;
        }
        #px-storage-modal .px-st-chest-name {
          font-size: 8px !important; color: #333 !important; flex: 1 !important; word-break: break-word !important;
        }
        #px-storage-modal .px-st-chest-meta {
          font-size: 7px !important; color: #888 !important; white-space: nowrap !important; flex-shrink: 0 !important;
        }
        #px-storage-modal .px-st-items {
          display: flex !important; flex-wrap: wrap !important; gap: 5px !important;
        }
        #px-storage-modal .px-st-item {
          position: relative !important; width: 46px !important; height: 46px !important;
          background: #fffaf2 !important; border: 1.5px solid #ddd !important;
          border-radius: 6px !important; cursor: default !important;
          display: flex !important; align-items: center !important;
          justify-content: center !important; overflow: visible !important;
          flex-shrink: 0 !important; box-sizing: border-box !important;
        }
        #px-storage-modal .px-st-item:hover {
          border-color: rgba(98,42,255,0.5) !important; background: #f5f0ff !important;
        }
        #px-storage-modal .px-st-icon {
          width: 34px !important; height: 34px !important;
          object-fit: contain !important; image-rendering: pixelated !important;
          display: block !important; flex-shrink: 0 !important;
        }
        #px-storage-modal .px-st-icon-ph {
          width: 34px !important; height: 34px !important; background: #eee !important;
          border-radius: 4px !important; display: flex !important;
          align-items: center !important; justify-content: center !important;
          font-size: 11px !important; color: #bbb !important;
        }
        #px-storage-modal .px-st-qty {
          position: absolute !important; bottom: 2px !important; right: 2px !important;
          font-size: 6px !important; font-weight: 600 !important; line-height: 9px !important;
          background: rgba(0,0,0,0.55) !important; color: #fff !important;
          border-radius: 2px !important; padding: 0 2px !important;
          pointer-events: none !important; display: block !important;
        }
        #px-storage-modal .px-st-chest-empty {
          font-size: 7px !important; color: #aaa !important; font-style: italic !important;
        }
        #px-storage-modal .px-st-empty {
          font-size: 8px !important; color: rgba(0,0,0,0.4) !important;
          font-style: italic !important; padding: 4px 0 !important;
        }
        .px-st-search-summary {
          font-size: 8px; color: rgba(98,42,255,0.85); padding: 2px 0;
          border-bottom: 1px solid rgba(98,42,255,0.15); padding-bottom: 6px;
        }
        .px-st-totals-row {
          display: flex; align-items: center; gap: 5px; padding: 3px 0;
          border-bottom: 1px solid #eee;
        }
        .px-st-totals-icon { width: 18px; height: 18px; object-fit: contain; image-rendering: pixelated; flex-shrink: 0; }
        .px-st-totals-icon-ph {
          width: 18px; height: 18px; background: #eee; border-radius: 3px;
          flex-shrink: 0; font-size: 8px; color: #bbb; display: flex; align-items: center; justify-content: center;
        }
        .px-st-totals-name { flex: 1; font-size: 8px; color: #333; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .px-st-totals-qty { font-size: 8px; font-weight: bold; color: #222; white-space: nowrap; }
        .px-st-totals-detail { font-size: 6px; color: #888; white-space: nowrap; max-width: 130px; overflow: hidden; text-overflow: ellipsis; }
      `;
      (document.head || document.documentElement).appendChild(s);
    }

    // ---- Build DOM -----------------------------------------------------------
    function buildDOM() {
      const p = currentPersona;

      // Corner toggle — torii icon, subtle fallback always in the corner.
      const toggle = document.createElement('div');
      toggle.id = 'px-companion-toggle';
      toggle.title = 'Companion';
      const toriiImg = document.createElement('img');
      toriiImg.src = chrome.runtime.getURL('assets/torii-icon.png');
      toriiImg.alt = 'Companion';
      toggle.appendChild(toriiImg);
      document.body.appendChild(toggle);

      // Floating sprite — follows player, visible in both open and closed states.
      // Clicking it toggles the panel.
      const floatSprite = document.createElement('div');
      floatSprite.id = 'px-float-sprite';
      floatSprite.className = getSpriteAnimClass(p);
      floatSprite.title = 'Chat with companion';
      document.body.appendChild(floatSprite);

      // Panel — transparent container with speech bubbles, no background box.
      // #px-panel-tail points downward toward the sprite below.
      const panel = document.createElement('div');
      panel.id = 'px-companion-panel';
      panel.innerHTML = `
        <div id="px-dismiss-row">
          <div id="px-persona-row">
            <button class="px-persona-tab${p === 'pixin' ? ' px-persona-tab-active' : ''}" data-persona="pixin">Pixin</button>
            <button class="px-persona-tab${p === 'goat'  ? ' px-persona-tab-active' : ''}" data-persona="goat">Royagi</button>
            <button class="px-persona-tab${p === 'cat'   ? ' px-persona-tab-active' : ''}" data-persona="cat">Nyanko</button>
            <button class="px-hdr-btn" id="px-premium-btn" title="Premium companions">★</button>
          </div>
          <div id="px-header-right">
            <button class="px-hdr-btn" id="px-storage-btn">📦 Storage</button>
            <button class="px-hdr-btn" id="px-diary-btn">Diary</button>
            <button class="px-hdr-btn" id="px-close-btn" title="Close panel">×</button>
            <button class="px-hdr-btn" id="px-dismiss-all-btn">Dismiss</button>
          </div>
        </div>
        <div id="px-messages">
          <div class="px-empty">Ask me anything about Pixels!</div>
        </div>
        <div id="px-input-row">
          <button id="px-pin-btn" title="What was I doing?">📌</button>
          <input id="px-input" type="text" placeholder="Ask me anything…" maxlength="500"/>
          <button id="px-send" title="Send">&#x27A4;</button>
        </div>
        <div id="px-panel-tail"></div>
      `;
      document.body.appendChild(panel);

      // Premium modal — appended to body so it overlays everything.
      const modal = document.createElement('div');
      modal.id = 'px-premium-modal';
      modal.innerHTML = `
        <div id="px-premium-modal-box">
          <button id="px-premium-modal-close" title="Close">×</button>
          <h3>★ Premium Companions</h3>
          <p>Royagi and Nyanko are advanced AI companions built for players who want deeper strategy and personalized advice.</p>
          <p><strong>Royagi</strong> — the ancient dojo master. Expert-level farming, crafting, and progression strategy with wit to match.</p>
          <p><strong>Nyanko</strong> — your warm cat advisor. Encouraging, thorough, and always rooting for your success.</p>
          <span class="px-premium-soon">Coming soon — pricing TBD</span>
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelector('#px-premium-modal-close').addEventListener('click', togglePremiumModal);
      modal.addEventListener('click', e => { if (e.target === modal) togglePremiumModal(); });

      // Notebook / Diary modal
      const nbModal = document.createElement('div');
      nbModal.id = 'px-notebook-modal';
      nbModal.innerHTML = `
        <div id="px-notebook-modal-box">
          <div id="px-nb-header">
            <div id="px-nb-tabs">
              <button class="px-nb-tab px-nb-tab-active" data-tab="diary">Diary</button>
              <button class="px-nb-tab" data-tab="notebook">Notebook</button>
              <button class="px-nb-tab" data-tab="timers">Timers</button>
              <button class="px-nb-tab" data-tab="profile">My profile</button>
            </div>
            <button id="px-notebook-modal-close" title="Close">×</button>
          </div>
          <div id="px-nb-diary-panel" class="px-nb-panel px-nb-panel-active">
            <div id="px-nb-xp-section"></div>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
              <button class="px-nb-add-btn" id="px-nb-today-btn">☀️ Today</button>
            </div>
            <div id="px-nb-diary-list"><div class="px-nb-loading">Loading…</div></div>
            <div id="px-nb-diary-pag" class="px-nb-pag-row"></div>
          </div>
          <div id="px-nb-act-timers-panel" class="px-nb-panel">
            <div class="px-nb-section">
              <div class="px-nb-section-header">Activity Timers</div>
              <div id="px-nb-act-timers-list"><div class="px-nb-loading">Loading…</div></div>
            </div>
            <div class="px-nb-section">
              <div class="px-nb-section-header">Manual Timers</div>
              <div id="px-nb-timers-list"></div>
              <div class="px-nb-add-row">
                <input id="px-nb-timer-label" class="px-nb-input" type="text" placeholder="Timer label…" maxlength="100"/>
                <input id="px-nb-timer-mins" class="px-nb-input px-nb-input-sm" type="number" placeholder="min" min="0.5" step="0.5"/>
                <button class="px-nb-add-btn" id="px-nb-timer-add">Start</button>
              </div>
              <div class="px-nb-subsection-header">In-game offers</div>
              <div id="px-nb-ingame-timers"></div>
            </div>
          </div>
          <div id="px-nb-notebook-panel" class="px-nb-panel">
            <div class="px-nb-section">
              <div class="px-nb-section-header">Goals</div>
              <div id="px-nb-goals-list"></div>
              <div class="px-nb-add-row">
                <input id="px-nb-goal-input" class="px-nb-input" type="text" placeholder="New goal…" maxlength="200"/>
                <button class="px-nb-add-btn" id="px-nb-goal-add">Add</button>
              </div>
            </div>
            <div class="px-nb-section">
              <div class="px-nb-section-header">Shopping List</div>
              <div id="px-nb-shopping-items"></div>
              <div class="px-nb-add-row">
                <input id="px-nb-shopping-input" class="px-nb-input" type="text" placeholder="Item name…" maxlength="200"/>
                <input id="px-nb-shopping-qty" class="px-nb-input px-nb-input-sm" type="number" placeholder="qty" min="1" value="1"/>
                <button class="px-nb-add-btn" id="px-nb-shopping-add">Add</button>
              </div>
              <div class="px-nb-subsection-header">
                Crafting Totals
                <button class="px-nb-calc-btn" id="px-nb-craft-calc">Calculate</button>
              </div>
              <div id="px-nb-craft-totals"></div>
            </div>
          </div>
          <div id="px-nb-profile-panel" class="px-nb-panel">
            <div class="px-nb-section">
              <div class="px-nb-section-header">My Profile</div>
              <div id="px-nb-profile-content" style="font-size:9px;line-height:1.9;color:#444;white-space:pre-line;padding:4px 0">Loading…</div>
              <div class="px-nb-add-row" style="margin-top:6px">
                <button class="px-nb-add-btn" id="px-nb-profile-setup">Update profile</button>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(nbModal);
      nbModal.querySelector('#px-notebook-modal-close').addEventListener('click', closeNotebook);
      nbModal.addEventListener('click', e => { if (e.target === nbModal) closeNotebook(); });
      nbModal.querySelector('#px-nb-tabs').addEventListener('click', e => {
        const btn = e.target.closest('.px-nb-tab');
        if (btn) switchNotebookTab(btn.dataset.tab);
      });
      nbModal.querySelector('#px-nb-goal-add').addEventListener('click', addGoalItem);
      nbModal.querySelector('#px-nb-timer-add').addEventListener('click', addTimerItem);
      nbModal.querySelector('#px-nb-shopping-add').addEventListener('click', addShoppingItem);
      nbModal.querySelector('#px-nb-craft-calc').addEventListener('click', loadCraftTotals);
      nbModal.querySelector('#px-nb-today-btn').addEventListener('click', () => {
        closeNotebook();
        openPanel();
        showMorningBrief(true);
      });
      nbModal.querySelector('#px-nb-profile-setup').addEventListener('click', () => {
        closeNotebook();
        openPanel();
        _startProfileSetup();
      });
      // Stop key events from reaching Phaser for all notebook inputs
      nbModal.querySelectorAll('.px-nb-input').forEach(inp => {
        ['keydown','keyup','keypress'].forEach(ev =>
          inp.addEventListener(ev, e => { e.stopPropagation(); e.stopImmediatePropagation(); }));
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const id = inp.id;
            if (id === 'px-nb-goal-input')     addGoalItem();
            if (id === 'px-nb-shopping-input') addShoppingItem();
          }
        });
      });

      // Storage modal
      const stModal = document.createElement('div');
      stModal.id = 'px-storage-modal';
      stModal.innerHTML = `
        <div id="px-storage-modal-box">
          <div id="px-storage-modal-header">
            <span id="px-storage-modal-title">📦 Storage</span>
            <button class="px-storage-mode-btn px-storage-mode-active" data-mode="browse">Browse</button>
            <button class="px-storage-mode-btn" data-mode="totals">Totals</button>
            <input id="px-storage-search" type="text" placeholder="Search items…" maxlength="80" autocomplete="off"/>
            <button id="px-storage-modal-close" title="Close">×</button>
          </div>
          <div id="px-storage-content"></div>
        </div>
      `;
      document.body.appendChild(stModal);
      stModal.querySelector('#px-storage-modal-close').addEventListener('click', closeStorageModal);
      stModal.addEventListener('click', e => { if (e.target === stModal) closeStorageModal(); });
      stModal.querySelector('#px-storage-modal-header').addEventListener('click', e => {
        const btn = e.target.closest('.px-storage-mode-btn');
        if (!btn) return;
        _storageMode = btn.dataset.mode;
        stModal.querySelectorAll('.px-storage-mode-btn').forEach(b =>
          b.classList.toggle('px-storage-mode-active', b.dataset.mode === _storageMode));
        _renderStorage();
      });
      const searchEl = stModal.querySelector('#px-storage-search');
      searchEl.addEventListener('input', () => _renderStorage());
      ['keydown','keyup','keypress'].forEach(ev =>
        searchEl.addEventListener(ev, e => { e.stopPropagation(); e.stopImmediatePropagation(); }));
      searchEl.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); closeStorageModal(); }
      });

      // ── Event listeners ──────────────────────────────────────────────────
      panel.querySelector('#px-pin-btn').addEventListener('click', showWhatWasDoing);
      toggle.addEventListener('click', handleToriiClick);
      floatSprite.addEventListener('click', togglePanel);
      panel.querySelector('#px-dismiss-all-btn').addEventListener('click', fullDismiss);
      panel.querySelector('#px-close-btn').addEventListener('click', closePanel);
      panel.querySelector('#px-storage-btn').addEventListener('click', openStorageModal);
      panel.querySelector('#px-diary-btn').addEventListener('click', openNotebook);
      panel.querySelector('#px-premium-btn').addEventListener('click', togglePremiumModal);
      panel.querySelector('#px-send').onclick = () => isBusy ? _stopMessage(_pendingQuestion) : sendMessage();

      // Persona picker — delegate from the row container
      panel.querySelector('#px-persona-row').addEventListener('click', e => {
        const btn = e.target.closest('.px-persona-tab');
        if (!btn) return;
        switchPersona(btn.dataset.persona);
      });

      // Keyboard containment — stop ALL key events from bubbling to Phaser's
      // global document/window listeners (which intercept typing mid-sentence).
      const inputEl = panel.querySelector('#px-input');
      inputEl.addEventListener('keydown', e => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        if (e.key === 'Escape' && isBusy) { e.preventDefault(); _stopMessage(_pendingQuestion); }
      });
      inputEl.addEventListener('keyup',    e => { e.stopPropagation(); e.stopImmediatePropagation(); });
      inputEl.addEventListener('keypress', e => { e.stopPropagation(); e.stopImmediatePropagation(); });

      // Global Esc to close storage modal
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && storageOpen) {
          e.stopPropagation();
          closeStorageModal();
        }
      }, true);
    }

    // ---- Greeting logic -------------------------------------------------------
    // Three triggers, checked in priority order:
    //   1. Pixin first-ever intro  (hasSeenIntro not yet set)
    //   2. Royagi / Nyanko first-ever intro when switching to them for the first time
    //   3. Casual greeting for every other panel-open via the torii button
    //
    // Called by handleToriiClick() on every open, and by switchPersona() when
    // the active persona changes while the panel is already open.
    function maybeShowGreeting() {
      const p = currentPersona;

      if (p === 'pixin' && !introSeen) {
        introSeen = true;
        storageSetKey('hasSeenIntro', true).catch(() => {});
        const _pid0 = latestPlayerContext?.playerId;
        if (_pid0) nbFetch('/api/player-prefs', { method: 'POST', body: JSON.stringify({ playerId: _pid0, key: 'hasSeenIntro', value: true }) }).catch(() => {});
        appendMessage('pixin', "Hi, I'm Pixin! I'd love to teach you how to play Pixels and figure out what's going on in the wide world of Terra Villa. Ask me about anything — quests, coins, crafting, you name it! If you want advanced gameplay advice and strategy on how to maximize your earnings, why not chat to my friends Royagi or Nyanko?");
        setTimeout(_afterGreeting, 400);
        return;
      }

      if (p === 'goat' && !royagiIntroSeen) {
        royagiIntroSeen = true;
        storageSetKey('hasSeenRoyagiIntro', true).catch(() => {});
        const _pid1 = latestPlayerContext?.playerId;
        if (_pid1) nbFetch('/api/player-prefs', { method: 'POST', body: JSON.stringify({ playerId: _pid1, key: 'hasSeenRoyagiIntro', value: true }) }).catch(() => {});
        appendMessage('goat', "Ah, a fresh sprout seeking wisdom! I am Royagi, the old goat of this dojo — I've weathered more harvests than you've got hay bales. Ask me for the deep strategy on maximizing your Pixels, and I'll try not to buck any trends... too hard. What'll it be?");
        setTimeout(_afterGreeting, 400);
        return;
      }

      if (p === 'cat' && !nyankoIntroSeen) {
        nyankoIntroSeen = true;
        storageSetKey('hasSeenNyankoIntro', true).catch(() => {});
        const _pid2 = latestPlayerContext?.playerId;
        if (_pid2) nbFetch('/api/player-prefs', { method: 'POST', body: JSON.stringify({ playerId: _pid2, key: 'hasSeenNyankoIntro', value: true }) }).catch(() => {});
        appendMessage('cat', "Meow~ I'm Nyanko! You're clearly already doing great things around here. I'm here to help with strategy, tips, and a bit of encouragement along the way. What are we working on?");
        setTimeout(_afterGreeting, 400);
        return;
      }

      // All relevant intros already seen — casual greeting.
      appendMessage(p, CASUAL_GREETINGS[Math.floor(Math.random() * CASUAL_GREETINGS.length)]);
      // After greeting: profile setup (if not done) or morning brief
      setTimeout(_afterGreeting, 400);
    }

    function _afterGreeting() {
      if (_profileSetupActive) return;
      if (!_profileBackendLoaded) {
        // Backend prefs haven't settled yet — defer until they do.
        // _maybeStartSetupOrBrief() will be called from _loadPlayerPrefsFromBackend.
        return;
      }
      _maybeStartSetupOrBrief();
    }

    function _maybeStartSetupOrBrief() {
      if (_profileSetupActive) return;
      if (!profileLoaded) return;
      if (!playerProfile) {
        if (latestPlayerContext?.playerId) _startProfileSetup();
      } else {
        checkMorningBrief();
      }
    }

    // ---- First-activation + open / close ------------------------------------
    // handleToriiClick is wired to the corner torii button only.
    // First click (spriteShown === false): reveal the float sprite, open the panel,
    // and trigger the greeting flow via maybeShowGreeting().
    // Subsequent clicks: open (+ greet) if closed, close if already open.
    function handleToriiClick() {
      if (!spriteShown) {
        spriteShown = true;
        document.getElementById('px-float-sprite')?.classList.add('px-float-visible');
        openPanel();
        maybeShowGreeting();
      } else if (!isOpen) {
        openPanel();
        maybeShowGreeting();
      } else {
        closePanel();
      }
    }

    function togglePanel() {
      if (isOpen) { closePanel(); } else { openPanel(); }
    }

    function openPanel() {
      isOpen = true;
      document.getElementById('px-companion-panel')?.classList.add('px-visible');
      document.getElementById('px-companion-toggle')?.classList.add('px-open');
      // Float sprite stays visible beneath the panel — no hide/show here.
      const input = document.getElementById('px-input');
      if (input) input.focus();
    }

    function closePanel() {
      isOpen = false;
      document.getElementById('px-companion-panel')?.classList.remove('px-visible');
      document.getElementById('px-companion-toggle')?.classList.remove('px-open');
      // Float sprite was already visible and continues to be — no change needed.
    }

    // Full reset to torii-only state: hides sprite, resets activation flag.
    // Next torii click will re-run the first-activation path.
    function fullDismiss() {
      spriteShown = false;
      document.getElementById('px-float-sprite')?.classList.remove('px-float-visible');
      closePanel();
    }

    // ---- Persona switching ---------------------------------------------------
    function switchPersona(p) {
      if (!['pixin', 'goat', 'cat'].includes(p)) return;
      const prev = currentPersona;
      currentPersona = p;

      // Reset animation to idle on persona change so we don't carry stale walk state.
      spriteAnim.state = 'idle';

      // Float sprite is the only sprite element now (no panel header sprite).
      const floatSprite = document.getElementById('px-float-sprite');
      if (floatSprite) {
        const wasVisible = floatSprite.classList.contains('px-float-visible');
        floatSprite.className = getSpriteAnimClass(p) + (wasVisible ? ' px-float-visible' : '');
      }

      document.querySelectorAll('.px-persona-tab').forEach(btn => {
        btn.classList.toggle('px-persona-tab-active', btn.dataset.persona === p);
      });

      savePersona(p);

      // Switching to a different persona while the panel is open immediately
      // triggers that persona's intro (or a casual greeting if already seen).
      if (isOpen && p !== prev) maybeShowGreeting();
    }

    // ---- Floating sprite positioning -----------------------------------------
    // Converts player world coordinates to screen coordinates using the Phaser
    // camera's worldView, then positions the float sprite above the player.
    //
    // cam = {scrollX, scrollY, worldWidth, worldHeight} — from injected.js.
    // worldView.x = scrollX (world X of left viewport edge at current zoom).
    // Converting: relX = (worldX − scrollX) / worldWidth → fraction of canvas width.
    // Falls back to canvas center when player position / camera are unavailable.
    function worldToScreen(playerX, playerY, cam) {
      const canvas = document.querySelector('canvas');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;

      let relX, relY;
      if (playerX != null && playerY != null && cam?.worldWidth > 0 && cam?.worldHeight > 0) {
        relX = (playerX - cam.scrollX) / cam.worldWidth;
        relY = (playerY - cam.scrollY) / cam.worldHeight;
        relX = Math.max(-0.1, Math.min(1.1, relX));
        relY = Math.max(-0.1, Math.min(1.1, relY));
      } else {
        // Camera tracks the player — center of canvas ≈ player position.
        relX = 0.5;
        relY = 0.45;
      }

      return {
        x: rect.left + relX * rect.width,
        y: rect.top  + relY * rect.height,
      };
    }

    // Returns the CSS class string for the current animation state of a persona.
    function getSpriteAnimClass(persona) {
      const { state, dir } = spriteAnim;
      const p = persona === 'goat' ? 'goat' : persona === 'cat' ? 'nyanko' : 'pixin';
      if (state === 'start-trans' || state === 'stop-trans') return `px-sprite-${p}-trans-${dir}`;
      if (state === 'walk')  return `px-sprite-${p}-walk-${dir}`;
      return `px-sprite-${persona}`; // 'idle'
    }

    // Advances the spriteAnim state machine based on current player context,
    // then updates the float sprite's className if it changed.
    //
    // States:
    //   idle       → player stopped, idle sprite animation playing
    //   start-trans→ 100ms transition frame on first movement (or direction change)
    //   walk       → looping walk animation
    //   stop-trans → 100ms transition frame after stopping, then back to idle
    function updateSpriteAnim() {
      const ctx = latestPlayerContext;
      const isMoving = ctx?.isMoving ?? false;
      const facing   = ctx?.facing  ?? 'right';
      const now = performance.now();
      const el  = document.getElementById('px-float-sprite');
      if (!el || !spriteShown) return;

      const prev = spriteAnim.state;
      const prevDir = spriteAnim.dir;

      if (isMoving) {
        const dirChanged = facing !== spriteAnim.dir;
        if (dirChanged) spriteAnim.dir = facing;

        if (spriteAnim.state === 'idle' || spriteAnim.state === 'stop-trans' ||
            (spriteAnim.state === 'walk' && dirChanged)) {
          spriteAnim.state = 'start-trans';
          spriteAnim.transStart = now;
        } else if (spriteAnim.state === 'start-trans') {
          if (dirChanged) {
            spriteAnim.transStart = now; // restart trans for new direction
          } else if (now - spriteAnim.transStart >= TRANS_HOLD_MS) {
            spriteAnim.state = 'walk';
          }
        }
        // state === 'walk' and no direction change — stay in walk
      } else {
        if (spriteAnim.state === 'walk' || spriteAnim.state === 'start-trans') {
          spriteAnim.state = 'stop-trans';
          spriteAnim.transStart = now;
        } else if (spriteAnim.state === 'stop-trans') {
          if (now - spriteAnim.transStart >= TRANS_HOLD_MS) {
            spriteAnim.state = 'idle';
          }
        }
        // state === 'idle' — stay idle
      }

      if (spriteAnim.state !== prev || spriteAnim.dir !== prevDir) {
        if (window.PX_COMPANION_DEBUG) {
          console.log(`[companion] anim ${prev}→${spriteAnim.state} dir=${spriteAnim.dir}`);
        }
        const visibleClass = el.classList.contains('px-float-visible') ? ' px-float-visible' : '';
        el.className = getSpriteAnimClass(currentPersona) + visibleClass;
      }
    }

    // Runs every rAF tick. Positions the float sprite above the player.
    // Unlike the old design this runs regardless of isOpen so the sprite
    // stays in sync even when the panel is visible above it.
    function updateFloatSprite() {
      const el = document.getElementById('px-float-sprite');
      if (!el) return;

      updateSpriteAnim();

      const ctx = latestPlayerContext;
      const cam = latestCameraFrame;

      // Player is always at the camera center — never pass ctx.playerX/Y here.
      // Those values are for movement detection only (injected.js); using them
      // for rendering creates jitter from the temporal mismatch between the
      // energy-poller and camera-poller reads of cameras.main.worldView.
      const screen = worldToScreen(null, null, cam);
      if (!screen) return;

      // Layout box 48×64; scale(2) origin bottom-center.
      // Horizontal: sprite center 480px right of player → layout left = screen.x + 480 − 24.
      // Vertical: 0 offset → layout top at screen.y (level with player, not above).
      el.style.left = Math.round(screen.x + 456) + 'px';
      el.style.top  = Math.round(screen.y + 256) + 'px';
    }

    // Positions the panel so its bottom (including tail) sits just above the
    // float sprite's visual top.  Called every rAF tick when the panel is open.
    // Must use the SAME coordinate formula as updateFloatSprite() so the panel
    // tracks the sprite exactly — never the raw player position.
    function updatePanelPosition() {
      const panel = document.getElementById('px-companion-panel');
      if (!panel) return;

      const ctx = latestPlayerContext;
      const cam = latestCameraFrame;
      const screen = worldToScreen(null, null, cam);
      if (!screen) return;

      // Sprite top CSS = screen.y + 256. Scale(2) from bottom-center:
      // visual top = (screen.y + 256) − 64 = screen.y + 192.
      // Place panel bottom 8 px above visual top → screen.y + 192 − 8 = screen.y + 184.
      // bottom CSS = window.innerHeight − (screen.y + 184) = innerHeight − screen.y − 184.
      const panelBottom = window.innerHeight - screen.y - 184;

      // Sprite horizontal center = screen.x + 480. Shift panel further right to avoid game UI.
      const panelLeft = screen.x + 480 - 100; // = screen.x + 380
      const clampedLeft = Math.max(8, Math.min(window.innerWidth - 456, panelLeft));
      const clampedBottom = Math.round(Math.max(10, panelBottom));

      panel.style.transform = 'none'; // override CSS translateX(-50%) default
      panel.style.left   = Math.round(clampedLeft) + 'px';
      panel.style.bottom = clampedBottom + 'px';

      // Prevent panel from extending above the viewport — let #px-messages scroll.
      const availableHeight = window.innerHeight - clampedBottom - 10;
      panel.style.maxHeight = Math.round(Math.max(150, availableHeight)) + 'px';
    }

    // rAF loop — runs continuously every frame.
    function startFloatLoop() {
      function tick() {
        updateFloatSprite();
        if (isOpen) updatePanelPosition();
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }

    // ---- Camera frame handler ------------------------------------------------
    function onCameraFrame(cam) {
      latestCameraFrame = cam;
    }

    // ---- Message rendering ---------------------------------------------------
    function appendMessage(role, text, extra = '') {
      const id = ++msgCounter;

      const list = document.getElementById('px-messages');
      if (!list) return id;

      const empty = list.querySelector('.px-empty');
      if (empty) empty.remove();

      const div = document.createElement('div');
      div.id = `px-msg-${id}`;
      div.className = `px-msg px-msg-${role}${extra ? ` ${extra}` : ''}`;
      div.textContent = text;
      list.appendChild(div);
      list.scrollTop = list.scrollHeight;
      return id;
    }

    function removeMessage(id) {
      document.getElementById(`px-msg-${id}`)?.remove();
    }

    function updateMessage(id, text) {
      const el = document.getElementById(`px-msg-${id}`);
      if (el) {
        el.textContent = text;
        el.classList.remove('px-msg-loading');
        const list = document.getElementById('px-messages');
        if (list) list.scrollTop = list.scrollHeight;
      }
    }

    // ---- Premium modal -------------------------------------------------------
    function togglePremiumModal() {
      const modal = document.getElementById('px-premium-modal');
      if (modal) modal.classList.toggle('px-modal-visible');
    }

    // ---- Send ----------------------------------------------------------------
    const PERSONA_DISPLAY_NAMES = { pixin: 'Pixin', goat: 'Royagi', cat: 'Nyanko' };

    let _sendController  = null;  // AbortController for the in-flight /ask request
    let _pendingQuestion = '';    // saved so Stop can restore it to the input
    let _loadingMsgId    = null;  // id of the "thinking" bubble
    let _sendUserStopped = false; // true when user clicked Stop (vs. timeout)

    function _setSendStop(busy) {
      isBusy = busy;
      const input = document.getElementById('px-input');
      const send  = document.getElementById('px-send');
      if (input) input.disabled = busy;
      if (send) {
        send.innerHTML = busy ? '&#x25A0;' : '&#x27A4;'; // ■ vs ➤
        send.title     = busy ? 'Stop' : 'Send';
      }
    }

    function _stopMessage(question) {
      if (!isBusy || !_sendController) return;
      _sendUserStopped = true;
      _pendingQuestion = question;
      _sendController.abort();
    }

    async function sendMessage() {
      if (isBusy) return;
      const input = document.getElementById('px-input');
      if (!input) return;

      const question = input.value.trim();
      if (!question) return;

      input.value      = '';
      _pendingQuestion = question;
      _sendUserStopped = false;
      _setSendStop(true);

      const personaName = PERSONA_DISPLAY_NAMES[currentPersona] ?? 'Pixin';
      appendMessage('player', question);
      _loadingMsgId = appendMessage(currentPersona, `${personaName} is thinking…`, 'px-msg-loading');

      const controller = new AbortController();
      _sendController  = controller;
      const timeoutId  = setTimeout(() => controller.abort(), 120_000);

      try {
        const ctx = latestPlayerContext ?? {};
        const res = await fetch(`${BACKEND_URL}/ask`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          signal:  controller.signal,
          body:    JSON.stringify({
            question,
            context: {
              player:        Object.assign({}, ctx, hearthHallSeasonStart ? { hearthHallSeasonStart } : {}),
              walletAddress: ctx.walletAddress ?? null,
              persona:       currentPersona,
              profile:       playerProfile ?? undefined,
            },
          }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // Ignore late response if user stopped while awaiting json()
        if (_sendUserStopped) return;
        updateMessage(_loadingMsgId, data.answer ?? data.text ?? data.response ?? '(no response)');
      } catch (err) {
        if (_sendUserStopped) return; // stop path handled in finally
        console.warn(TAG, '/ask fetch failed:', err);
        if (err.name === 'AbortError') {
          updateMessage(_loadingMsgId, `${personaName} took too long to respond — please try again.`);
        } else {
          updateMessage(_loadingMsgId, 'Something went wrong — try again!');
        }
      } finally {
        clearTimeout(timeoutId);
        _sendController = null;
        _setSendStop(false);
        if (_sendUserStopped) {
          const bubble = document.getElementById(_loadingMsgId);
          if (bubble) bubble.remove();
          const inp = document.getElementById('px-input');
          if (inp) inp.value = _pendingQuestion;
          _sendUserStopped = false;
          _pendingQuestion = '';
        } else if (isOpen) {
          const inp = document.getElementById('px-input');
          if (inp) inp.focus();
        }
        _loadingMsgId = null;
      }
    }

    // ---- Game event handler --------------------------------------------------
    function onGameEvent({ type, message, data }) {
      // Timer events are shown regardless of panel state (proactive notifications)
      if (type === 'timerReady' || type === 'awayTimers') {
        appendMessage(currentPersona, message ?? '');
        return;
      }
      // Hearth Hall season detection
      if (type === 'hearthHallSeason') {
        hearthHallSeasonStart = data?.detectedAt ?? Date.now();
        const pid = latestPlayerContext?.playerId;
        if (pid) storageSetKey(`hearthHallSeason_${pid}`, hearthHallSeasonStart).catch(() => {});
        return;
      }
      // Map change — show "Now doing" reminder if set and within 2 hours
      if (type === 'map changed') {
        const mapId = data ?? message;
        if (nowDoingNote && (Date.now() - nowDoingSetAt) < 2 * 3_600_000) {
          if (mapId !== nowDoingLastRemindedMap) {
            nowDoingLastRemindedMap = mapId;
            appendMessage('pixin', `📌 ${nowDoingNote}`);
          }
        }
        return;
      }
      if (!isOpen) return;
      if (type === 'taskboard ready to deliver') {
        appendMessage('pixin', '✓ Taskboard order ready to deliver!');
      }
      if (type === 'stacked_offer_claimed') {
        appendMessage(currentPersona, 'Offer claimed! Reopen the Stacked App — new offers may have appeared.');
      }
    }

    // ---- Personal assistant helpers -----------------------------------------

    function _appendMessageWithChoices(role, text, choices, onChoice) {
      const id = appendMessage(role, text);
      const el = document.getElementById(`px-msg-${id}`);
      if (!el) return;
      const row = document.createElement('div');
      row.className = 'px-msg-choices';
      for (const { label, value } of choices) {
        const btn = document.createElement('button');
        btn.className = 'px-choice-btn';
        btn.textContent = label;
        btn.addEventListener('click', () => { row.remove(); onChoice(value, label); });
        row.appendChild(btn);
      }
      el.appendChild(row);
      const list = document.getElementById('px-messages');
      if (list) list.scrollTop = list.scrollHeight;
    }

    function _saveDraft() {
      const pid = latestPlayerContext?.playerId;
      if (!pid || Object.keys(_profileSetupData).length === 0) return;
      storageSetKey(`playerProfileDraft_${pid}`, _profileSetupData).catch(() => {});
      nbFetch('/api/player-prefs', { method: 'POST', body: JSON.stringify({ playerId: pid, key: 'playerProfileDraft', value: _profileSetupData }) }).catch(() => {});
    }

    function _startProfileSetup() {
      if (_profileSetupActive) return;
      _profileSetupActive = true;
      // Resume from draft if we have partial answers; otherwise start fresh.
      const resuming = Object.keys(_profileSetupData).length > 0;
      if (!resuming) _profileSetupData = {};
      appendMessage('pixin', resuming
        ? "Welcome back! Let's finish your setup."
        : "Hey! Quick setup — 4 taps and I'll know how to help you better.");
      setTimeout(_resumeProfileSetup, 300);
    }

    function _resumeProfileSetup() {
      // Resume at the first unanswered question.
      if (!_profileSetupData.playStyle) { _showProfileQ1(); return; }
      if (!_profileSetupData.goal)      { _showProfileQ2(); return; }
      if (_profileSetupData.goal !== 'everything' && _profileSetupData.goalTarget === undefined) { _showProfileQ2b(); return; }
      if (_profileSetupData.hasPet === undefined) { _showProfileQ3(); return; }
      if (!_profileSetupData.storage)   { _showProfileQ4(); return; }
      if (!_profileSetupData.taskboardMaxPrice) { _showProfileQ5(); return; }
      _finishProfileSetup(); // all answers present — finish immediately
    }

    function _showProfileQ1() {
      _appendMessageWithChoices('pixin', '🎮 How do you play?', [
        { label: 'Once a day', value: 'once_a_day' },
        { label: 'Twice a day', value: 'twice_a_day' },
        { label: 'Whenever I can', value: 'whenever' },
      ], (val) => { _profileSetupData.playStyle = val; _saveDraft(); _showProfileQ2(); });
    }

    function _showProfileQ2() {
      _appendMessageWithChoices('pixin', '🎯 Main goal?', [
        { label: 'Level up', value: 'level_up' },
        { label: 'Earn Pixels', value: 'earn_pixels' },
        { label: 'Earn coins', value: 'earn_coins' },
        { label: 'A bit of everything', value: 'everything' },
      ], (val) => {
        _profileSetupData.goal = val;
        _saveDraft();
        if (val !== 'everything') _showProfileQ2b();
        else _showProfileQ3();
      });
    }

    function _showProfileQ2b() {
      const id = appendMessage('pixin', '🎯 Any specific target? (e.g. "Stoneshaping 50", "1000 Pixels")');
      const el = document.getElementById(`px-msg-${id}`);
      if (!el) { _showProfileQ3(); return; }
      const row = document.createElement('div');
      row.className = 'px-msg-choices';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'px-profile-input';
      inp.placeholder = 'Target (optional)'; inp.maxLength = 100;
      ['keydown','keyup','keypress'].forEach(ev =>
        inp.addEventListener(ev, e => { e.stopPropagation(); e.stopImmediatePropagation(); }));
      const finish = (skip) => {
        if (!skip) { const v = inp.value.trim(); if (v) _profileSetupData.goalTarget = v; }
        else { _profileSetupData.goalTarget = null; } // mark as explicitly skipped for resume
        _saveDraft();
        row.remove(); _showProfileQ3();
      };
      const setBtn = document.createElement('button'); setBtn.className = 'px-choice-btn'; setBtn.textContent = 'Set';
      const skipBtn = document.createElement('button'); skipBtn.className = 'px-choice-btn'; skipBtn.textContent = 'Skip';
      setBtn.addEventListener('click', () => finish(false));
      skipBtn.addEventListener('click', () => finish(true));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(false); } });
      row.appendChild(inp); row.appendChild(setBtn); row.appendChild(skipBtn);
      el.appendChild(row);
      const list = document.getElementById('px-messages');
      if (list) list.scrollTop = list.scrollHeight;
      setTimeout(() => inp.focus(), 50);
    }

    function _showProfileQ3() {
      const ctx = latestPlayerContext;
      // Auto-detect pets: check hasPet (from selfPlayer.pet) or petAvatar from GPlayerCore.
      const hasPetAuto = ctx?.hasPet !== null && ctx?.hasPet !== undefined ? ctx.hasPet
        : (ctx?.petAvatar != null ? true : null);
      const detectedCount = hasPetAuto === true ? 1 : hasPetAuto === false ? 0 : null;
      if (hasPetAuto !== null) {
        _profileSetupData.hasPet = hasPetAuto;
        _profileSetupData.petCount = detectedCount;
        _profileSetupData.petNames = ctx?.petNames ?? [];
        _profileSetupData.petDetected = true;
        _saveDraft();
        if (hasPetAuto) {
          const nameStr = _profileSetupData.petNames.length > 0 ? ` (${_profileSetupData.petNames.join(', ')})` : '';
          appendMessage('pixin', `🐾 Pets: ${detectedCount} detected${nameStr} — skipping that question!`);
        }
        _showProfileQ4(); return;
      }
      _appendMessageWithChoices('pixin', '🐾 Do you have a pet?', [
        { label: 'Yes', value: true },
        { label: 'No', value: false },
      ], (val) => { _profileSetupData.hasPet = val; _profileSetupData.petDetected = false; _saveDraft(); _showProfileQ4(); });
    }

    function _showProfileQ4() {
      // Auto-detect storage from chest scan: skip question if chests are already known.
      const ctx = latestPlayerContext;
      const chestCount = Object.keys(ctx?.storageChests ?? {}).length;
      if (chestCount > 0) {
        const storage = chestCount >= 4 ? 'lots' : chestCount >= 2 ? 'some' : 'very_little';
        _profileSetupData.storage = storage;
        _profileSetupData.storageDetected = true;
        _profileSetupData.chestCount = chestCount;
        _saveDraft();
        _showProfileQ5(); return;
      }
      _appendMessageWithChoices('pixin', '📦 Storage space?', [
        { label: 'Lots', value: 'lots' },
        { label: 'Some', value: 'some' },
        { label: 'Very little', value: 'very_little' },
      ], (val) => { _profileSetupData.storage = val; _profileSetupData.storageDetected = false; _saveDraft(); _showProfileQ5(); });
    }

    function _showProfileQ5() {
      _appendMessageWithChoices('pixin', '📋 Most you\'d pay for one Taskboard order?', [
        { label: '60,000', value: 60000 },
        { label: '80,000', value: 80000 },
        { label: '100,000', value: 100000 },
        { label: '120,000+', value: 120000 },
      ], (val) => {
        _profileSetupData.taskboardMaxPrice = val;
        _profileSetupData.taskboardTooExpensive = Math.round(val * 1.25 / 10000) * 10000;
        _saveDraft();
        _finishProfileSetup();
      });
    }

    function _finishProfileSetup() {
      _profileSetupActive = false;
      const profile = { ..._profileSetupData, setupAt: Date.now() };
      playerProfile = profile;
      _profileSetupData = {};
      const pid = latestPlayerContext?.playerId;
      if (pid) {
        storageSetKey(`playerProfile_${pid}`, profile).catch(e => console.warn(TAG, 'save profile', e));
        // Clear the draft now that setup is complete
        storageDeleteKey(`playerProfileDraft_${pid}`).catch(() => {});
        nbFetch('/api/player-prefs', { method: 'POST', body: JSON.stringify({ playerId: pid, key: 'playerProfile', value: profile }) }).catch(() => {});
        nbFetch('/api/player-prefs', { method: 'POST', body: JSON.stringify({ playerId: pid, key: 'playerProfileDraft', value: null }) }).catch(() => {});
      }
      appendMessage('pixin', '✅ All set! Update it anytime in Diary → My profile.');
      renderProfileTab();
    }

    async function _loadProfileForPlayer(pid) {
      try {
        const [profile, draft, hhSeason, nowDoing] = await Promise.all([
          storageGetKey(`playerProfile_${pid}`),
          storageGetKey(`playerProfileDraft_${pid}`),
          storageGetKey(`hearthHallSeason_${pid}`),
          storageGetKey(`nowDoing_${pid}`),
        ]);
        if (profile) playerProfile = profile;
        if (draft && !profile) _profileSetupData = draft; // resume draft if no completed profile
        if (hhSeason) hearthHallSeasonStart = hhSeason;
        if (nowDoing) { nowDoingNote = nowDoing.note ?? ''; nowDoingSetAt = nowDoing.setAt ?? 0; }
        renderProfileTab();
      } catch (e) { console.warn(TAG, '_loadProfileForPlayer', e); }
      // Load prefs from backend so intro flags + profile survive reinstall.
      // _loadPlayerPrefsFromBackend sets _profileBackendLoaded and calls _maybeStartSetupOrBrief.
      _loadPlayerPrefsFromBackend(pid).catch(() => { _profileBackendLoaded = true; _maybeStartSetupOrBrief(); });
    }

    async function _loadPlayerPrefsFromBackend(pid) {
      try {
        const resp = await nbFetch(`/api/player-prefs?playerId=${encodeURIComponent(pid)}`);
        if (!resp.ok) { _profileBackendLoaded = true; _maybeStartSetupOrBrief(); return; }
        const prefs = await resp.json();
        // Intro flags — set in-memory + local cache if backend says seen
        if (prefs.hasSeenIntro       && !introSeen)       { introSeen       = true; storageSetKey('hasSeenIntro', true).catch(() => {}); }
        if (prefs.hasSeenRoyagiIntro && !royagiIntroSeen) { royagiIntroSeen = true; storageSetKey('hasSeenRoyagiIntro', true).catch(() => {}); }
        if (prefs.hasSeenNyankoIntro && !nyankoIntroSeen) { nyankoIntroSeen = true; storageSetKey('hasSeenNyankoIntro', true).catch(() => {}); }
        // Profile — backend wins if no local profile; else keep local (it may be newer)
        if (prefs.playerProfile && !playerProfile) {
          playerProfile = prefs.playerProfile;
          storageSetKey(`playerProfile_${pid}`, playerProfile).catch(() => {});
          renderProfileTab();
        }
        // Draft — resume an abandoned setup
        if (prefs.playerProfileDraft && !playerProfile && !_profileSetupActive) {
          _profileSetupData = prefs.playerProfileDraft;
          storageSetKey(`playerProfileDraft_${pid}`, _profileSetupData).catch(() => {});
        }
        // XP baseline — merge backend into local (local wins on a per-day conflict since it's more recent)
        if (prefs.xpBaseline) {
          const local = (await storageGetKey(`xpBaseline_${pid}`)) ?? {};
          const merged = { ...prefs.xpBaseline, ...local }; // local wins per-day
          const keys = Object.keys(merged).sort();
          while (keys.length > 7) delete merged[keys.shift()];
          await storageSetKey(`xpBaseline_${pid}`, merged);
        }
      } catch (_) { /* offline — fine, use local cache */ }
      _profileBackendLoaded = true;
      _maybeStartSetupOrBrief();
    }

    function renderProfileTab() {
      const el = document.getElementById('px-nb-profile-content');
      if (!el) return;
      if (!playerProfile) { el.textContent = 'No profile yet — tap "Update profile" to set one up.'; return; }
      const p = playerProfile;
      const psMap = { once_a_day: 'Once a day', twice_a_day: 'Twice a day', whenever: 'Whenever I can' };
      const glMap = { level_up: 'Level up', earn_pixels: 'Earn Pixels', earn_coins: 'Earn coins', everything: 'A bit of everything' };
      const stMap = { lots: 'Lots', some: 'Some', very_little: 'Very little' };
      // Pet display: show detected count and names when auto-detected
      let petLine;
      if (p.petDetected && p.petCount != null) {
        const nameStr = Array.isArray(p.petNames) && p.petNames.length > 0
          ? ` (${p.petNames.join(', ')})` : '';
        petLine = `Pets: ${p.petCount} (detected${nameStr})`;
      } else {
        petLine = `Pet: ${p.hasPet === true ? 'Yes' : p.hasPet === false ? 'No' : '—'}`;
      }
      // Storage display: show detected chest count when auto-detected
      const storageSrc = p.storageDetected && p.chestCount != null
        ? `${stMap[p.storage] ?? p.storage} (${p.chestCount} chests detected)`
        : (stMap[p.storage] ?? p.storage ?? '—');
      el.textContent = [
        `Play style: ${psMap[p.playStyle] ?? p.playStyle ?? '—'}`,
        `Goal: ${glMap[p.goal] ?? p.goal ?? '—'}${p.goalTarget ? ` — ${p.goalTarget}` : ''}`,
        petLine,
        `Storage: ${storageSrc}`,
        `Taskboard max: ${p.taskboardMaxPrice?.toLocaleString?.() ?? '—'} coins`,
        `Too pricey above: ${p.taskboardTooExpensive?.toLocaleString?.() ?? '—'} coins`,
      ].join('\n');
    }

    // ---- Morning brief -------------------------------------------------------

    function _utcDateStr() {
      const d = new Date();
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }

    async function checkMorningBrief() {
      const pid = latestPlayerContext?.playerId;
      if (!pid || !playerProfile) return;
      const today = _utcDateStr();
      // In-memory guard prevents race condition when called twice before the async storage read resolves
      if (_briefShownDate === today) return;
      _briefShownDate = today;
      const key = `morningBriefDate_${pid}`;
      const last = await storageGetKey(key);
      if (last === today) return;
      await storageSetKey(key, today);
      showMorningBrief(false);
    }

    function showMorningBrief(force) {
      const lines = _buildMorningBriefLines();
      if (!lines || lines.length === 0) return;
      const id = appendMessage('pixin', lines.join('\n'));
      const el = document.getElementById(`px-msg-${id}`);
      if (!el) return;
      el.style.whiteSpace = 'pre-line';
      const row = document.createElement('div');
      row.className = 'px-msg-choices';
      const moreBtn = document.createElement('button');
      moreBtn.className = 'px-choice-btn'; moreBtn.textContent = 'More';
      moreBtn.addEventListener('click', () => { row.remove(); openNotebook('diary'); });
      const gotItBtn = document.createElement('button');
      gotItBtn.className = 'px-choice-btn'; gotItBtn.textContent = 'Got it';
      gotItBtn.addEventListener('click', () => { row.remove(); el.style.opacity = '0.7'; });
      row.appendChild(moreBtn); row.appendChild(gotItBtn);
      el.appendChild(row);
      const list = document.getElementById('px-messages');
      if (list) list.scrollTop = list.scrollHeight;
    }

    function _buildMorningBriefLines() {
      const ctx = latestPlayerContext;
      const lines = [];

      // ✅ Ready activity timers — grouped by place
      const timers = ctx?.activityTimers;
      if (Array.isArray(timers) && timers.length > 0) {
        const ready = timers.filter(t => t.readyAt && t.readyAt <= Date.now());
        if (ready.length > 0) {
          const byPlace = {};
          for (const t of ready) {
            const place = t.landLabel ?? t.mapId ?? 'elsewhere';
            (byPlace[place] = byPlace[place] ?? []).push(t.itemLabel ?? t.entityLabel ?? 'timer');
          }
          const parts = Object.entries(byPlace).map(([pl, items]) => `${items.join(', ')} (${pl})`);
          lines.push(`✅ Ready: ${parts.join('; ')}`);
        }
      }

      // 🎁 Free Post Office parcel (daily reminder)
      lines.push('🎁 Free Post Office parcel available');

      // 🐾 Pet Shop gift — only if player has a pet
      if (playerProfile?.hasPet) lines.push('🐾 Pet Shop gift ready');

      // 🎮 Neon Zone day
      const dow = new Date().getUTCDay();
      if (dow === 1) lines.push('🎮 New Neon Zone week started');
      else if (dow === 0) lines.push('🎮 Last day of Neon Zone week');

      // 🔥 New Hearth Hall season (if detected within last 7 days)
      if (hearthHallSeasonStart && Date.now() - hearthHallSeasonStart < 7 * 86_400_000) {
        lines.push('🔥 New Hearth Hall season has started');
      }

      // 🎯 Goal progress
      const goalLine = _buildGoalProgressLine();
      if (goalLine) lines.push(goalLine);

      // 📋 Stacked App offers
      const stacked = ctx?.stackedOffers;
      if (Array.isArray(stacked) && stacked.length > 0) {
        const soonest = stacked.reduce((a, b) => {
          const aExp = a.expiresAt ?? Infinity;
          const bExp = b.expiresAt ?? Infinity;
          return bExp < aExp ? b : a;
        }, stacked[0]);
        if (soonest) {
          const count = stacked.length;
          const leftMs = soonest.expiresAt ? soonest.expiresAt - Date.now() : null;
          const timeStr = leftMs !== null && leftMs > 0
            ? leftMs < 3_600_000
              ? `${Math.round(leftMs / 60_000)}m`
              : (() => { const h = Math.floor(leftMs / 3_600_000); const m = Math.floor((leftMs % 3_600_000) / 60_000); return m > 0 ? `${h}h ${m}m` : `${h}h`; })()
            : null;
          lines.push(`📋 Stacked: ${count} offer${count !== 1 ? 's' : ''}${timeStr !== null ? `, next ends in ${timeStr}` : ''}`);
        }
      }

      // 📉 Taskboard pricey warning
      const taskboard = ctx?.taskboard;
      const tooExp = playerProfile?.taskboardTooExpensive ?? 100_000;
      if (Array.isArray(taskboard) && taskboard.length > 1) {
        const pricey = taskboard.filter(o => ((o.marketPrice ?? o.price ?? 0) * (o.quantity ?? 1)) > tooExp);
        if (pricey.length > taskboard.length / 2) {
          lines.push("📉 Taskboard's pricey today — level skills instead");
        }
      }

      // Always last
      lines.push('Open your Taskboard + Stacked and I\'ll plan today 👇');
      return lines.slice(0, 8);
    }

    function _buildGoalProgressLine() {
      const target = playerProfile?.goalTarget;
      if (!target) return null;
      const ctx = latestPlayerContext;
      const skills = ctx?.skills;
      if (!skills || typeof skills !== 'object') return null;
      const m = target.match(/^(.+?)\s+(\d+)$/);
      if (!m) return null;
      const needle = m[1].toLowerCase().replace(/[^a-z]/g, '');
      const targetLv = parseInt(m[2]);
      const key = Object.keys(skills).find(k => k.toLowerCase().replace(/[^a-z]/g, '') === needle);
      if (!key) return null;
      const lv = skills[key]?.level ?? 0;
      if (lv >= targetLv) return `🎯 Goal "${m[1]} ${targetLv}" — done! 🎉`;
      return `🎯 ${m[1]}: level ${lv}/${targetLv}`;
    }

    // ---- "What was I doing?" -------------------------------------------------

    function showWhatWasDoing() {
      if (isBusy) return;
      const ctx = latestPlayerContext;
      const parts = [];

      if (playerProfile?.goal && playerProfile.goal !== 'everything') {
        const glMap = { level_up: 'Level up', earn_pixels: 'Earn Pixels', earn_coins: 'Earn coins' };
        parts.push(`🎯 Goal: ${glMap[playerProfile.goal] ?? playerProfile.goal}${playerProfile.goalTarget ? ` — ${playerProfile.goalTarget}` : ''}`);
      }

      const timers = ctx?.activityTimers;
      if (Array.isArray(timers) && timers.length > 0) {
        const latest = timers.reduce((a, b) => ((b.startedAt ?? 0) > (a.startedAt ?? 0) ? b : a), timers[0]);
        if (latest) {
          parts.push(`⏱️ Last started: ${latest.itemLabel ?? latest.entityLabel ?? 'activity'} (${latest.landLabel ?? latest.mapId ?? 'somewhere'})`);
        }
      }

      const active = nowDoingNote && (Date.now() - nowDoingSetAt) < 2 * 3_600_000 ? nowDoingNote : null;
      if (active) parts.push(`📌 Doing: ${active}`);

      if (parts.length === 0) parts.push('Nothing tracked yet — set a note below!');

      const id = appendMessage('pixin', parts.join('\n'));
      const el = document.getElementById(`px-msg-${id}`);
      if (!el) return;
      el.style.whiteSpace = 'pre-line';

      const row = document.createElement('div');
      row.className = 'px-msg-choices';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'px-profile-input';
      inp.placeholder = 'Now doing… (clears after 2h)'; inp.maxLength = 150;
      inp.value = nowDoingNote || '';
      ['keydown','keyup','keypress'].forEach(ev =>
        inp.addEventListener(ev, e => { e.stopPropagation(); e.stopImmediatePropagation(); }));
      const doSet = () => {
        const val = inp.value.trim();
        nowDoingNote = val; nowDoingSetAt = val ? Date.now() : 0; nowDoingLastRemindedMap = null;
        const pid = latestPlayerContext?.playerId;
        if (pid) storageSetKey(`nowDoing_${pid}`, { note: val, setAt: nowDoingSetAt }).catch(() => {});
        row.remove();
        appendMessage('pixin', val ? `📌 Got it: "${val}"` : '📌 Note cleared.');
      };
      const setBtn = document.createElement('button'); setBtn.className = 'px-choice-btn'; setBtn.textContent = 'Set note';
      const clrBtn = document.createElement('button'); clrBtn.className = 'px-choice-btn'; clrBtn.textContent = 'Clear';
      setBtn.addEventListener('click', doSet);
      clrBtn.addEventListener('click', () => { inp.value = ''; doSet(); });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSet(); } });
      row.appendChild(inp); row.appendChild(setBtn); row.appendChild(clrBtn);
      el.appendChild(row);
      const list = document.getElementById('px-messages');
      if (list) list.scrollTop = list.scrollHeight;
      setTimeout(() => inp.focus(), 50);
    }

    // ---- Init ----------------------------------------------------------------
    async function init() {
      // 1. Fetch sprites as data URLs (bypasses page CSP on injected <style> tags).
      let urls;
      try {
        const [
          pixin, goat, cat,
          pixinTransLeft, pixinTransRight, pixinWalkLeft, pixinWalkRight,
          nyankoTransLeft, nyankoTransRight, nyankoWalkLeft, nyankoWalkRight,
          royagiTrans, royagiWalkLeft, royagiWalkRight,
        ] = await Promise.all([
          fetchDataUrl('assets/pixin-idle.png'),
          fetchDataUrl('assets/royagi-idle.png'),
          fetchDataUrl('assets/nyanko-idle.png'),
          fetchDataUrl('assets/pixin-transition-left.png'),
          fetchDataUrl('assets/pixin-transition-right.png'),
          fetchDataUrl('assets/pixin-walk-left.png'),
          fetchDataUrl('assets/pixin-walk-right.png'),
          fetchDataUrl('assets/nyanko-transition-left.png'),
          fetchDataUrl('assets/nyanko-transition-right.png'),
          fetchDataUrl('assets/nyanko-walk-left.png'),
          fetchDataUrl('assets/nyanko-walk-right.png'),
          fetchDataUrl('assets/royagi-transition.png'),
          fetchDataUrl('assets/royagi-walk-left.png'),
          fetchDataUrl('assets/royagi-walk-right.png'),
        ]);
        urls = {
          pixin, goat, cat,
          pixinTransLeft, pixinTransRight, pixinWalkLeft, pixinWalkRight,
          nyankoTransLeft, nyankoTransRight, nyankoWalkLeft, nyankoWalkRight,
          royagiTrans, royagiWalkLeft, royagiWalkRight,
        };
      } catch (err) {
        console.warn(TAG, 'sprite fetch failed, falling back to extension URLs:', err);
        const u = (f) => chrome.runtime.getURL(f);
        urls = {
          pixin:           u('assets/pixin-idle.png'),
          goat:            u('assets/royagi-idle.png'),
          cat:             u('assets/nyanko-idle.png'),
          pixinTransLeft:  u('assets/pixin-transition-left.png'),
          pixinTransRight: u('assets/pixin-transition-right.png'),
          pixinWalkLeft:   u('assets/pixin-walk-left.png'),
          pixinWalkRight:  u('assets/pixin-walk-right.png'),
          nyankoTransLeft: u('assets/nyanko-transition-left.png'),
          nyankoTransRight:u('assets/nyanko-transition-right.png'),
          nyankoWalkLeft:  u('assets/nyanko-walk-left.png'),
          nyankoWalkRight: u('assets/nyanko-walk-right.png'),
          royagiTrans:     u('assets/royagi-transition.png'),
          royagiWalkLeft:  u('assets/royagi-walk-left.png'),
          royagiWalkRight: u('assets/royagi-walk-right.png'),
        };
      }

      // 2. Load saved persona so buildDOM() renders the right sprite from first paint.
      const saved = await loadPersona();
      if (saved) currentPersona = saved;

      // 3. Inject CSS then build DOM (order matters — styles before elements).
      injectStyles(urls);
      buildDOM();

      // 4. Load all intro flags so greeting logic has the right state before
      //    any user interaction.  Float sprite and panel stay hidden — the user
      //    must click the torii button to activate the companion.
      const [seenIntro, seenRoyagi, seenNyanko] = await Promise.all([
        storageGetKey('hasSeenIntro'),
        storageGetKey('hasSeenRoyagiIntro'),
        storageGetKey('hasSeenNyankoIntro'),
      ]);
      introSeen       = !!seenIntro;
      royagiIntroSeen = !!seenRoyagi;
      nyankoIntroSeen = !!seenNyanko;
      startFloatLoop();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }

    // ---- Notebook / Diary helpers -------------------------------------------

    function nbPlayerId() {
      return latestPlayerContext?.playerId ?? null;
    }

    function nbFetch(path, options) {
      return fetch(`${BACKEND_URL}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...(options || {}),
      });
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatTimeRemaining(fireAt) {
      const remaining = fireAt - Date.now();
      if (remaining <= 0) return 'Ready!';
      const s = Math.ceil(remaining / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      if (h > 0) return `${h}h ${m}m ${sec}s`;
      if (m > 0) return `${m}m ${sec}s`;
      return `${sec}s`;
    }

    function updateTimerCountdowns() {
      document.querySelectorAll('.px-nb-timer-countdown').forEach(el => {
        const fireAt = Number(el.dataset.fire);
        if (fireAt) el.textContent = formatTimeRemaining(fireAt);
      });
    }

    function startTimerCountdown() {
      stopTimerCountdown();
      timerCountdownInterval = setInterval(updateTimerCountdowns, 1000);
    }

    function stopTimerCountdown() {
      if (timerCountdownInterval) { clearInterval(timerCountdownInterval); timerCountdownInterval = null; }
    }

    // ---- Storage pop-up -------------------------------------------------------

    async function _loadStorageMeta() {
      if (_storageMeta) return _storageMeta;
      if (_storageMetaLoading) return null;
      _storageMetaLoading = true;
      try {
        const res = await fetch(`${BACKEND_URL}/api/items-meta`);
        if (res.ok) _storageMeta = await res.json();
      } catch (_) {}
      _storageMetaLoading = false;
      return _storageMeta;
    }

    function _stParseMapLabel(mapId) {
      if (!mapId) return { label: 'Location not seen yet', sort: 99 };
      if (mapId.startsWith('shareInterior')) {
        const suffix = mapId.slice('shareInterior'.length);
        const nft = suffix.match(/^pixelsNFTFarm-?(\d+)/);
        if (nft) return { label: `Land ${nft[1]} — inside`, sort: 20 + parseInt(nft[1], 10) };
        return { label: 'Speck — inside', sort: 1 };
      }
      if (mapId.startsWith('shareRent')) return { label: 'Speck — outside', sort: 0 };
      const nftMatch = mapId.match(/^pixelsNFTFarm-?(\d+)/);
      if (nftMatch) return { label: `Land ${nftMatch[1]} — outside`, sort: 10 + parseInt(nftMatch[1], 10) };
      return { label: mapId, sort: 50 };
    }

    function _stTimeAgo(ms) {
      if (!ms) return 'unknown';
      const s = Math.floor((Date.now() - ms) / 1000);
      if (s < 5) return 'just now';
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      return `${Math.floor(s / 3600)}h ago`;
    }

    function _stEsc(str) {
      return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _stIcon(itemId, meta, cls) {
      const info = meta?.[itemId];
      if (info?.imageUrl) {
        return `<img class="${cls}" src="${_stEsc(info.imageUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`;
      }
      return `<div class="${cls}-ph">?</div>`;
    }

    // Build a grid tile as a DOM element with inline styles (immune to game CSS overrides).
    function _stTileEl(id, qty, meta) {
      const tile = document.createElement('div');
      tile.title = _stName(id, meta);
      tile.style.cssText = 'position:relative;width:46px;height:46px;flex:0 0 46px;display:flex;align-items:center;justify-content:center;background:#f3ead8;border-radius:4px;overflow:visible;box-sizing:border-box;cursor:default;';
      tile.addEventListener('mouseenter', () => { tile.style.background = '#e8dfc8'; });
      tile.addEventListener('mouseleave', () => { tile.style.background = '#f3ead8'; });
      const info = meta?.[id];
      if (info?.imageUrl) {
        const img = document.createElement('img');
        img.src = info.imageUrl;
        img.alt = '';
        img.loading = 'lazy';
        img.style.cssText = 'max-width:40px;max-height:40px;image-rendering:pixelated;display:block;';
        img.onerror = function() {
          console.log('[px-storage] icon load failed:', id, info.imageUrl);
          this.style.display = 'none';
          // Replace with initials fallback
          const fb = document.createElement('div');
          const fbName = info?.name ?? id.replace(/^itm_/, '').replace(/_/g, ' ');
          const initials = fbName.split(/\s+/).slice(0, 2).map(w => (w[0] ?? '').toUpperCase()).join('');
          console.log('[px-storage] initials fallback:', id, 'name:', fbName, 'initials:', initials);
          fb.style.cssText = 'width:34px;height:34px;background:#e0d8c8;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#888;font-weight:600;';
          fb.textContent = initials || '?';
          tile.insertBefore(fb, this.nextSibling || null);
        };
        tile.appendChild(img);
      } else {
        if (id) console.log('[px-storage] no imageUrl for item:', id, 'meta entry:', !!info);
        const ph = document.createElement('div');
        const phName = info?.name ?? meta?.[id]?.name ?? id.replace(/^itm_/, '').replace(/_/g, ' ');
        const initials = phName.split(/\s+/).slice(0, 2).map(w => (w[0] ?? '').toUpperCase()).join('');
        console.log('[px-storage] initials fallback:', id, 'name:', phName, 'initials:', initials);
        ph.style.cssText = 'width:34px;height:34px;background:#e0d8c8;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#888;font-weight:600;';
        ph.textContent = initials || '?';
        tile.appendChild(ph);
      }
      const badge = document.createElement('span');
      badge.style.cssText = 'position:absolute;right:2px;bottom:1px;font-size:10px;padding:0 3px;background:rgba(0,0,0,0.6);color:#fff;border-radius:3px;line-height:13px;pointer-events:none;';
      badge.textContent = `\xd7${qty}`;
      tile.appendChild(badge);
      return tile;
    }

    function _stName(itemId, meta) {
      return meta?.[itemId]?.name ?? itemId;
    }

    function openStorageModal() {
      storageOpen = true;
      document.getElementById('px-storage-modal').classList.add('px-modal-visible');
      _renderStorage();
    }

    function closeStorageModal() {
      storageOpen = false;
      document.getElementById('px-storage-modal').classList.remove('px-modal-visible');
    }

    async function _renderStorage() {
      const content = document.getElementById('px-storage-content');
      if (!content) return;
      content.innerHTML = '<div style="padding:12px;font-size:8px;color:#888;font-family:inherit">Loading…</div>';

      const meta = await _loadStorageMeta();
      if (!document.getElementById('px-storage-modal')?.classList.contains('px-modal-visible')) return;

      const ctx     = latestPlayerContext ?? {};
      const chests  = ctx.storageChests ?? {};
      const inv     = ctx.inventory ?? {};
      const rawSearch = document.getElementById('px-storage-search')?.value ?? '';
      const search  = rawSearch.trim().toLowerCase();

      if (_storageMode === 'totals') {
        _renderStorageTotals(content, chests, inv, meta, search);
      } else {
        _renderStorageBrowse(content, chests, inv, meta, search);
      }
    }

    function _renderStorageBrowse(content, chests, inv, meta, search) {
      content.innerHTML = '';
      const rawSearch = document.getElementById('px-storage-search')?.value ?? '';
      const GRID_STYLE = 'display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start;margin-top:5px;';
      let hasContent = false;

      function makeSection(labelHtml, countHtml, entries) {
        const wrap = document.createElement('div');
        wrap.innerHTML = `<div class=”px-st-section-hdr”><span>${labelHtml}</span><span class=”px-st-section-count”>${countHtml}</span></div>`;
        const grid = document.createElement('div');
        grid.style.cssText = GRID_STYLE;
        if (entries.length > 0) {
          for (const [id, qty] of entries) grid.appendChild(_stTileEl(id, qty, meta));
        } else {
          const empty = document.createElement('div');
          empty.className = 'px-st-chest-empty';
          empty.textContent = search ? 'No matches' : 'Empty';
          grid.appendChild(empty);
        }
        wrap.appendChild(grid);
        return wrap;
      }

      // Backpack — sorted by qty desc
      const bpEntries = Object.entries(inv)
        .filter(([id, qty]) => qty > 0 && (!search || _stName(id, meta).toLowerCase().includes(search)))
        .sort((a, b) => b[1] - a[1]);
      const bpTotal = bpEntries.reduce((s, [, q]) => s + q, 0);
      if (!search || bpEntries.length > 0) {
        content.appendChild(makeSection(
          'Backpack',
          `${bpEntries.length} types \xb7 ${bpTotal} items`,
          bpEntries
        ));
        hasContent = true;
      }

      // Group chests by location; merge items across all chests in each location
      const byLoc = {};
      for (const [, chest] of Object.entries(chests)) {
        const { label, sort } = _stParseMapLabel(chest.landId);
        if (!byLoc[label]) byLoc[label] = { sort, chestCount: 0, merged: {}, newestAt: 0 };
        byLoc[label].chestCount++;
        byLoc[label].newestAt = Math.max(byLoc[label].newestAt, chest.capturedAt ?? 0);
        for (const { itemId, qty } of chest.items) {
          byLoc[label].merged[itemId] = (byLoc[label].merged[itemId] ?? 0) + qty;
        }
      }
      const sortedLocs = Object.entries(byLoc).sort((a, b) => a[1].sort - b[1].sort || a[0].localeCompare(b[0]));

      for (const [locLabel, { chestCount, merged, newestAt }] of sortedLocs) {
        let locItems = Object.entries(merged).filter(([, q]) => q > 0);
        if (search) locItems = locItems.filter(([id]) => _stName(id, meta).toLowerCase().includes(search));
        if (search && locItems.length === 0) continue;
        locItems.sort((a, b) => b[1] - a[1]);
        const locTotal = Object.values(merged).reduce((s, q) => s + q, 0);
        content.appendChild(makeSection(
          _stEsc(locLabel),
          `${chestCount} chest${chestCount !== 1 ? 's' : ''} \xb7 ${locTotal} items \xb7 ${_stTimeAgo(newestAt)}`,
          locItems
        ));
        hasContent = true;
      }

      if (!hasContent) {
        const empty = document.createElement('div');
        empty.className = 'px-st-empty';
        empty.textContent = 'No storage data yet — visit your lands to load chests.';
        content.appendChild(empty);
        return;
      }

      if (search) {
        const totalQty = bpEntries.reduce((s, [, q]) => s + q, 0)
          + Object.values(chests).reduce((s, c) =>
            s + c.items.filter(i => _stName(i.itemId, meta).toLowerCase().includes(search)).reduce((a, i) => a + i.qty, 0), 0);
        const summary = document.createElement('div');
        summary.className = 'px-st-search-summary';
        summary.textContent = `”${rawSearch.trim()}” — ${totalQty} total across all storage`;
        content.insertBefore(summary, content.firstChild);
      }
    }

    function _renderStorageTotals(content, chests, inv, meta, search) {
      const totals = {};
      const addItem = (id, qty, source) => {
        if (!totals[id]) totals[id] = { qty: 0, sources: [] };
        totals[id].qty += qty;
        totals[id].sources.push(source);
      };

      for (const [id, qty] of Object.entries(inv)) {
        if (qty > 0) addItem(id, qty, 'Backpack');
      }
      for (const [, chest] of Object.entries(chests)) {
        const { label } = _stParseMapLabel(chest.landId);
        for (const { itemId, qty } of chest.items) {
          addItem(itemId, qty, label);
        }
      }

      let entries = Object.entries(totals)
        .filter(([, t]) => t.qty > 0)
        .sort((a, b) => _stName(a[0], meta).localeCompare(_stName(b[0], meta)));

      if (search) entries = entries.filter(([id]) => _stName(id, meta).toLowerCase().includes(search));

      if (entries.length === 0) {
        content.innerHTML = `<div class="px-st-empty">${search ? 'No items match.' : 'No storage data yet.'}</div>`;
        return;
      }

      content.innerHTML = entries.map(([id, { qty, sources }]) => {
        const name = _stName(id, meta);
        const uniqSrc = [...new Set(sources)].join(', ');
        return `<div class="px-st-totals-row">
          ${_stIcon(id, meta, 'px-st-totals-icon')}
          <span class="px-st-totals-name" title="${_stEsc(name)}">${_stEsc(name)}</span>
          <span class="px-st-totals-qty">\xd7${qty}</span>
          <span class="px-st-totals-detail" title="${_stEsc(uniqSrc)}">${_stEsc(uniqSrc)}</span>
        </div>`;
      }).join('');
    }

    // ---- Notebook / Diary modal -----------------------------------------------

    function openNotebook(tab) {
      notebookOpen = true;
      if (tab) switchNotebookTab(tab);
      document.getElementById('px-notebook-modal').classList.add('px-modal-visible');
      diaryPage = 1;
      if (notebookTab === 'diary') { loadDiary(1); renderTodayXp(); }
      else if (notebookTab === 'timers') loadActivityTimers();
      else if (notebookTab === 'profile') renderProfileTab();
      else loadNotebook();
      startTimerCountdown();
    }

    function closeNotebook() {
      notebookOpen = false;
      document.getElementById('px-notebook-modal').classList.remove('px-modal-visible');
      stopTimerCountdown();
    }

    function switchNotebookTab(tab) {
      if (!['diary','notebook','timers','profile'].includes(tab)) return;
      notebookTab = tab;
      document.querySelectorAll('.px-nb-tab').forEach(btn =>
        btn.classList.toggle('px-nb-tab-active', btn.dataset.tab === tab));
      document.getElementById('px-nb-diary-panel').classList.toggle('px-nb-panel-active', tab === 'diary');
      document.getElementById('px-nb-notebook-panel').classList.toggle('px-nb-panel-active', tab === 'notebook');
      document.getElementById('px-nb-act-timers-panel').classList.toggle('px-nb-panel-active', tab === 'timers');
      document.getElementById('px-nb-profile-panel').classList.toggle('px-nb-panel-active', tab === 'profile');
      if (tab === 'diary') { diaryPage = 1; loadDiary(1); renderTodayXp(); }
      else if (tab === 'timers') { loadActivityTimers(); loadNotebook(); }
      else if (tab === 'profile') renderProfileTab();
      else loadNotebook();
    }

    // ---- Currency name + icon table (lazy-loaded once from /api/currencies) ---
    // { id: { name, sprite } }  e.g. { 'cur_liveops': { name: 'Stuff Stub', sprite: '...' } }
    let _diarycurrencies = null;
    async function _loadCurrencies() {
      if (_diarycurrencies) return _diarycurrencies;
      try {
        const r = await nbFetch('/api/currencies');
        if (r.ok) _diarycurrencies = await r.json();
      } catch (_) {}
      return _diarycurrencies || {};
    }

    // Built-in fallback names so the UI never shows raw IDs even when /api/currencies is slow.
    const _BUILTIN_CURRENCY_NAMES = {
      'cur_pixel':        'Pixels',
      'cur_$pixel':       'Pixels',
      'cur_vpixel':       'vPixel',
      'cur_coins':        'Coins',
      'cur_liveops':      'Stuff Stub',
      'cur_zoneztokens':  'Zonez Tokens',
    };

    function _tidyCurId(id) {
      return (id.startsWith('cur_') ? id.slice(4) : id)
        .replace(/[_-]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
    }
    function _curName(id) {
      return _diarycurrencies?.[id]?.name ?? _BUILTIN_CURRENCY_NAMES[id] ?? _tidyCurId(id);
    }
    function _curSprite(id) {
      return _diarycurrencies?.[id]?.sprite ?? null;
    }

    // Only cur_pixel / cur_$pixel (and bare variants) are the same Pixels currency.
    // cur_vpixel is distinct and must NOT be merged.
    const _PIXELS_IDS = new Set(['cur_pixel', 'cur_$pixel', 'pixel', '$pixel']);

    // Format "2026-10-01" → "Today" / "Yesterday" / "Thu 1 Oct"
    function _formatDiaryDate(isoDate) {
      try {
        const [y, m, d] = isoDate.split('-').map(Number);
        const now = new Date();
        const nowY = now.getFullYear(), nowM = now.getMonth() + 1, nowD = now.getDate();
        if (y === nowY && m === nowM && d === nowD) return 'Today';
        const yest = new Date(now); yest.setDate(now.getDate() - 1);
        if (y === yest.getFullYear() && m === (yest.getMonth() + 1) && d === yest.getDate()) return 'Yesterday';
        const dt = new Date(y, m - 1, d);
        const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return `${days[dt.getDay()]} ${d} ${months[m - 1]}`;
      } catch (_) { return isoDate; }
    }

    // Derive a currency ID from a legacy display name like "Cur Liveops" or "Cur $Pixel".
    function _legacyNameToId(rawName) {
      // Try exact name match in loaded currencies first.
      if (_diarycurrencies) {
        for (const [id, data] of Object.entries(_diarycurrencies)) {
          if (data.name && data.name.toLowerCase() === rawName.toLowerCase()) return id;
        }
      }
      // Heuristic: strip leading "Cur " (case-insensitive), lowercase, prepend "cur_".
      const stripped = /^cur\s+/i.test(rawName) ? rawName.slice(rawName.indexOf(' ') + 1) : rawName;
      return 'cur_' + stripped.toLowerCase().replace(/\s+/g, '_');
    }

    // Parse a legacy plain-text summary into change objects.
    const _LEGACY_LINE_RE = /^([+\-−])([\d,]+)\s+(.+)$/;
    function _parseLegacySummary(summary) {
      const changes = [];
      for (const line of (summary || '').split('\n')) {
        const m = line.trim().match(_LEGACY_LINE_RE);
        if (!m) continue;
        const sign   = m[1] === '+' ? 1 : -1;
        const amount = parseInt(m[2].replace(/,/g, ''), 10);
        if (isNaN(amount)) continue;
        const id = _legacyNameToId(m[3].trim());
        changes.push({ type: 'currency', id, delta: sign * amount });
      }
      return changes;
    }

    // Shared: dedup Pixels, sort, and render a changes array into HTML.
    function _renderChanges(changes) {
      const seenPixelSign = new Set();
      const deduped = [];
      for (const c of changes) {
        if (c.type === 'currency' && _PIXELS_IDS.has(c.id)) {
          const sign = (c.delta ?? 0) >= 0 ? '+' : '-';
          if (!seenPixelSign.has(sign)) {
            seenPixelSign.add(sign);
            deduped.push({ ...c, id: 'cur_pixel', _isPixels: true });
          }
        } else {
          deduped.push(c);
        }
      }
      // Gains first, losses last; skills at end
      deduped.sort((a, b) => {
        if (a.type === 'skill' && b.type !== 'skill') return 1;
        if (b.type === 'skill' && a.type !== 'skill') return -1;
        if (a.type === 'currency' && b.type === 'currency') {
          const aGain = (a.delta ?? 0) >= 0, bGain = (b.delta ?? 0) >= 0;
          if (aGain && !bGain) return -1;
          if (!aGain && bGain) return 1;
        }
        return 0;
      });
      return '<div class="px-nb-diary-rows">' + deduped.map(c => {
        if (c.type === 'skill') {
          const label = (c.skill || '').replace(/([A-Z])/g, ' $1').replace(/\b\w/g, x => x.toUpperCase()).trim();
          return `<div class="px-nb-diary-row px-nb-diary-skill">⬆ ${escapeHtml(label)} ${c.from}→${c.to}</div>`;
        }
        const id       = c.id || '';
        const delta    = c.delta ?? 0;
        const gain     = delta >= 0;
        const sprite   = _curSprite(id);
        const name     = c._isPixels ? 'Pixels' : _curName(id);
        const amt      = Math.abs(delta).toLocaleString('en-US');
        const sign     = gain ? '+' : '−';
        const cls      = gain ? 'px-nb-diary-gain' : 'px-nb-diary-loss';
        const iconHtml = sprite
          ? `<img class="px-nb-diary-icon" src="${escapeHtml(sprite)}" alt="" loading="lazy">`
          : '';
        return `<div class="px-nb-diary-row">${iconHtml}<span class="${cls}">${sign}${amt}</span><span class="px-nb-diary-label">${escapeHtml(name)}</span></div>`;
      }).join('') + '</div>';
    }

    // Render a single diary entry — structured (changes_json) or legacy (summary text).
    function _renderDiaryEntry(e) {
      const dateLabel = _formatDiaryDate(e.entry_date);
      let rowsHtml = '';

      if (e.changes_json) {
        try {
          rowsHtml = _renderChanges(JSON.parse(e.changes_json));
        } catch (_) {
          rowsHtml = `<div class="px-nb-diary-text">${escapeHtml(e.summary)}</div>`;
        }
      } else {
        // Legacy entry: try to parse text lines into structured changes.
        const changes = _parseLegacySummary(e.summary);
        if (changes.length > 0) {
          rowsHtml = _renderChanges(changes);
        } else {
          rowsHtml = `<div class="px-nb-diary-text">${escapeHtml(e.summary)}</div>`;
        }
      }

      return `<div class="px-nb-diary-card">
        <div class="px-nb-diary-date">${escapeHtml(dateLabel)}</div>
        ${rowsHtml}
      </div>`;
    }

    // ---- XP Per Day ---------------------------------------------------------

    // Returns "YYYY-MM-DD" in local time
    function _todayKey() {
      const d = new Date();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${mm}-${dd}`;
    }

    // Returns the date key for yesterday
    function _yesterdayKey() {
      const d = new Date(Date.now() - 86_400_000);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${mm}-${dd}`;
    }

    // Skill names to exclude from XP tracking
    const _XP_SKIP = new Set(['total', 'overall', 'Total', 'Overall']);

    // Prettify camelCase skill name → "Title Case"
    function _skillLabel(name) {
      return name
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
    }

    // Save baseline XP for today if not already saved; prune keys older than 7 days.
    async function _maybeSetXpBaseline(playerId, skills) {
      const storageKey = `xpBaseline_${playerId}`;
      let baselines = (await storageGetKey(storageKey)) ?? {};
      const today = _todayKey();
      if (!baselines[today]) {
        // First read this local day — set baseline
        const snapshot = {};
        for (const [skill, data] of Object.entries(skills)) {
          if (_XP_SKIP.has(skill)) continue;
          snapshot[skill] = { xp: data.totalExp ?? 0, level: data.level ?? 0 };
        }
        baselines[today] = snapshot;
        // Prune to last 7 days
        const keys = Object.keys(baselines).sort();
        while (keys.length > 7) {
          delete baselines[keys.shift()];
        }
        await storageSetKey(storageKey, baselines);
        nbFetch('/api/player-prefs', { method: 'POST', body: JSON.stringify({ playerId, key: 'xpBaseline', value: baselines }) }).catch(() => {});
      }
    }

    // Compute XP gained for a given day vs baseline; returns sorted array.
    function _computeXpGains(skills, baseline) {
      const gains = [];
      for (const [skill, cur] of Object.entries(skills)) {
        if (_XP_SKIP.has(skill)) continue;
        const base = baseline[skill];
        if (!base) continue;
        const xpGain = (cur.totalExp ?? 0) - base.xp;
        if (xpGain <= 0) continue;
        gains.push({
          skill,
          xpGain,
          fromLevel: base.level,
          toLevel:   cur.level ?? base.level,
        });
      }
      gains.sort((a, b) => b.xpGain - a.xpGain);
      return gains;
    }

    // Render XP gains into the #px-nb-xp-section element.
    // viewKey: 'today' | 'yesterday'
    let _xpViewKey = 'today';

    async function renderTodayXp() {
      const el = document.getElementById('px-nb-xp-section');
      if (!el) return;
      const playerId = nbPlayerId();
      if (!playerId) { el.innerHTML = ''; return; }

      const skills = latestPlayerContext?.skills ?? {};
      if (Object.keys(skills).length === 0) { el.innerHTML = ''; return; }

      const storageKey = `xpBaseline_${playerId}`;
      const baselines  = (await storageGetKey(storageKey)) ?? {};
      const todayKey   = _todayKey();
      const yestKey    = _yesterdayKey();
      const hasYest    = !!baselines[yestKey];

      // Save baseline if first read today
      await _maybeSetXpBaseline(playerId, skills);
      const freshBaselines = (await storageGetKey(storageKey)) ?? baselines;

      const isYest    = _xpViewKey === 'yesterday' && hasYest;
      const dateKey   = isYest ? yestKey : todayKey;
      const baseline  = freshBaselines[dateKey];

      // For yesterday we use yesterday's baseline vs. today's baseline as the "current"
      let displaySkills = skills;
      if (isYest && freshBaselines[todayKey]) {
        // yesterday's gains = today's baseline - yesterday's baseline
        const todayBase = freshBaselines[todayKey];
        const tempSkills = {};
        for (const [s, b] of Object.entries(todayBase)) {
          tempSkills[s] = { totalExp: b.xp, level: b.level };
        }
        displaySkills = tempSkills;
      }

      let bodyHtml = '';
      if (!baseline) {
        bodyHtml = '<div class="px-nb-empty">No baseline data yet.</div>';
      } else {
        const gains = _computeXpGains(displaySkills, baseline);
        if (gains.length === 0) {
          bodyHtml = `<div class="px-nb-empty">No XP yet ${isYest ? 'yesterday' : 'today'} — go do something!</div>`;
        } else {
          const rows = gains.map(g => {
            const levelUp = g.toLevel > g.fromLevel
              ? `<span class="px-xp-lvlup">Lv ${g.fromLevel}→${g.toLevel} 🎉</span>` : '';
            return `<div class="px-xp-row">
              <span class="px-xp-skill">${escapeHtml(_skillLabel(g.skill))}</span>
              ${levelUp}
              <span class="px-xp-gain">+${g.xpGain.toLocaleString('en-US')} XP</span>
            </div>`;
          }).join('');
          const total = gains.reduce((s, g) => s + g.xpGain, 0);
          bodyHtml = rows + `<div class="px-xp-total"><span>Total</span><span>+${total.toLocaleString('en-US')} XP</span></div>`;
        }
      }

      const yestBtn = hasYest
        ? `<button class="px-xp-toggle" id="px-xp-toggle-btn">${isYest ? 'Today' : 'Yesterday'}</button>`
        : '';
      const title = isYest ? "Yesterday's XP" : "Today's XP";

      el.innerHTML = `<div class="px-xp-card">
        <div class="px-xp-header"><span>${escapeHtml(title)}</span>${yestBtn}</div>
        ${bodyHtml}
      </div>`;

      const toggleBtn = el.querySelector('#px-xp-toggle-btn');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          _xpViewKey = isYest ? 'today' : 'yesterday';
          renderTodayXp();
        });
      }
    }

    async function loadDiary(page) {
      const playerId = nbPlayerId();
      const container = document.getElementById('px-nb-diary-list');
      if (!container) return;
      if (!playerId) { container.innerHTML = '<div class="px-nb-empty">Player ID not available yet.</div>'; return; }
      container.innerHTML = '<div class="px-nb-loading">Loading…</div>';
      try {
        const [diaryRes] = await Promise.all([
          nbFetch(`/api/diary?playerId=${encodeURIComponent(playerId)}&page=${page}`),
          _loadCurrencies(),
        ]);
        if (!diaryRes.ok) throw new Error('HTTP ' + diaryRes.status);
        const { entries, pages } = await diaryRes.json();
        if (!entries || entries.length === 0) {
          container.innerHTML = '<div class="px-nb-empty">No diary entries yet. Play and use the companion to generate entries.</div>';
        } else {
          container.innerHTML = entries.map(e => _renderDiaryEntry(e)).join('');
        }
        const pag = document.getElementById('px-nb-diary-pag');
        if (pag) {
          pag.innerHTML = '';
          if (page > 1) {
            const b = document.createElement('button');
            b.className = 'px-nb-pag-btn'; b.textContent = '← Prev';
            b.addEventListener('click', () => { diaryPage = page - 1; loadDiary(diaryPage); });
            pag.appendChild(b);
          }
          if (page < pages) {
            const b = document.createElement('button');
            b.className = 'px-nb-pag-btn'; b.textContent = 'Next →';
            b.addEventListener('click', () => { diaryPage = page + 1; loadDiary(diaryPage); });
            pag.appendChild(b);
          }
          if (pages > 0) {
            const span = document.createElement('span');
            span.className = 'px-nb-pag-info'; span.textContent = `Page ${page} of ${pages}`;
            pag.appendChild(span);
          }
        }
      } catch (err) {
        container.innerHTML = '<div class="px-nb-empty">Failed to load diary.</div>';
      }
    }

    async function loadActivityTimers() {
      const listEl = document.getElementById('px-nb-act-timers-list');
      if (!listEl) return;
      const playerId = nbPlayerId();
      if (!playerId) {
        listEl.innerHTML = '<div class="px-nb-empty">Sign in to see timers.</div>';
        return;
      }
      try {
        const timers = (await storageGetKey(`activityTimers_${playerId}`)) ?? [];
        console.log(`[timers] UI loaded ${timers.length} timer(s)`);
        if (timers.length === 0) {
          listEl.innerHTML = '<div class="px-nb-empty">No active timers. Plant a crop, start a craft or use a mine to see timers here.</div>';
          return;
        }
        const now = Date.now();
        // Ready-first, then by soonest readyAt
        timers.sort((a, b) => {
          const aReady = a.readyAt <= now, bReady = b.readyAt <= now;
          if (aReady !== bReady) return aReady ? -1 : 1;
          return a.readyAt - b.readyAt;
        });

        // Group: same itemLabel + mapId with readyAt within 60 s of each other
        const groups = [];
        for (const t of timers) {
          const last = groups[groups.length - 1];
          if (last
              && last.itemLabel === t.itemLabel
              && last.mapId    === t.mapId
              && t.readyAt - last.minReadyAt <= 60_000) {
            last.members.push(t);
            last.maxReadyAt = Math.max(last.maxReadyAt, t.readyAt);
          } else {
            groups.push({
              itemLabel: t.itemLabel, landLabel: t.landLabel, mapId: t.mapId,
              minReadyAt: t.readyAt, maxReadyAt: t.readyAt, members: [t],
            });
          }
        }

        listEl.innerHTML = groups.map((g, gi) => {
          const count   = g.members.length;
          const ready   = g.maxReadyAt <= now;
          const ms      = g.maxReadyAt - now;
          const timeStr = ready ? 'READY — collect' : _fmtCountdown(ms);
          const label   = count > 1
            ? `${_esc(g.itemLabel)} ×${count} · ${_esc(g.landLabel)}`
            : `${_esc(g.itemLabel)} · ${_esc(g.landLabel)}`;
          const groupId = `px-act-g-${gi}`;
          const expandBtn = count > 1
            ? `<button class="px-nb-timer-expand" data-group="${groupId}" title="Show individual">+</button>` : '';
          const childRows = count > 1
            ? `<div id="${groupId}" class="px-nb-timer-children" style="display:none">${
                g.members.map(t => {
                  const tr = t.readyAt <= now;
                  return `<div class="px-nb-timer-row px-nb-timer-child ${tr ? 'px-nb-timer-ready' : ''}">
                    <span class="px-nb-timer-item">${_esc(t.itemLabel)}</span>
                    <span class="px-nb-timer-land">${_esc(t.landLabel)}</span>
                    <span class="px-nb-timer-status">${tr ? 'READY' : _fmtCountdown(t.readyAt - now)}</span>
                  </div>`;
                }).join('')
              }</div>` : '';
          return `<div class="px-nb-timer-row ${ready ? 'px-nb-timer-ready' : ''}">
            ${expandBtn}
            <span class="px-nb-timer-item">${label}</span>
            <span class="px-nb-timer-status">${timeStr}</span>
          </div>${childRows}`;
        }).join('');

        // Wire expand buttons
        listEl.querySelectorAll('.px-nb-timer-expand').forEach(btn => {
          btn.addEventListener('click', () => {
            const children = document.getElementById(btn.dataset.group);
            if (!children) return;
            const open = children.style.display !== 'none';
            children.style.display = open ? 'none' : 'block';
            btn.textContent = open ? '+' : '−';
          });
        });
      } catch (e) {
        listEl.innerHTML = '<div class="px-nb-empty">Could not load timers.</div>';
      }
    }

    // Live-refresh timers panel whenever injected.js pushes an update.
    window.addEventListener('px-timers-updated', () => {
      if (notebookOpen && notebookTab === 'timers') loadActivityTimers();
    });

    function _fmtCountdown(ms) {
      if (ms <= 0) return 'READY';
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${sec}s`;
      return `${sec}s`;
    }

    function _esc(str) {
      return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    async function loadNotebook() {
      const playerId = nbPlayerId();
      if (!playerId) {
        ['px-nb-goals-list','px-nb-timers-list','px-nb-shopping-items'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.innerHTML = '<div class="px-nb-empty">Player ID not available yet.</div>';
        });
        return;
      }
      try {
        const res = await nbFetch(`/api/notebook?playerId=${encodeURIComponent(playerId)}`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const { goals, shoppingItems, timers } = await res.json();
        renderGoals(goals || []);
        renderTimers(timers || []);
        renderShoppingList(shoppingItems || []);
      } catch (err) {
        console.warn(TAG, 'loadNotebook failed:', err);
      }
    }

    // Fill <level> placeholder in goal text using current player skills.
    // Looks for a skill name in the surrounding text, replaces with currentLevel+1.
    // Returns { text, filled } — filled=false means <level> remains unfilled.
    function _fillGoalPlaceholders(text) {
      if (!/<level>/i.test(text)) return { text, filled: true };
      const skills = latestPlayerContext?.skills ?? {};
      const skillKeys = Object.keys(skills); // e.g. "cooking", "woodworking"
      // For each <level> occurrence, scan surrounding words for a skill name match
      const filled = text.replace(/<level>/gi, (match, offset) => {
        const prefix = text.slice(0, offset).toLowerCase();
        // Try to match a skill key as the last word-sequence before <level>
        // Check longest names first so "woodworking" beats "wood"
        const sorted = skillKeys.slice().sort((a, b) => b.length - a.length);
        for (const key of sorted) {
          const keyNorm = key.toLowerCase().replace(/[_-]/g, ' ');
          if (prefix.includes(keyNorm)) {
            const lvl = skills[key]?.level ?? 0;
            return String(lvl + 1);
          }
        }
        return match; // could not fill
      });
      return { text: filled, filled: !/<level>/i.test(filled) };
    }

    function renderGoals(goals) {
      const container = document.getElementById('px-nb-goals-list');
      if (!container) return;
      if (goals.length === 0) { container.innerHTML = '<div class="px-nb-empty">No goals yet.</div>'; return; }
      container.innerHTML = goals.map(g => {
        const { text: displayText, filled } = _fillGoalPlaceholders(g.text);
        const needsEdit = !filled; // still has <level> we couldn't resolve
        return `<div class="px-nb-goal-item" data-id="${g.id}">
          <input type="checkbox" class="px-nb-goal-check" ${g.completed ? 'checked' : ''} data-id="${g.id}"/>
          <span class="px-nb-goal-text${g.completed ? ' px-nb-goal-done' : ''}">${escapeHtml(displayText)}${needsEdit ? ' <span class="px-nb-goal-warn" title="This goal contains an unfilled placeholder — please edit it">⚠ edit me</span>' : ''}</span>
          <button class="px-nb-del-btn" data-id="${g.id}" data-type="goal">✕</button>
        </div>`;
      }).join('');
      container.querySelectorAll('.px-nb-goal-check').forEach(cb =>
        cb.addEventListener('change', () => toggleGoalItem(Number(cb.dataset.id), cb.checked)));
      container.querySelectorAll('.px-nb-del-btn[data-type="goal"]').forEach(btn =>
        btn.addEventListener('click', () => deleteGoalItem(Number(btn.dataset.id))));
    }

    function renderTimers(timers) {
      const container = document.getElementById('px-nb-timers-list');
      if (!container) return;
      if (timers.length === 0) {
        container.innerHTML = '<div class="px-nb-empty">No timers set.</div>';
      } else {
        container.innerHTML = timers.map(t =>
          `<div class="px-nb-timer-item">
            <span class="px-nb-timer-label">${escapeHtml(t.label)}</span>
            <span class="px-nb-timer-countdown" data-fire="${t.fire_at}"></span>
            <button class="px-nb-del-btn" data-id="${t.id}" data-type="timer">✕</button>
          </div>`
        ).join('');
        container.querySelectorAll('.px-nb-del-btn[data-type="timer"]').forEach(btn =>
          btn.addEventListener('click', () => deleteTimerItem(Number(btn.dataset.id))));
      }
      renderIngameTimers();
      updateTimerCountdowns();
    }

    function renderIngameTimers() {
      const container = document.getElementById('px-nb-ingame-timers');
      if (!container) return;
      const offers = latestPlayerContext?.stackedOffers;
      if (!Array.isArray(offers) || offers.length === 0) {
        container.innerHTML = '<div class="px-nb-empty">No in-game offers active.</div>'; return;
      }
      const timed = offers.filter(o => o && (o.expiresAt || o.fireAt || o.endTime || o.endsAt));
      if (timed.length === 0) {
        container.innerHTML = '<div class="px-nb-empty">No timed offers.</div>'; return;
      }
      container.innerHTML = timed.map(o => {
        const expiry = o.expiresAt ?? o.fireAt ?? o.endTime ?? o.endsAt;
        const label = o.name ?? o.title ?? o.label ?? o.type ?? 'Offer';
        return `<div class="px-nb-timer-item">
          <span class="px-nb-timer-label">${escapeHtml(String(label))}</span>
          <span class="px-nb-timer-countdown" data-fire="${expiry}"></span>
        </div>`;
      }).join('');
    }

    function renderShoppingList(items) {
      const container = document.getElementById('px-nb-shopping-items');
      if (!container) return;
      if (items.length === 0) { container.innerHTML = '<div class="px-nb-empty">Shopping list is empty.</div>'; return; }
      container.innerHTML = items.map(item =>
        `<div class="px-nb-shopping-item">
          <span class="px-nb-shopping-text">${escapeHtml(item.text)}${item.quantity > 1 ? ` ×${item.quantity}` : ''}</span>
          <button class="px-nb-del-btn" data-id="${item.id}" data-type="shopping">✕</button>
        </div>`
      ).join('');
      container.querySelectorAll('.px-nb-del-btn[data-type="shopping"]').forEach(btn =>
        btn.addEventListener('click', () => deleteShoppingItem(Number(btn.dataset.id))));
    }

    async function loadCraftTotals() {
      const playerId = nbPlayerId();
      const container = document.getElementById('px-nb-craft-totals');
      if (!container || !playerId) return;
      container.innerHTML = '<div class="px-nb-loading">Calculating…</div>';
      try {
        const res = await nbFetch(`/api/shopping-list/craft-totals?playerId=${encodeURIComponent(playerId)}`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const { totals, noRecipeItems } = await res.json();
        if (totals.length === 0 && noRecipeItems.length === 0) {
          container.innerHTML = '<div class="px-nb-empty">Nothing to calculate.</div>'; return;
        }
        let html = '';
        if (totals.length > 0) {
          html += '<div class="px-nb-totals-header">Ingredients needed:</div>';
          html += totals.map(t => `<div class="px-nb-total-row">${t.quantity}× ${escapeHtml(t.name)}</div>`).join('');
        }
        if (noRecipeItems.length > 0) {
          html += '<div class="px-nb-totals-header">Obtain directly:</div>';
          html += noRecipeItems.map(n => `<div class="px-nb-total-row">${escapeHtml(n)}</div>`).join('');
        }
        container.innerHTML = html;
      } catch (err) {
        container.innerHTML = '<div class="px-nb-empty">Failed to calculate.</div>';
      }
    }

    async function addGoalItem() {
      const input = document.getElementById('px-nb-goal-input');
      const playerId = nbPlayerId();
      if (!input || !playerId || !input.value.trim()) return;
      const raw = input.value.trim(); input.value = '';
      const { text } = _fillGoalPlaceholders(raw);
      try {
        const res = await nbFetch('/api/goals', { method: 'POST', body: JSON.stringify({ playerId, text }) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await loadNotebook();
      } catch (err) { console.warn(TAG, 'addGoal failed:', err); }
    }

    async function toggleGoalItem(id, completed) {
      const playerId = nbPlayerId(); if (!playerId) return;
      try {
        await nbFetch(`/api/goals/${id}`, { method: 'PATCH', body: JSON.stringify({ playerId, completed }) });
        await loadNotebook();
      } catch (err) { console.warn(TAG, 'toggleGoal failed:', err); }
    }

    async function deleteGoalItem(id) {
      const playerId = nbPlayerId(); if (!playerId) return;
      try {
        await nbFetch(`/api/goals/${id}?playerId=${encodeURIComponent(playerId)}`, { method: 'DELETE' });
        await loadNotebook();
      } catch (err) { console.warn(TAG, 'deleteGoal failed:', err); }
    }

    async function addTimerItem() {
      const labelInput = document.getElementById('px-nb-timer-label');
      const minsInput  = document.getElementById('px-nb-timer-mins');
      const playerId   = nbPlayerId();
      if (!labelInput || !minsInput || !playerId) return;
      const label = labelInput.value.trim();
      const mins  = parseFloat(minsInput.value);
      if (!label || isNaN(mins) || mins <= 0) return;
      labelInput.value = ''; minsInput.value = '';
      const fireAt = Date.now() + Math.round(mins * 60 * 1000);
      try {
        const res = await nbFetch('/api/timers', { method: 'POST', body: JSON.stringify({ playerId, label, fireAt }) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await loadNotebook();
      } catch (err) { console.warn(TAG, 'addTimer failed:', err); }
    }

    async function deleteTimerItem(id) {
      const playerId = nbPlayerId(); if (!playerId) return;
      try {
        await nbFetch(`/api/timers/${id}?playerId=${encodeURIComponent(playerId)}`, { method: 'DELETE' });
        await loadNotebook();
      } catch (err) { console.warn(TAG, 'deleteTimer failed:', err); }
    }

    async function addShoppingItem() {
      const textInput = document.getElementById('px-nb-shopping-input');
      const qtyInput  = document.getElementById('px-nb-shopping-qty');
      const playerId  = nbPlayerId();
      if (!textInput || !playerId || !textInput.value.trim()) return;
      const text     = textInput.value.trim();
      const quantity = parseInt(qtyInput?.value || '1', 10) || 1;
      textInput.value = ''; if (qtyInput) qtyInput.value = '1';
      try {
        const res = await nbFetch('/api/shopping-list', { method: 'POST', body: JSON.stringify({ playerId, text, quantity }) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await loadNotebook();
      } catch (err) { console.warn(TAG, 'addShoppingItem failed:', err); }
    }

    async function deleteShoppingItem(id) {
      const playerId = nbPlayerId(); if (!playerId) return;
      try {
        await nbFetch(`/api/shopping-list/${id}?playerId=${encodeURIComponent(playerId)}`, { method: 'DELETE' });
        await loadNotebook();
      } catch (err) { console.warn(TAG, 'deleteShoppingItem failed:', err); }
    }

    // Expose the things dispatch() needs to reach.
    function onPlayerContext(data) {
      // Live-refresh XP section if diary tab is open
      if (notebookOpen && notebookTab === 'diary') {
        renderTodayXp();
      }
      // Live-refresh storage modal if open
      if (storageOpen) {
        _renderStorage();
      }
      // Load profile once per player session
      if (!profileLoaded && data?.playerId) {
        profileLoaded = true;
        _loadProfileForPlayer(data.playerId);
      }
      // Post-brief plan: once taskboard + stacked both have data, post a short plan once per day
      _maybePlanAfterBrief(data);
    }

    async function _maybePlanAfterBrief(data) {
      const pid = data?.playerId;
      if (!pid || !playerProfile) return;
      const today = _utcDateStr();
      if (_briefPlanPostedDate === today) return;

      const hasTb = Array.isArray(data?.taskboard) && data.taskboard.length > 0;
      const hasSt = Array.isArray(data?.stackedOffers) && data.stackedOffers.length > 0;
      if (!hasTb || !hasSt) return;

      // Only fire if the brief was shown today
      let briefDate = null;
      try { briefDate = await storageGetKey(`morningBriefDate_${pid}`); } catch { return; }
      if (briefDate !== today) return;

      // Mark before async work to prevent double-fire
      _briefPlanPostedDate = today;

      // Build a short local plan from available data
      const lines = _buildBriefPlan(data);
      if (lines && lines.length > 0) {
        appendMessage(currentPersona, lines.join('\n'));
        const list = document.getElementById('px-messages');
        if (list) list.scrollTop = list.scrollHeight;
      }
    }

    function _buildBriefPlan(ctx) {
      const lines = [];
      const taskboard = ctx?.taskboard ?? [];
      const stacked   = ctx?.stackedOffers ?? [];
      const inv       = ctx?.inventory ?? {};
      const maxPrice  = playerProfile?.taskboardTooExpensive ?? 100_000;
      const marketPrices = ctx?.marketPrices ?? {};

      // Parse "12K" / "1,234" style coin strings to number
      function parseCoins(s) {
        if (typeof s === 'number') return s;
        if (!s) return null;
        const m = String(s).replace(/,/g, '').trim().match(/^(\d+(?:\.\d+)?)([Kk]?)$/);
        if (!m) return null;
        const n = parseFloat(m[1]);
        return isNaN(n) ? null : m[2] ? Math.round(n * 1000) : Math.round(n);
      }

      // Collect taskboard skill keywords for overlap detection
      const taskboardSkills = new Set();
      const SKILL_KWORDS = ['farming','mining','forestry','cooking','crafting','stoneshaping','fishing','woodwork','metalwork','building','tailoring','brewing','petcare','exploration'];
      for (const o of taskboard) {
        const label = (o.itemName ?? o.label ?? '').toLowerCase();
        for (const sk of SKILL_KWORDS) { if (label.includes(sk)) taskboardSkills.add(sk); }
      }
      const focuses = taskboardSkills.size > 0 ? taskboardSkills : null;

      // Yieldstone item IDs by union faction (1=Wildgroves/Verdant, 2=Seedwrights/Flint, 3=Reapers/Hollow)
      const UNION_YIELDSTONES = {
        1: ['itm_yield_1_1','itm_yield_1_2','itm_yield_1_3','itm_yield_1_4','itm_yield_1_5'],
        2: ['itm_yield_3_1','itm_yield_3_2','itm_yield_3_3','itm_yield_3_4','itm_yield_3_5'],
        3: ['itm_yield_6_1','itm_yield_6_2','itm_yield_6_3','itm_yield_6_4','itm_yield_6_5'],
      };
      const factionId = typeof ctx?.factionId === 'number' ? ctx.factionId : null;
      // Sabotage items = yieldstones of the OTHER two unions
      const saboItemIds = factionId
        ? Object.entries(UNION_YIELDSTONES).filter(([fid]) => Number(fid) !== factionId).flatMap(([, ids]) => ids)
        : [];
      const sabotageCount = saboItemIds.reduce((sum, id) => sum + (typeof inv[id] === 'number' ? inv[id] : 0), 0);

      // Pick best stacked offer — prefer one whose description overlaps taskboard skills; skip sabotage unless player has enough
      const now = Date.now();
      const liveOffers = stacked.filter(o => typeof o.expiresAt !== 'number' || o.expiresAt > now);
      const nonSabotage = liveOffers.filter(o => {
        const text = (o.requirementText ?? o.description ?? '').toLowerCase();
        if (!text.includes('sabotage')) return true;
        // Only include sabotage offer if player holds >= required sabotage yieldstones
        const saboMatch = text.match(/sabotage\s+(?:enemy\s+unions?|unions?)\s+(\d+)\s+times?/);
        const required = saboMatch ? parseInt(saboMatch[1], 10) : 1;
        return sabotageCount >= required;
      });

      // Prefer offers that overlap taskboard focus skills
      let bestOffer = null;
      if (focuses && focuses.size > 0) {
        bestOffer = nonSabotage.find(o => {
          const text = (o.requirementText ?? o.description ?? '').toLowerCase();
          return [...focuses].some(sk => text.includes(sk));
        }) ?? null;
      }
      if (!bestOffer && nonSabotage.length > 0) {
        bestOffer = nonSabotage.reduce((a, b) => ((a.expiresAt ?? Infinity) < (b.expiresAt ?? Infinity) ? a : b));
      }

      if (bestOffer) {
        const req = bestOffer.requirementText ?? bestOffer.description ?? 'Stacked offer';
        const leftMs = bestOffer.expiresAt ? bestOffer.expiresAt - now : null;
        const timeStr = leftMs !== null && leftMs > 0
          ? leftMs < 3_600_000
            ? `${Math.round(leftMs / 60_000)}m`
            : (() => { const h = Math.floor(leftMs / 3_600_000); const m = Math.floor((leftMs % 3_600_000) / 60_000); return m > 0 ? `${h}h ${m}m` : `${h}h`; })()
          : null;
        lines.push(`📋 ${req}${timeStr ? ` (${timeStr} left)` : ''}`);
      }

      // Rank taskboard orders by net coin value; show top 2
      const ranked = taskboard.map(o => {
        const qty = o.quantityNeeded ?? 1;
        const costs = Array.isArray(o.costs) ? o.costs : [];
        const coinReward = costs.length >= 2 ? parseCoins(costs[1]) : null;
        const have = (inv[o.itemId] ?? 0);
        const stillNeed = Math.max(0, qty - have);
        const mp = marketPrices[o.itemId];
        const fillCost = stillNeed > 0 && mp ? stillNeed * mp.lowestPrice : (stillNeed === 0 ? 0 : null);
        const netVal = coinReward !== null && fillCost !== null ? coinReward - fillCost : coinReward ?? -Infinity;
        const affordable2 = fillCost !== null ? fillCost <= maxPrice : true;
        return { o, qty, have, fillCost, coinReward, netVal, affordable2 };
      }).filter(r => r.affordable2).sort((a, b) => (b.netVal ?? -Infinity) - (a.netVal ?? -Infinity)).slice(0, 2);

      for (const { o, qty, have, fillCost, coinReward } of ranked) {
        const name = o.itemName ?? 'Unknown';
        const status = have >= qty ? '✓ ready' : `${have}/${qty}`;
        const costStr = fillCost !== null && fillCost > 0 ? ` · costs ~${fillCost.toLocaleString()}` : '';
        const payStr  = coinReward !== null ? ` · pays ${coinReward.toLocaleString()}` : '';
        lines.push(`📦 ${name} ×${qty} — ${status}${costStr}${payStr}`);
      }

      // Suggest focus skill (weakest)
      const skills = ctx?.skills ?? ctx?.levels ?? {};
      const FOCUS_SKILLS = ['brewing','tailoring','fishing','exploration','cooking','crafting','building'];
      let weakestSkill = null;
      let weakestLevel = Infinity;
      for (const sk of FOCUS_SKILLS) {
        const lv = typeof skills[sk] === 'number' ? skills[sk] : (skills[sk]?.level ?? null);
        if (lv !== null && lv < weakestLevel) { weakestLevel = lv; weakestSkill = sk; }
      }
      if (weakestSkill) {
        lines.push(`🎯 Focus skill: ${weakestSkill.charAt(0).toUpperCase() + weakestSkill.slice(1)} (level ${weakestLevel})`);
      }

      return lines.slice(0, 5);
    }

    return {
      get latestPlayerContext() { return latestPlayerContext; },
      set latestPlayerContext(v) { latestPlayerContext = v; },
      onGameEvent,
      onCameraFrame,
      onPlayerContext,
    };
  })();

})();
