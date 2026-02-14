/* NotebookLM Assistant v3.0 — Popup Logic */

// ─── Helpers ───
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const bg = (cmd, params = {}) => chrome.runtime.sendMessage({ cmd, params });

function showStatus(elId, msg, type, duration = 4000) {
  const el = $(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = `status show ${type}`;
  if (duration > 0) setTimeout(() => { el.className = 'status'; }, duration);
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text || '';
  return d.innerHTML;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

// Source type → icon mapping
const sourceIcons = {
  google_docs: 'ms-description',
  google_other: 'ms-cloud',
  pdf: 'ms-picture_as_pdf',
  pasted_text: 'ms-edit_note',
  web_page: 'ms-language',
  generated_text: 'ms-auto_fix_high',
  youtube: 'ms-smart_display',
  uploaded_file: 'ms-upload_file',
  image: 'ms-image',
  word_doc: 'ms-article',
  unknown: 'ms-help_outline'
};

// ─── State ───
let currentNotebookId = null;
let parseTimer = null;

// ═══════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#panel-${tab.dataset.tab}`).classList.add('active');

    // Lazy-load data when tab activated
    if (tab.dataset.tab === 'queue') loadQueue();
    if (tab.dataset.tab === 'organize') loadSources();
    if (tab.dataset.tab === 'history') loadHistory();
    if (tab.dataset.tab === 'parsers') checkYouTubeTab();
  });
});

// ═══════════════════════════════════════
// THEME
// ═══════════════════════════════════════
async function initTheme() {
  const data = await chrome.storage.sync.get(['theme']);
  const theme = data.theme || 'light';
  applyTheme(theme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const headerSel = $('#theme-select');
  if (headerSel) headerSel.value = theme;
  $('#settings-theme').value = theme;
  // Sync to content script
  chrome.tabs.query({ url: 'https://notebooklm.google.com/*' }, tabs => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { cmd: 'set-theme', theme }).catch(() => {});
    });
  });
}

// Theme only controlled from Settings tab
$('#settings-theme').addEventListener('change', async (e) => {
  const theme = e.target.value;
  await chrome.storage.sync.set({ theme });
  applyTheme(theme);
});

// ═══════════════════════════════════════
// i18n
// ═══════════════════════════════════════
async function initI18n() {
  if (typeof I18n !== 'undefined') {
    await I18n.init();
  }
}

// ═══════════════════════════════════════
// ACCOUNTS
// ═══════════════════════════════════════
async function loadAccounts() {
  const select = $('#account-select');
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const accounts = await bg('list-accounts');
    select.innerHTML = '';
    if (Array.isArray(accounts) && accounts.length > 0) {
      accounts.forEach(acc => {
        const opt = document.createElement('option');
        opt.value = acc.authuser;
        opt.textContent = `${acc.name || acc.email} (${acc.email})`;
        select.appendChild(opt);
      });
      // Set first account
      await bg('set-authuser', { authuser: 0 });
      await loadNotebooks();
    } else {
      select.innerHTML = '<option value="">No accounts found</option>';
    }
  } catch (e) {
    select.innerHTML = '<option value="">Error loading accounts</option>';
  }
}

$('#account-select').addEventListener('change', async (e) => {
  const authuser = parseInt(e.target.value) || 0;
  await bg('set-authuser', { authuser });
  loadNotebooks();
});

// ═══════════════════════════════════════
// NOTEBOOKS
// ═══════════════════════════════════════
async function loadNotebooks() {
  const select = $('#notebook-select');
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const notebooks = await bg('list-notebooks');
    select.innerHTML = '<option value="">Select notebook...</option>';
    if (Array.isArray(notebooks)) {
      notebooks.forEach(nb => {
        const opt = document.createElement('option');
        opt.value = nb.id;
        opt.textContent = `${nb.emoji || ''} ${nb.title}`.trim();
        select.appendChild(opt);
      });
    }
    // Restore last selected
    const stored = await chrome.storage.local.get(['lastNotebookId']);
    if (stored.lastNotebookId) {
      select.value = stored.lastNotebookId;
      // Verify the option actually exists in the list
      if (select.value === stored.lastNotebookId) {
        currentNotebookId = stored.lastNotebookId;
      } else {
        // Notebook was deleted or belongs to different account
        currentNotebookId = null;
        await chrome.storage.local.remove(['lastNotebookId']);
      }
    }
  } catch (e) {
    select.innerHTML = '<option value="">Error — are you logged in?</option>';
  }
}

