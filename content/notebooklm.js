/* NotebookLM Assistant v3.1 — Content Script
 * Injected into notebooklm.google.com
 * Features: bulk source delete checkboxes, Drive sync button, SPA nav handling, theme support
 *
 * v3.1 fixes:
 *  - Updated DOM selectors to match actual NotebookLM UI (single-source-container, source-title-column)
 *  - Fixed Select All: now correctly toggles checkboxes and fires 'change' event
 *  - Checkboxes positioned inside the element (not outside with left:-28px which may clip)
 *  - Delete flow: matches sources by title more robustly (normalized comparison)
 *  - Toolbar visibility respects isEnabled flag on creation
 *  - Prevent duplicate checkboxes and observers on repeated setup() calls
 *  - Click event re-add: uses event delegation for better perf, debounced
 */
(function() {
  'use strict';

  let isEnabled = true;
  let isSyncEnabled = true;
  let currentNotebookId = null;
  let observer = null;
  let currentTheme = 'light';
  let addCheckboxesTimer = null;

  // ─── Safe messaging (handles extension context invalidation) ───
  function isContextValid() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  async function safeSendMessage(msg) {
    if (!isContextValid()) {
      showReloadBanner();
      throw new Error('Extension was updated. Please reload the page.');
    }
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        showReloadBanner();
      }
      throw e;
    }
  }

  function showReloadBanner() {
    if (document.querySelector('#nlm-ext-reload-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'nlm-ext-reload-banner';
    banner.style.cssText = `
      position:fixed; top:0; left:0; right:0; z-index:999999;
      background:#ea4335; color:#fff; text-align:center;
      padding:10px 16px; font:500 14px/1.4 'Segoe UI',Roboto,sans-serif;
      cursor:pointer;
    `;
    banner.textContent = 'NotebookLM Assistant was updated. Click here to reload the page.';
    banner.addEventListener('click', () => location.reload());
    document.body.appendChild(banner);

    // Hide toolbar since it won't work anyway
    const toolbar = document.querySelector('.nlm-ext-toolbar');
    if (toolbar) toolbar.style.display = 'none';
  }

  // ─── Inject extension styles ───
  function injectStyles() {
    if (document.querySelector('#nlm-assistant-styles')) return;
    const style = document.createElement('style');
    style.id = 'nlm-assistant-styles';
    style.textContent = `
      /* Checkbox overlay on source items */
      .nlm-ext-checkbox-wrap {
        position: absolute;
        left: 4px;
        top: 50%;
        transform: translateY(-50%);
        z-index: 100;
        opacity: 0;
        transition: opacity 200ms;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
      }
      /* Show on hover or when checked */
      .nlm-ext-has-checkbox:hover .nlm-ext-checkbox-wrap,
      .nlm-ext-checkbox-wrap.is-checked {
        opacity: 1;
      }
      .nlm-ext-checkbox {
        width: 18px;
        height: 18px;
        cursor: pointer;
        accent-color: var(--nlm-ext-accent, #4285f4);
        margin: 0;
      }

      /* Shift source content right when checkbox visible */
      .nlm-ext-has-checkbox {
        position: relative !important;
      }

      /* Toolbar */
      .nlm-ext-toolbar {
        position: fixed;
        bottom: 20px;
        right: 20px;
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 8px 12px;
        background: var(--nlm-ext-bg, #fff);
        border: 1px solid var(--nlm-ext-border, #dadce0);
        border-radius: 16px;
        box-shadow: 0 4px 16px rgba(0,0,0,.12);
        z-index: 99999;
        font-family: 'Segoe UI', Roboto, sans-serif;
        user-select: none;
        touch-action: none;
      }
      .nlm-ext-toolbar.is-dragging {
        opacity: 0.85;
        box-shadow: 0 8px 32px rgba(0,0,0,.22);
        cursor: grabbing;
      }

      /* Drag handle */
      .nlm-ext-drag-handle {
        display: flex;
        align-items: center;
        cursor: grab;
        padding: 2px 4px 2px 0;
        color: var(--nlm-ext-muted, #5f6368);
        flex-shrink: 0;
        border-right: 1px solid var(--nlm-ext-border, #dadce0);
        margin-right: 4px;
      }
      .nlm-ext-drag-handle:active { cursor: grabbing; }
      .nlm-ext-drag-handle svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
        opacity: 0.5;
        transition: opacity 150ms;
      }
      .nlm-ext-drag-handle:hover svg { opacity: 1; }

      .nlm-ext-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 16px;
        border: none;
        border-radius: 999px;
        font-family: 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 200ms;
        line-height: 1;
      }
      .nlm-ext-btn:hover { filter: brightness(0.92); }
      .nlm-ext-btn:disabled { opacity: 0.6; cursor: not-allowed; }

      .nlm-ext-btn-delete {
        background: #ea4335;
        color: #fff;
      }
      .nlm-ext-btn-sync {
        background: #4285f4;
        color: #fff;
      }
      .nlm-ext-btn-select {
        background: var(--nlm-ext-bg2, #f0f1f3);
        color: var(--nlm-ext-text, #1f1f1f);
        border: 1px solid var(--nlm-ext-border, #dadce0);
      }

      .nlm-ext-count {
        font-size: 12px;
        color: var(--nlm-ext-muted, #5f6368);
        padding: 0 4px;
        white-space: nowrap;
      }

      /* Light theme */
      :root {
        --nlm-ext-bg: #fff;
        --nlm-ext-bg2: #f0f1f3;
        --nlm-ext-text: #1f1f1f;
        --nlm-ext-muted: #5f6368;
        --nlm-ext-border: #dadce0;
        --nlm-ext-accent: #4285f4;
      }
      /* Dark theme */
      :root[data-nlm-theme="dark"] {
        --nlm-ext-bg: #1e1e2e;
        --nlm-ext-bg2: #2a2a3e;
        --nlm-ext-text: #e0e0e0;
        --nlm-ext-muted: #9aa0a6;
        --nlm-ext-border: #3c3c5a;
        --nlm-ext-accent: #8ab4f8;
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Apply theme ───
  function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-nlm-theme', theme);
  }

  // ─── Find source items in DOM ───
  // NotebookLM uses Angular Material; actual selectors as of 2025-2026:
  //   - .single-source-container — individual source item row
  //   - source-list-item — custom element (some versions)
  //   - [data-source-id] — sometimes present
  //   - mat-list-option — Angular Material list option
  //   - .cdk-drag — if drag-and-drop is enabled
  function getSourceItems() {
    const selectors = [
      '.single-source-container',
      'source-list-item',
      '[data-source-id]',
      '.source-item',
      'mat-list-option',
      '.cdk-drag'
    ];
    const items = document.querySelectorAll(selectors.join(', '));
    return Array.from(items).filter(el => {
      // Must have visible text content and not be hidden
      if (!el.textContent || !el.textContent.trim()) return false;
      if (el.offsetParent === null) return false; // hidden element
      return true;
    });
  }

  // ─── Extract source title text from an item element ───
  function getSourceTitle(el) {
    // Try specific title selectors first
    const titleEl = el.querySelector('.source-title-column, .source-title, .title, [class*="title"]');
    if (titleEl) return titleEl.textContent.trim();
    // Fallback to full text, but strip extra whitespace
    return el.textContent.replace(/\s+/g, ' ').trim();
  }

  // ─── Extract notebook ID from URL ───
  function getNotebookIdFromUrl() {
    const match = location.pathname.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  // ─── Add checkboxes to source items ───
  function addCheckboxes() {
    if (!isEnabled) return;
    const items = getSourceItems();
    items.forEach(item => {
      // Already has our checkbox?
      if (item.querySelector('.nlm-ext-checkbox-wrap')) return;

      item.classList.add('nlm-ext-has-checkbox');

      const wrap = document.createElement('div');
      wrap.className = 'nlm-ext-checkbox-wrap';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'nlm-ext-checkbox';

      cb.addEventListener('change', () => {
        wrap.classList.toggle('is-checked', cb.checked);
        updateToolbar();
      });

      // Prevent checkbox click from opening the source detail
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      wrap.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      wrap.appendChild(cb);
      item.prepend(wrap);
    });
  }

  // ─── Debounced add checkboxes ───
  function scheduleAddCheckboxes(delay = 300) {
    if (addCheckboxesTimer) clearTimeout(addCheckboxesTimer);
    addCheckboxesTimer = setTimeout(addCheckboxes, delay);
  }

  // ─── Count checked ───
  function getCheckedCount() {
    return document.querySelectorAll('.nlm-ext-checkbox:checked').length;
  }

  // ─── Get all checkboxes ───
  function getAllCheckboxes() {
    return document.querySelectorAll('.nlm-ext-checkbox');
  }

  // ─── Toolbar position persistence ───
  const TOOLBAR_POS_KEY = 'nlm_ext_toolbar_pos';

  function saveToolbarPosition(toolbar) {
    const pos = {
      left: toolbar.style.left || '',
      top: toolbar.style.top || '',
      right: toolbar.style.right || '',
      bottom: toolbar.style.bottom || ''
    };
    try {
      chrome.storage.local.set({ [TOOLBAR_POS_KEY]: pos });
    } catch (e) {}
  }

  function restoreToolbarPosition(toolbar) {
    try {
      chrome.storage.local.get(TOOLBAR_POS_KEY, (data) => {
        const pos = data[TOOLBAR_POS_KEY];
        if (!pos) return;
        // Switch from bottom/right to top/left positioning
        if (pos.left && pos.top) {
          toolbar.style.left = pos.left;
          toolbar.style.top = pos.top;
          toolbar.style.right = 'auto';
          toolbar.style.bottom = 'auto';
          // Clamp to viewport
          clampToViewport(toolbar);
        }
      });
    } catch (e) {}
  }

  function clampToViewport(toolbar) {
    const rect = toolbar.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = rect.left;
    let y = rect.top;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + rect.width > vw) x = vw - rect.width;
    if (y + rect.height > vh) y = vh - rect.height;
    toolbar.style.left = x + 'px';
    toolbar.style.top = y + 'px';
  }

  // ─── Make an element draggable via its handle ───
  function makeDraggable(toolbar) {
    const handle = toolbar.querySelector('#nlm-ext-drag-handle');
    if (!handle) return;

    let isDragging = false;
    let startX, startY, origX, origY;

    function onPointerDown(e) {
      // Only left mouse or primary touch
      if (e.button && e.button !== 0) return;
      e.preventDefault();

      isDragging = true;
      toolbar.classList.add('is-dragging');

      const rect = toolbar.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      startX = e.clientX;
      startY = e.clientY;

      // Switch to top/left positioning
      toolbar.style.left = origX + 'px';
      toolbar.style.top = origY + 'px';
      toolbar.style.right = 'auto';
      toolbar.style.bottom = 'auto';

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    }

    function onPointerMove(e) {
      if (!isDragging) return;
      e.preventDefault();

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      toolbar.style.left = (origX + dx) + 'px';
      toolbar.style.top = (origY + dy) + 'px';
    }

    function onPointerUp(e) {
      if (!isDragging) return;
      isDragging = false;
      toolbar.classList.remove('is-dragging');

      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);

      // Clamp so it doesn't go off-screen
      clampToViewport(toolbar);

      // Persist position
      saveToolbarPosition(toolbar);
    }

    handle.addEventListener('pointerdown', onPointerDown);
  }

  // ─── Create floating toolbar ───
  function createToolbar() {
    if (document.querySelector('.nlm-ext-toolbar')) return;
    if (!isEnabled) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'nlm-ext-toolbar';
    toolbar.innerHTML = `
      <div class="nlm-ext-drag-handle" id="nlm-ext-drag-handle" title="Drag to move">
        <svg viewBox="0 0 24 24"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="10" r="1.5"/><circle cx="15" cy="10" r="1.5"/><circle cx="9" cy="15" r="1.5"/><circle cx="15" cy="15" r="1.5"/><circle cx="9" cy="20" r="1.5"/><circle cx="15" cy="20" r="1.5"/></svg>
      </div>
      <button class="nlm-ext-btn nlm-ext-btn-select" id="nlm-ext-select-all">
        <i class="ms ms-select_all"></i> Select all
      </button>
      <span class="nlm-ext-count" id="nlm-ext-count">0 selected</span>
      <button class="nlm-ext-btn nlm-ext-btn-delete" id="nlm-ext-delete" style="display:none">
        <i class="ms ms-delete"></i> Delete
      </button>
      <button class="nlm-ext-btn nlm-ext-btn-sync" id="nlm-ext-sync" style="display:${isSyncEnabled ? 'inline-flex' : 'none'}">
        <i class="ms ms-sync"></i> Sync Drive
      </button>
    `;
    document.body.appendChild(toolbar);

    // ── Make toolbar draggable ──
    makeDraggable(toolbar);
    restoreToolbarPosition(toolbar);

    // ── Select all / Deselect all ──
    document.getElementById('nlm-ext-select-all').addEventListener('click', () => {
      const cbs = getAllCheckboxes();
      if (cbs.length === 0) return;

      const allChecked = Array.from(cbs).every(cb => cb.checked);
      const newState = !allChecked;

      cbs.forEach(cb => {
        if (cb.checked !== newState) {
          cb.checked = newState;
          // Update visual wrapper state
          const wrap = cb.closest('.nlm-ext-checkbox-wrap');
          if (wrap) wrap.classList.toggle('is-checked', newState);
        }
      });

      updateToolbar();
    });

    // ── Delete selected ──
    document.getElementById('nlm-ext-delete').addEventListener('click', async () => {
      const checked = document.querySelectorAll('.nlm-ext-checkbox:checked');
      if (!checked.length) return;

      const nbId = getNotebookIdFromUrl();
      if (!nbId) return;

      const btn = document.getElementById('nlm-ext-delete');
      btn.disabled = true;
      btn.innerHTML = '<i class="ms ms-hourglass_empty"></i> Deleting...';

      try {
        // Get sources from background (via RPC API)
        const response = await safeSendMessage({ cmd: 'get-sources', params: { notebookId: nbId } });
        const sources = response.sources || [];

        if (sources.length === 0) {
          throw new Error('Could not fetch sources from API');
        }

        // Match checked items to sources by title (normalized)
        const sourceIds = [];
        const itemSelectors = '.single-source-container, source-list-item, [data-source-id], .source-item, mat-list-option, .cdk-drag';

        checked.forEach(cb => {
          const item = cb.closest(itemSelectors);
          if (!item) return;

          const itemTitle = getSourceTitle(item);
          if (!itemTitle) return;

          // Normalize for comparison: lowercase, collapse whitespace
          const normalizedItemTitle = itemTitle.toLowerCase().replace(/\s+/g, ' ');

          const match = sources.find(s => {
            const normalizedSourceTitle = (s.title || '').toLowerCase().replace(/\s+/g, ' ');
            return normalizedItemTitle.includes(normalizedSourceTitle) ||
                   normalizedSourceTitle.includes(normalizedItemTitle);
          });

          if (match && !sourceIds.includes(match.id)) {
            sourceIds.push(match.id);
          }
        });

        if (sourceIds.length > 0) {
          const confirmMsg = `Delete ${sourceIds.length} source(s)?`;
          if (!confirm(confirmMsg)) {
            btn.disabled = false;
            btn.innerHTML = '<i class="ms ms-delete"></i> Delete';
            return;
          }

          await safeSendMessage({ cmd: 'delete-sources', params: { notebookId: nbId, sourceIds } });
          // Reload page to reflect changes
          location.reload();
        } else {
          throw new Error('Could not match selected items to sources');
        }
      } catch (e) {
        console.error('Bulk delete error:', e);
        btn.innerHTML = '<i class="ms ms-error"></i> Error';
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = '<i class="ms ms-delete"></i> Delete';
        }, 2000);
      }
    });

    // ── Sync Drive ──
    document.getElementById('nlm-ext-sync').addEventListener('click', async () => {
      const nbId = getNotebookIdFromUrl();
      if (!nbId) return;

      const btn = document.getElementById('nlm-ext-sync');
      btn.disabled = true;
      btn.innerHTML = '<i class="ms ms-sync"></i> Syncing...';

      try {
        const result = await safeSendMessage({ cmd: 'sync-drive-sources', params: { notebookId: nbId } });
        const r = result.results || {};
        btn.innerHTML = `<i class="ms ms-check"></i> ${r.synced || 0} synced`;
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = '<i class="ms ms-sync"></i> Sync Drive';
        }, 3000);
      } catch (e) {
        console.error('Sync error:', e);
        btn.disabled = false;
        btn.innerHTML = '<i class="ms ms-sync"></i> Sync Drive';
      }
    });
  }

  // ─── Update toolbar state ───
  function updateToolbar() {
    const count = getCheckedCount();
    const countEl = document.getElementById('nlm-ext-count');
    const deleteBtn = document.getElementById('nlm-ext-delete');
    const selectBtn = document.getElementById('nlm-ext-select-all');

    if (countEl) countEl.textContent = `${count} selected`;
    if (deleteBtn) deleteBtn.style.display = count > 0 ? 'inline-flex' : 'none';

    // Update Select All button text
    if (selectBtn) {
      const cbs = getAllCheckboxes();
      const allChecked = cbs.length > 0 && Array.from(cbs).every(cb => cb.checked);
      selectBtn.innerHTML = allChecked
        ? '<i class="ms ms-select_all"></i> Deselect all'
        : '<i class="ms ms-select_all"></i> Select all';
    }
  }

  // ─── Start observer for dynamically loaded sources ───
  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      scheduleAddCheckboxes(200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Remove all extension UI (for cleanup on navigation away from notebook) ───
  function cleanupCheckboxes() {
    document.querySelectorAll('.nlm-ext-checkbox-wrap').forEach(el => el.remove());
    document.querySelectorAll('.nlm-ext-has-checkbox').forEach(el => {
      el.classList.remove('nlm-ext-has-checkbox');
    });
  }

  // ─── Setup (called on each navigation) ───
  function setup() {
    const nbId = getNotebookIdFromUrl();
    if (!nbId) {
      // Not on a notebook page, hide toolbar
      const toolbar = document.querySelector('.nlm-ext-toolbar');
      if (toolbar) toolbar.style.display = 'none';
      if (observer) observer.disconnect();
      cleanupCheckboxes();
      return;
    }

    // If notebook changed, clean up old checkboxes
    if (currentNotebookId && currentNotebookId !== nbId) {
      cleanupCheckboxes();
    }

    currentNotebookId = nbId;

    if (!isEnabled) return;

    // Show/create toolbar
    const toolbar = document.querySelector('.nlm-ext-toolbar');
    if (toolbar) {
      toolbar.style.display = 'flex';
      updateToolbar();
    } else {
      createToolbar();
    }

    addCheckboxes();
    startObserver();
    // Retry with increasing delays for Angular lazy-loaded content
    setTimeout(addCheckboxes, 500);
    setTimeout(addCheckboxes, 1500);
    setTimeout(addCheckboxes, 3000);
  }

  // ─── Listen for messages from popup/background ───
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.cmd === 'set-theme') {
      applyTheme(msg.theme);
      sendResponse({ success: true });
    }
    if (msg.cmd === 'ping') {
      sendResponse({ alive: true, notebookId: currentNotebookId });
    }
  });

  // ─── Init ───
  async function init() {
    document.documentElement.setAttribute('data-nlm-ext', 'v3');

    // Bail if extension context already dead (e.g. leftover after update)
    if (!isContextValid()) {
      console.warn('NLM Assistant: extension context invalidated, skipping init.');
      return;
    }

    injectStyles();

    // Load settings
    try {
      const settings = await chrome.storage.sync.get(['enableBulkDelete', 'enableSyncDrive', 'theme']);
      isEnabled = settings.enableBulkDelete !== false;
      isSyncEnabled = settings.enableSyncDrive !== false;
      if (settings.theme) applyTheme(settings.theme);
    } catch (e) {}

    // Initial setup
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setup);
    } else {
      setup();
    }

    // ─── SPA navigation detection ───
    let lastUrl = location.href;
    const urlObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(setup, 500);
      }
    });
    urlObserver.observe(document.body, { childList: true, subtree: true });

    // Intercept History API
    const origPush = history.pushState;
    history.pushState = function() {
      origPush.apply(this, arguments);
      setTimeout(setup, 500);
    };
    const origReplace = history.replaceState;
    history.replaceState = function() {
      origReplace.apply(this, arguments);
      setTimeout(setup, 500);
    };
    window.addEventListener('popstate', () => setTimeout(setup, 500));

    // Watch settings changes in real-time
    chrome.storage.onChanged.addListener((changes, ns) => {
      if (ns === 'sync') {
        if (changes.enableBulkDelete) {
          isEnabled = changes.enableBulkDelete.newValue !== false;
          const toolbar = document.querySelector('.nlm-ext-toolbar');
          if (toolbar) toolbar.style.display = isEnabled ? 'flex' : 'none';
          if (!isEnabled) cleanupCheckboxes();
          else { addCheckboxes(); startObserver(); }
        }
        if (changes.enableSyncDrive) {
          isSyncEnabled = changes.enableSyncDrive.newValue !== false;
          const btn = document.getElementById('nlm-ext-sync');
          if (btn) btn.style.display = isSyncEnabled ? 'inline-flex' : 'none';
        }
        if (changes.theme) {
          applyTheme(changes.theme.newValue);
        }
      }
    });

    // Re-add checkboxes on clicks (debounced to avoid spam)
    document.addEventListener('click', () => scheduleAddCheckboxes(300));

    // Keep toolbar inside viewport on resize
    window.addEventListener('resize', () => {
      const toolbar = document.querySelector('.nlm-ext-toolbar');
      if (toolbar && toolbar.style.left && toolbar.style.left !== 'auto') {
        clampToViewport(toolbar);
      }
    });
  }

  init();
})();
