/* NotebookLM Assistant v3.0 — Tab Import App */

const tabList = document.getElementById('tab-list');
const notebookSelect = document.getElementById('notebook-select');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');

let tabs = [];

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

function updateCount() {
  const checked = document.querySelectorAll('.tab-cb:checked').length;
  countEl.textContent = `${checked} / ${tabs.length} selected`;
}

async function loadTabs() {
  tabs = await chrome.runtime.sendMessage({ cmd: 'get-open-tabs', params: {} });
  tabList.innerHTML = '';

  // Check if any URLs were passed via storage (from context menu)
  const stored = await chrome.storage.local.get(['pendingUrls']);
  if (stored.pendingUrls) {
    await chrome.storage.local.remove(['pendingUrls']);
  }

  tabs.forEach((tab, i) => {
    const li = document.createElement('li');
    li.className = 'tab-item';
    li.innerHTML = `
      <input type="checkbox" class="tab-cb" data-idx="${i}" checked>
      <img src="${tab.favIconUrl || 'icons/icon16.png'}">
      <span class="title">${escapeHtml(tab.title)}</span>
      <span class="url">${escapeHtml(tab.url)}</span>
    `;
    // Fallback icon on load error (CSP-safe, no inline handler)
    li.querySelector('img').addEventListener('error', function() {
      this.src = 'icons/icon16.png';
    });
    li.querySelector('.tab-cb').addEventListener('change', updateCount);
    tabList.appendChild(li);
  });

  updateCount();
}

async function loadNotebooks() {
  try {
    const notebooks = await chrome.runtime.sendMessage({ cmd: 'list-notebooks', params: {} });
    if (Array.isArray(notebooks)) {
      notebooks.forEach(nb => {
        const opt = document.createElement('option');
        opt.value = nb.id;
        opt.textContent = `${nb.emoji || ''} ${nb.title}`.trim();
        notebookSelect.appendChild(opt);
      });
    }
  } catch (e) {
    showStatus('Could not load notebooks. Make sure you are logged into NotebookLM.', 'error');
  }
}

function getSelectedUrls() {
  const selected = [];
  document.querySelectorAll('.tab-cb:checked').forEach(cb => {
    const idx = parseInt(cb.dataset.idx);
    if (tabs[idx]) selected.push({ url: tabs[idx].url, title: tabs[idx].title });
  });
  return selected;
}

// Select all
document.getElementById('select-all').addEventListener('click', () => {
  const cbs = document.querySelectorAll('.tab-cb');
  const allChecked = Array.from(cbs).every(cb => cb.checked);
  cbs.forEach(cb => { cb.checked = !allChecked; });
  updateCount();
});

// Add selected directly
document.getElementById('add-selected').addEventListener('click', async () => {
  const nbId = notebookSelect.value;
  if (!nbId) { showStatus('Please select a notebook first.', 'error'); return; }

  const urls = getSelectedUrls();
  if (!urls.length) { showStatus('No tabs selected.', 'error'); return; }

  showStatus(`Adding ${urls.length} URLs to notebook...`, 'info');

  try {
    await chrome.runtime.sendMessage({
      cmd: 'add-sources',
      params: { notebookId: nbId, urls: urls.map(u => u.url) }
    });
    showStatus(`Successfully added ${urls.length} sources!`, 'success');
  } catch (e) {
    showStatus(`Error: ${e.message}`, 'error');
  }
});

// Add to queue
document.getElementById('add-as-queue').addEventListener('click', async () => {
  const urls = getSelectedUrls();
  if (!urls.length) { showStatus('No tabs selected.', 'error'); return; }

  await chrome.runtime.sendMessage({ cmd: 'add-to-queue', params: { items: urls } });
  showStatus(`Added ${urls.length} URLs to queue. Open popup to process.`, 'success');
});

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// Init
loadTabs();
loadNotebooks();