$('#notebook-select').addEventListener('change', async (e) => {
  currentNotebookId = e.target.value;
  await chrome.storage.local.set({ lastNotebookId: currentNotebookId });
});

$('#refresh-notebooks').addEventListener('click', loadNotebooks);

// ─── Create notebook ───
$('#create-notebook').addEventListener('click', async () => {
  const title = $('#new-notebook-title').value.trim();
  if (!title) return;
  showStatus('#home-status', 'Creating...', 'info', 0);
  try {
    const result = await bg('create-notebook', { title });
    if (result.id) {
      showStatus('#home-status', `Created: ${title}`, 'success');
      $('#new-notebook-title').value = '';
      loadNotebooks();
    } else {
      showStatus('#home-status', 'Could not create notebook', 'error');
    }
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// ═══════════════════════════════════════
// HOME — ADD ACTIONS
// ═══════════════════════════════════════
function requireNotebook() {
  if (!currentNotebookId) {
    showStatus('#home-status', 'Please select a notebook first', 'warning');
    return false;
  }
  return true;
}

// Add current page
$('#add-current-page').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  showStatus('#home-status', 'Adding...', 'info', 0);
  try {
    const tab = await bg('get-current-tab');
    await bg('add-source', { notebookId: currentNotebookId, url: tab.url });
    showStatus('#home-status', `Added: ${tab.title}`, 'success');
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// Add as PDF
$('#add-as-pdf').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  showStatus('#home-status', 'Capturing PDF...', 'info', 0);
  try {
    const tab = await bg('get-current-tab');
    await bg('add-as-pdf', { notebookId: currentNotebookId, tabId: tab.id, title: tab.title });
    showStatus('#home-status', `PDF saved: ${tab.title}`, 'success');
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// Add single URL
$('#add-single-url').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  const url = $('#single-url').value.trim();
  if (!url) return;
  showStatus('#home-status', 'Adding...', 'info', 0);
  try {
    await bg('add-source', { notebookId: currentNotebookId, url });
    showStatus('#home-status', 'Added!', 'success');
    $('#single-url').value = '';
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// Bulk import — add directly
$('#bulk-add').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  const urls = $('#bulk-urls').value.trim().split('\n').map(u => u.trim()).filter(u => u);
  if (!urls.length) return;
  showStatus('#home-status', `Adding ${urls.length} URLs...`, 'info', 0);
  try {
    await bg('add-sources', { notebookId: currentNotebookId, urls });
    showStatus('#home-status', `Added ${urls.length} sources!`, 'success');
    $('#bulk-urls').value = '';
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// Bulk import — add to queue
$('#bulk-queue').addEventListener('click', async () => {
  const urls = $('#bulk-urls').value.trim().split('\n').map(u => u.trim()).filter(u => u);
  if (!urls.length) return;
  await bg('add-to-queue', { items: urls.map(url => ({ url })) });
  showStatus('#home-status', `${urls.length} URLs added to queue`, 'success');
  $('#bulk-urls').value = '';
});

// Import tabs
$('#import-tabs').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
});

// ═══════════════════════════════════════
// PARSERS — YouTube Comments
// ═══════════════════════════════════════
async function checkYouTubeTab() {
  const tab = await bg('get-current-tab');
  const info = $('#yt-info');
  if (tab && tab.url && tab.url.includes('youtube.com/watch')) {
    info.style.display = 'block';
    info.innerHTML = `<i class="ms ms-smart_display" style="font-size:14px;vertical-align:middle"></i> ${escapeHtml(tab.title)}`;
    $('#start-parse').disabled = false;
  } else {
    info.style.display = 'block';
    info.innerHTML = '<i class="ms ms-info" style="font-size:14px;vertical-align:middle"></i> Navigate to a YouTube video tab to parse comments';
    $('#start-parse').disabled = true;
  }
}

$('#start-parse').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  const tab = await bg('get-current-tab');
  if (!tab || !tab.url.includes('youtube.com/watch')) return;

  // Extract video ID
  const vMatch = tab.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (!vMatch) return;

  // Save settings
  await chrome.storage.local.set({
    commentsMode: $('#comments-mode').value,
    commentsLimit: parseInt($('#comments-limit').value) || 1000,
    commentsIncludeReplies: $('#comments-replies').checked
  });

  try {
    const result = await bg('parse-comments', {
      notebookId: currentNotebookId,
      videoId: vMatch[1],
      tabId: tab.id
    });

    if (result.error) {
      showStatus('#home-status', `Error: ${result.error}`, 'error');
      return;
    }

    // Show progress
    $('#parse-progress').style.display = 'flex';
    $('#start-parse').style.display = 'none';
    startParsePolling();
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

$('#cancel-parse').addEventListener('click', async () => {
  await bg('cancel-parse');
  stopParsePolling();
  $('#parse-progress').style.display = 'none';
  $('#start-parse').style.display = '';
});

function startParsePolling() {
  stopParsePolling();
  parseTimer = setInterval(async () => {
    const status = await bg('get-parse-status');
    const fill = $('#parse-fill');
    const text = $('#parse-text');

    if (!status.active && status.progress.phase === 'done') {
      stopParsePolling();
      fill.style.width = '100%';
      text.textContent = `Done! ${status.result?.commentCount || 0} comments in ${status.result?.partCount || 0} parts`;
      setTimeout(() => {
        $('#parse-progress').style.display = 'none';
        $('#start-parse').style.display = '';
      }, 5000);
      return;
    }

    if (!status.active && (status.progress.phase === 'error' || status.progress.phase === 'cancelled')) {
      stopParsePolling();
      text.textContent = status.error ? `Error: ${status.error.message}` : 'Cancelled';
      setTimeout(() => {
        $('#parse-progress').style.display = 'none';
        $('#start-parse').style.display = '';
      }, 3000);
      return;
    }

    // Update progress
    const fetched = status.progress.fetched || 0;
    const total = status.progress.total || 0;
    const pct = total > 0 ? Math.min(Math.round(fetched / total * 100), 95) : 0;
    fill.style.width = (status.progress.phase === 'sending' ? '90%' : status.progress.phase === 'formatting' ? '85%' : pct + '%');

    const phases = {
      fetching: `Fetching comments... ${fetched}${total ? '/' + total : ''}`,
      fetching_replies: `Fetching replies... ${fetched}`,
      formatting: 'Formatting to Markdown...',
      sending: 'Sending to NotebookLM...'
    };
    text.textContent = phases[status.progress.phase] || status.progress.phase;
  }, 1000);
}

function stopParsePolling() {
  if (parseTimer) { clearInterval(parseTimer); parseTimer = null; }
}

// ═══════════════════════════════════════
// PARSERS — RSS / Sitemap
// ═══════════════════════════════════════
$('#rss-parse').addEventListener('click', async () => {
  const url = $('#rss-url').value.trim();
  if (!url) return;
  const container = $('#rss-results');
  container.innerHTML = '<div class="text-muted text-center">Parsing...</div>';

  try {
    // Fetch and parse RSS/Sitemap in background context (CORS-free)
    const tab = await bg('get-current-tab');
    // For now, add URL directly to queue since full RSS parsing needs fetch access
    await bg('add-to-queue', { items: [{ url, title: 'RSS: ' + url }] });
    container.innerHTML = '<div class="text-muted text-center">URL added to queue</div>';
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${e.message}</div>`;
  }
});

$('#rss-detect').addEventListener('click', async () => {
  const tab = await bg('get-current-tab');
  if (!tab) return;
  const feeds = await bg('detect-rss', { tabId: tab.id });
  const container = $('#rss-results');

  if (!feeds || !feeds.length) {
    container.innerHTML = '<div class="text-muted text-center">No RSS feeds found on this page</div>';
    return;
  }

  container.innerHTML = feeds.map(f => `
    <div class="result-item">
      <input type="checkbox" checked>
      <i class="ms ms-rss_feed" style="font-size:14px;color:var(--accent)"></i>
      <span class="title">${escapeHtml(f.title)}</span>
      <span class="url">${escapeHtml(f.url)}</span>
    </div>
  `).join('');
});

// ═══════════════════════════════════════
// PARSERS — YouTube Playlist / Links
// ═══════════════════════════════════════
$('#yt-extract').addEventListener('click', async () => {
  const tab = await bg('get-current-tab');
  if (!tab) return;
  const container = $('#yt-results');
  container.innerHTML = '<div class="text-muted text-center">Extracting...</div>';

  const urls = await bg('extract-yt-urls', { tabId: tab.id });
  if (!urls.length) {
    container.innerHTML = '<div class="text-muted text-center">No YouTube links found</div>';
    return;
  }

  container.innerHTML = `
    <div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${urls.length} videos found</div>
    ${urls.map(u => `
      <div class="result-item">
        <input type="checkbox" class="yt-cb" data-url="${escapeHtml(u)}" checked>
        <i class="ms ms-smart_display" style="font-size:14px;color:var(--danger)"></i>
        <span class="title">${escapeHtml(u)}</span>
      </div>
    `).join('')}
    <button class="btn btn-primary btn-full mt-8" id="yt-add-selected">
      <i class="ms ms-add"></i> Add selected to queue
    </button>
  `;

  container.querySelector('#yt-add-selected')?.addEventListener('click', async () => {
    const checked = container.querySelectorAll('.yt-cb:checked');
    const items = Array.from(checked).map(cb => ({ url: cb.dataset.url }));
    if (items.length) {
      await bg('add-to-queue', { items });
      showStatus('#home-status', `${items.length} videos added to queue`, 'success');
    }
  });
});

$('#extract-links').addEventListener('click', async () => {
  const tab = await bg('get-current-tab');
  if (!tab) return;
  const container = $('#links-results');
  container.innerHTML = '<div class="text-muted text-center">Extracting...</div>';

  const links = await bg('extract-links', { tabId: tab.id });
  if (!links.length) {
    container.innerHTML = '<div class="text-muted text-center">No links found</div>';
    return;
  }

  container.innerHTML = `
    <div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${links.length} links found</div>
    ${links.slice(0, 50).map(l => `
      <div class="result-item">
        <input type="checkbox" class="link-cb" data-url="${escapeHtml(l.url)}">
        <i class="ms ms-link" style="font-size:14px"></i>
        <span class="title">${escapeHtml(l.title)}</span>
      </div>
    `).join('')}
    ${links.length > 50 ? `<div class="text-muted text-center">...and ${links.length - 50} more</div>` : ''}
    <button class="btn btn-primary btn-full mt-8" id="links-add-selected">
      <i class="ms ms-add"></i> Add selected to queue
    </button>
  `;

  container.querySelector('#links-add-selected')?.addEventListener('click', async () => {
    const checked = container.querySelectorAll('.link-cb:checked');
    const items = Array.from(checked).map(cb => ({ url: cb.dataset.url }));
    if (items.length) {
      await bg('add-to-queue', { items });
      showStatus('#home-status', `${items.length} links added to queue`, 'success');
    }
  });
});

// ═══════════════════════════════════════
// QUEUE
// ═══════════════════════════════════════
async function loadQueue() {
  const queue = await bg('get-queue');
  const list = $('#queue-list');
  const count = $('#queue-count');
  count.textContent = queue.length;

  if (!queue.length) {
    list.innerHTML = '<div class="text-muted text-center" style="padding:16px">Queue is empty</div>';
    return;
  }

  list.innerHTML = queue.map((item, i) => `
    <div class="queue-item" data-idx="${i}">
      <i class="ms ms-link" style="font-size:14px;color:var(--accent)"></i>
      <span class="title" title="${escapeHtml(item.url)}">${escapeHtml(item.title || item.url)}</span>
      <button class="remove" data-idx="${i}" title="Remove">&times;</button>
    </div>
  `).join('');

  // Remove individual items
  list.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      queue.splice(idx, 1);
      await chrome.storage.local.set({ queue });
      loadQueue();
    });
  });
}

$('#process-queue').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  showStatus('#queue-status', 'Processing queue...', 'info', 0);
  try {
    const result = await bg('process-queue', { notebookId: currentNotebookId });
    showStatus('#queue-status', `Done! ${result.processed} added, ${result.errors || 0} errors`, result.errors ? 'warning' : 'success');
    loadQueue();
  } catch (e) {
    showStatus('#queue-status', `Error: ${e.message}`, 'error');
  }
});

$('#clear-queue').addEventListener('click', async () => {
  await bg('clear-queue');
  loadQueue();
});

// ═══════════════════════════════════════
// ORGANIZE — Sources
// ═══════════════════════════════════════
let currentSources = [];

async function loadSources() {
  if (!currentNotebookId) {
    $('#sources-list').innerHTML = '<div class="text-muted text-center" style="padding:16px">Select a notebook first</div>';
    return;
  }

  $('#sources-list').innerHTML = '<div class="text-muted text-center" style="padding:16px">Loading sources...</div>';

  try {
    const nb = await bg('get-notebook', { notebookId: currentNotebookId });
    currentSources = nb.sources || [];
    renderSources();
  } catch (e) {
    $('#sources-list').innerHTML = `<div class="text-muted text-center" style="padding:16px">Error: ${e.message}</div>`;
  }
}

function renderSources() {
  const list = $('#sources-list');
  if (!currentSources.length) {
    list.innerHTML = '<div class="text-muted text-center" style="padding:16px">No sources in this notebook</div>';
    return;
  }

  list.innerHTML = currentSources.map(s => `
    <div class="source-item" data-source-id="${s.id}">
      <input type="checkbox" class="source-cb" data-id="${s.id}">
      <i class="ms ${sourceIcons[s.type] || 'ms-help_outline'}"></i>
      <span class="title" title="${escapeHtml(s.url || '')}">${escapeHtml(s.title)}</span>
      <span class="type">${s.type}</span>
      ${s.canSync ? '<i class="ms ms-cloud_sync sync-badge" title="Drive source"></i>' : ''}
    </div>
  `).join('');

  // Update delete count on checkbox changes
  list.querySelectorAll('.source-cb').forEach(cb => {
    cb.addEventListener('change', updateDeleteCount);
  });
}

function updateDeleteCount() {
  const checked = $$('.source-cb:checked').length;
  const delBtn = $('#delete-selected');
  const countEl = $('#del-count');
  delBtn.style.display = checked > 0 ? '' : 'none';
  countEl.textContent = checked;
}

$('#refresh-sources').addEventListener('click', loadSources);

$('#select-all-sources').addEventListener('click', () => {
  const cbs = $$('.source-cb');
  const allChecked = Array.from(cbs).every(cb => cb.checked);
  cbs.forEach(cb => { cb.checked = !allChecked; });
  updateDeleteCount();
});

$('#delete-selected').addEventListener('click', async () => {
  const ids = Array.from($$('.source-cb:checked')).map(cb => cb.dataset.id);
  if (!ids.length || !currentNotebookId) return;
  if (!confirm(`Delete ${ids.length} sources?`)) return;

  showStatus('#organize-status', 'Deleting...', 'info', 0);
  try {
    await bg('delete-sources', { notebookId: currentNotebookId, sourceIds: ids });
    showStatus('#organize-status', `Deleted ${ids.length} sources`, 'success');
    loadSources();
  } catch (e) {
    showStatus('#organize-status', `Error: ${e.message}`, 'error');
  }
});

$('#sync-drive').addEventListener('click', async () => {
  if (!currentNotebookId) return;
  showStatus('#organize-status', 'Syncing Drive sources...', 'info', 0);
  try {
    const result = await bg('sync-drive-sources', { notebookId: currentNotebookId });
    const r = result.results || {};
    showStatus('#organize-status', `Sync: ${r.synced || 0} updated, ${r.fresh || 0} up-to-date, ${r.skipped || 0} skipped`, 'success');
  } catch (e) {
    showStatus('#organize-status', `Error: ${e.message}`, 'error');
  }
});

$('#export-sources').addEventListener('click', () => {
  if (!currentSources.length) return;
  const text = currentSources.map(s => `${s.title}\t${s.type}\t${s.url || ''}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'notebooklm-sources.txt';
  a.click();
  URL.revokeObjectURL(url);
});

// ═══════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════
async function loadHistory() {
  const history = await bg('get-history');
  const list = $('#history-list');

  if (!history.length) {
    list.innerHTML = '<div class="text-muted text-center" style="padding:16px">No history yet</div>';
    return;
  }

  renderHistory(history);
}

function renderHistory(history) {
  const list = $('#history-list');
  list.innerHTML = history.map(h => {
    const iconMap = {
      add_source: 'ms-add_link',
      add_text: 'ms-edit_note',
      add_pdf: 'ms-picture_as_pdf',
      delete_source: 'ms-delete',
      delete_sources: 'ms-delete_sweep',
      error: 'ms-error'
    };
    const iconCls = iconMap[h.action] || 'ms-info';
    const detail = h.url || h.title || `${h.count || 1} sources`;
    return `
      <div class="history-item">
        <i class="ms ${iconCls}"></i>
        <div class="details">${escapeHtml(detail)}</div>
        <span class="time">${timeAgo(h.timestamp)}</span>
      </div>
    `;
  }).join('');
}

$('#history-search').addEventListener('input', async (e) => {
  const q = e.target.value.toLowerCase();
  const history = await bg('get-history');
  const filtered = q ? history.filter(h =>
    (h.url || '').toLowerCase().includes(q) ||
    (h.title || '').toLowerCase().includes(q) ||
    (h.action || '').toLowerCase().includes(q)
  ) : history;
  renderHistory(filtered);
});

$('#clear-history').addEventListener('click', async () => {
  if (!confirm('Clear all history?')) return;
  await bg('clear-history');
  loadHistory();
});

// ═══════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════
async function loadSettings() {
  const sync = await chrome.storage.sync.get(['theme', 'language', 'enableBulkDelete', 'enableSyncDrive', 'enableNotifications']);
  const local = await chrome.storage.local.get(['addDelay']);

  $('#settings-theme').value = sync.theme || 'light';
  $('#settings-lang').value = sync.language || 'en';
  $('#settings-delay').value = local.addDelay || 2000;
  $('#settings-bulk-delete').checked = sync.enableBulkDelete !== false;
  $('#settings-sync-drive').checked = sync.enableSyncDrive !== false;
  $('#settings-notifications').checked = sync.enableNotifications !== false;
}

// Auto-save all settings on change
['#settings-lang', '#settings-delay', '#settings-bulk-delete', '#settings-sync-drive', '#settings-notifications'].forEach(sel => {
  $(sel).addEventListener('change', saveSettings);
});

async function saveSettings() {
  await chrome.storage.sync.set({
    theme: $('#settings-theme').value,
    language: $('#settings-lang').value,
    enableBulkDelete: $('#settings-bulk-delete').checked,
    enableSyncDrive: $('#settings-sync-drive').checked,
    enableNotifications: $('#settings-notifications').checked
  });
  await chrome.storage.local.set({
    addDelay: parseInt($('#settings-delay').value) || 2000
  });

  // Apply language
  if (typeof I18n !== 'undefined') {
    await I18n.setLanguage($('#settings-lang').value);
  }
}

// Backup
$('#backup-settings').addEventListener('click', async () => {
  const sync = await chrome.storage.sync.get(null);
  const local = await chrome.storage.local.get(null);
  const backup = { sync, local, version: '3.0', date: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nlm-assistant-backup-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Restore
$('#restore-settings').addEventListener('click', () => {
  $('#restore-file').click();
});

$('#restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    if (backup.sync) await chrome.storage.sync.set(backup.sync);
    if (backup.local) await chrome.storage.local.set(backup.local);
    loadSettings();
    initTheme();
    showStatus('#home-status', 'Settings restored!', 'success');
  } catch (err) {
    showStatus('#home-status', 'Invalid backup file', 'error');
  }
});

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  await initTheme();
  await initI18n();
  await loadSettings();
  await loadAccounts();
});