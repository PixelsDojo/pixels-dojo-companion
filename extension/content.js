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
          await storageSetKey(`chestCache_${mid}`, {
            items:      data.items      ?? [],
            size:       data.size       ?? 0,
            removeOnly: data.removeOnly ?? false,
            capturedAt: data.capturedAt ?? Date.now(),
          });
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

    const CASUAL_GREETINGS = ["What's up?", "How can I help?", "What do you need?"];

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
            <button class="px-hdr-btn" id="px-diary-btn">Diary</button>
            <button class="px-hdr-btn" id="px-close-btn" title="Close panel">×</button>
            <button class="px-hdr-btn" id="px-dismiss-all-btn">Dismiss</button>
          </div>
        </div>
        <div id="px-messages">
          <div class="px-empty">Ask me anything about Pixels!</div>
        </div>
        <div id="px-input-row">
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
            </div>
            <button id="px-notebook-modal-close" title="Close">×</button>
          </div>
          <div id="px-nb-diary-panel" class="px-nb-panel px-nb-panel-active">
            <div id="px-nb-xp-section"></div>
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

      // ── Event listeners ──────────────────────────────────────────────────
      toggle.addEventListener('click', handleToriiClick);
      floatSprite.addEventListener('click', togglePanel);
      panel.querySelector('#px-dismiss-all-btn').addEventListener('click', fullDismiss);
      panel.querySelector('#px-close-btn').addEventListener('click', closePanel);
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
        appendMessage('pixin', "Hi, I'm Pixin! I'd love to teach you how to play Pixels and figure out what's going on in the wide world of Terra Villa. Ask me about anything — quests, coins, crafting, you name it! If you want advanced gameplay advice and strategy on how to maximize your earnings, why not chat to my friends Royagi or Nyanko?");
        return;
      }

      if (p === 'goat' && !royagiIntroSeen) {
        royagiIntroSeen = true;
        storageSetKey('hasSeenRoyagiIntro', true).catch(() => {});
        appendMessage('goat', "Ah, a fresh sprout seeking wisdom! I am Royagi, the old goat of this dojo — I've weathered more harvests than you've got hay bales. Ask me for the deep strategy on maximizing your Pixels, and I'll try not to buck any trends... too hard. What'll it be?");
        return;
      }

      if (p === 'cat' && !nyankoIntroSeen) {
        nyankoIntroSeen = true;
        storageSetKey('hasSeenNyankoIntro', true).catch(() => {});
        appendMessage('cat', "Meow~ I'm Nyanko! You're clearly already doing great things around here. I'm here to help with strategy, tips, and a bit of encouragement along the way. What are we working on?");
        return;
      }

      // All relevant intros already seen — casual greeting.
      appendMessage(p, CASUAL_GREETINGS[Math.floor(Math.random() * CASUAL_GREETINGS.length)]);
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
              player:        ctx,
              walletAddress: ctx.walletAddress ?? null,
              persona:       currentPersona,
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
    function onGameEvent({ type, message }) {
      // Timer events are shown regardless of panel state (proactive notifications)
      if (type === 'timerReady' || type === 'awayTimers') {
        appendMessage(currentPersona, message ?? '');
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

    function openNotebook() {
      notebookOpen = true;
      document.getElementById('px-notebook-modal').classList.add('px-modal-visible');
      diaryPage = 1;
      if (notebookTab === 'diary') { loadDiary(1); renderTodayXp(); }
      else if (notebookTab === 'timers') loadActivityTimers();
      else loadNotebook();
      startTimerCountdown();
    }

    function closeNotebook() {
      notebookOpen = false;
      document.getElementById('px-notebook-modal').classList.remove('px-modal-visible');
      stopTimerCountdown();
    }

    function switchNotebookTab(tab) {
      if (tab !== 'diary' && tab !== 'notebook' && tab !== 'timers') return;
      notebookTab = tab;
      document.querySelectorAll('.px-nb-tab').forEach(btn =>
        btn.classList.toggle('px-nb-tab-active', btn.dataset.tab === tab));
      document.getElementById('px-nb-diary-panel').classList.toggle('px-nb-panel-active', tab === 'diary');
      document.getElementById('px-nb-notebook-panel').classList.toggle('px-nb-panel-active', tab === 'notebook');
      document.getElementById('px-nb-act-timers-panel').classList.toggle('px-nb-panel-active', tab === 'timers');
      if (tab === 'diary') { diaryPage = 1; loadDiary(1); renderTodayXp(); }
      else if (tab === 'timers') { loadActivityTimers(); loadNotebook(); }
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
