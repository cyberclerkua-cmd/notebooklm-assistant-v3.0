/* NotebookLM Assistant v3.0 — Background Service Worker
 * Integrates: RPC API, PDF capture, YouTube comments, queue, history, hotkeys
 */

importScripts('lib/youtube-comments-api.js', 'lib/comments-to-md.js');

// ─── Fetch with timeout ───
async function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ─── NotebookLM RPC API (reverse-engineered, no public API) ───
const NotebookLMAPI = {
  tokens: {},

  async getTokens(authuser = 0) {
    const url = `https://notebooklm.google.com/?authuser=${authuser}`;
    const resp = await fetchWithTimeout(url, { credentials: 'include' });
    const html = await resp.text();

    const cfb2h = html.match(/"cfb2h":"([^"]+)"/);
    const snlm0e = html.match(/"SNlM0e":"([^"]+)"/);
    if (!cfb2h || !snlm0e) throw new Error('Could not extract NLM tokens. Are you logged in?');

    this.tokens = {
      cfb2h: cfb2h[1],
      SNlM0e: snlm0e[1],
      authuser
    };
    return this.tokens;
  },

  extractNotebookIdFromUrl(url) {
    const match = url && url.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  },

  // ─── Core RPC method ───
  async rpc(rpcId, params, sourcePath = '/') {
    if (!this.tokens.cfb2h) throw new Error('Not authenticated');

    const au = this.tokens.authuser || 0;
    const url = new URL('https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute');
    url.searchParams.set('rpcids', rpcId);
    url.searchParams.set('source-path', sourcePath);
    url.searchParams.set('f.sid', this.tokens.cfb2h);
    url.searchParams.set('hl', 'en');
    url.searchParams.set('authuser', au);
    url.searchParams.set('_reqid', Math.floor(Math.random() * 900000 + 100000));

    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[rpcId, JSON.stringify(params), null, 'generic']]]),
      'at': this.tokens.SNlM0e
    });

    const resp = await fetchWithTimeout(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      credentials: 'include',
      body
    });

    if (!resp.ok) throw new Error(`RPC ${rpcId} failed: ${resp.status}`);
    return resp.text();
  },

  // ─── List Google accounts ───
  async listAccounts() {
    try {
      const resp = await fetchWithTimeout(
        'https://accounts.google.com/ListAccounts?json=standard&source=ogb&md=1&cc=1&mn=1&mo=1&gpsia=1&fwput=860&listPages=1&origin=https%3A%2F%2Fwww.google.com',
        { credentials: 'include' }
      );
      const text = await resp.text();

      // Response format: postMessage('...' , 'https://...')
      const match = text.match(/postMessage\('([^']*)'\s*,\s*'https:/);
      if (!match) {
        // Fallback: try direct JSON parse (older format)
        try {
          const clean = text.replace(/^[^[]*/, '');
          const data = JSON.parse(clean);
          if (Array.isArray(data) && Array.isArray(data[0])) {
            return data[0]
              .filter(acc => acc[3] && acc[3].includes('@'))
              .map((acc, idx) => ({ email: acc[3], name: acc[2] || '', photo: acc[4] || '', authuser: idx }));
          }
        } catch (e2) {}
        return [];
      }

      // Decode hex-escaped characters
      const decoded = match[1]
        .replace(/\\x5b/g, '[')
        .replace(/\\x5d/g, ']')
        .replace(/\\x22/g, '"');

      const parsed = JSON.parse(decoded);
      const accounts = parsed[1] || [];

      return accounts
        .filter(acc => acc[3] && acc[3].includes('@'))
        .map((acc, idx) => ({
          email: acc[3] || '',
          name: acc[2] || '',
          photo: acc[4] || '',
          authuser: idx
        }));
    } catch (e) {
      console.error('listAccounts error:', e);
      return [];
    }
  },

  // ─── Notebooks ───
  async listNotebooks() {
    const resp = await this.rpc('wXbhsf', [null, 1, null, [2]]);
    return this._parseNotebookList(resp);
  },

  _parseNotebookList(text) {
    try {
      const lines = text.split('\n');
      const dataLine = lines.find(l => l.includes('wrb.fr'));
      if (!dataLine) return [];
      const parsed = JSON.parse(dataLine);
      const inner = JSON.parse(parsed[0][2]);
      if (!inner || !inner[0]) return [];
      return inner[0]
        .filter(item => item && item.length >= 3)
        .map(item => ({
          id: item[2],
          title: (item[0] || '').trim() || 'Untitled',
          sources: Array.isArray(item[1]) ? item[1].length : 0,
          emoji: item[3] || ''
        }))
        .filter(nb => nb.id);
    } catch (e) {
      console.error('parseNotebookList error:', e);
      return [];
    }
  },

  async createNotebook(title, emoji) {
    const resp = await this.rpc('CCqFvf', [title]);
    // Extract notebook ID (UUID format) from response
    const uuidMatch = resp.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    const id = uuidMatch ? uuidMatch[0] : this.extractNotebookIdFromUrl(resp);
    if (!id) throw new Error('Failed to create notebook');
    return { id, title, emoji };
  },

  // ─── Sources ───
  async addSource(notebookId, url) {
    return this.addSources(notebookId, [url]);
  },

  async addSources(notebookId, urls) {
    // Separate YouTube and regular URLs — they have different source formats
    const regularUrls = urls.filter(u => !u.match(/youtube\.com\/watch|youtu\.be\//));
    const youtubeUrls = urls.filter(u => u.match(/youtube\.com\/watch|youtu\.be\//));

    // Add regular URLs
    if (regularUrls.length) {
      const sources = regularUrls.map(u =>
        [null, null, [u], null, null, null, null, null]
      );
      await this.rpc('izAoDd', [sources, notebookId, [2], null, null], `/notebook/${notebookId}`);
    }

    // Add YouTube URLs (different format: 11-element array, URL at position [7])
    for (const u of youtubeUrls) {
      const source = [
        [null, null, null, null, null, null, null, [u], null, null, 1]
      ];
      await this.rpc('izAoDd', [
        source, notebookId, [2],
        [1, null, null, null, null, null, null, null, null, null, [1]]
      ], `/notebook/${notebookId}`);
    }
  },

  async addTextSource(notebookId, text, title = 'Imported content') {
    const source = [[[null, title, text]]];
    return this.rpc('izAoDd', [source, notebookId, [2], null, null], `/notebook/${notebookId}`);
  },

  // ─── PDF upload (3-step SCOTTY protocol) ───
  async registerPdfSource(notebookId, filename) {
    const resp = await this.rpc(
      'o4cbdc',
      [[[filename]], notebookId, [2], [1,null,null,null,null,null,null,null,null,null,[1]]],
      `/notebook/${notebookId}`
    );
    const lines = resp.split('\n');
    const dataLine = lines.find(l => l.includes('wrb.fr'));
    if (!dataLine) throw new Error('No response from registerPdfSource');
    const parsed = JSON.parse(dataLine);
    const inner = JSON.parse(parsed[0][2]);
    return inner[0][0][0];  // sourceId
  },

  async getUploadUrl(notebookId, filename, sourceId, byteLength) {
    const au = this.tokens.authuser || 0;
    const url = `https://notebooklm.google.com/upload/_/?authuser=${au}`;
    const metadata = JSON.stringify({
      PROJECT_ID: notebookId,
      SOURCE_NAME: filename,
      SOURCE_ID: sourceId
    });

    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-length': byteLength.toString(),
        'x-goog-upload-protocol': 'resumable'
      },
      credentials: 'include',
      body: metadata
    });

    if (!resp.ok) throw new Error(`Failed to get upload URL: ${resp.status}`);
    const uploadUrl = resp.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error('No upload URL in response');
    return uploadUrl;
  },

  async uploadPdfBytes(uploadUrl, pdfBytes) {
    const resp = await fetchWithTimeout(uploadUrl, {
      method: 'POST',
      headers: {
        'x-goog-upload-command': 'upload, finalize',
        'x-goog-upload-offset': '0',
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8'
      },
      body: pdfBytes
    });
    if (!resp.ok) throw new Error(`PDF upload failed: ${resp.status}`);
    return resp.text();
  },

  async addPdfSource(notebookId, pdfBase64, filename) {
    const sourceId = await this.registerPdfSource(notebookId, filename);
    const bytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
    const uploadUrl = await this.getUploadUrl(notebookId, filename, sourceId, bytes.byteLength);
    await this.uploadPdfBytes(uploadUrl, bytes);
    return { sourceId, filename };
  },

  // ─── Get notebook details + sources ───
  async getNotebook(notebookId) {
    const resp = await this.rpc('rLM1Ne', [notebookId, null, [2], null, 0], `/notebook/${notebookId}`);
    return this._parseNotebookDetails(resp);
  },

  _parseNotebookDetails(text) {
    try {
      const lines = text.split('\n');
      const dataLine = lines.find(l => l.includes('wrb.fr'));
      if (!dataLine) return { sources: [] };
      const parsed = JSON.parse(dataLine);
      const inner = JSON.parse(parsed[0][2]);
      if (!inner || !inner[0]) return { sources: [] };

      const nb = inner[0];
      const sourcesArr = Array.isArray(nb[1]) ? nb[1] : [];
      const typeNames = {
        1:'google_docs',2:'google_other',3:'pdf',4:'pasted_text',5:'web_page',
        8:'generated_text',9:'youtube',11:'uploaded_file',13:'image',14:'word_doc'
      };

      const sources = sourcesArr
        .filter(s => s && Array.isArray(s[0]) && s[0][0])
        .map(s => {
          const id = s[0][0];
          const title = s[1] || 'Untitled';
          const meta = Array.isArray(s[2]) ? s[2] : [];
          const typeCode = meta[4] || 0;
          const driveDocId = Array.isArray(meta[0]) ? meta[0][0] : null;
          const url = Array.isArray(meta[7]) ? meta[7][0] : null;
          return {
            id, title,
            type: typeNames[typeCode] || 'unknown',
            typeCode, url, driveDocId,
            canSync: driveDocId != null && (typeCode === 1 || typeCode === 2)
          };
        });

      return { id: nb[2] || null, title: nb[0] || '', sources };
    } catch (e) {
      console.error('parseNotebookDetails error:', e);
      return { sources: [] };
    }
  },

  // ─── Delete sources (batch, max 20 per call) ───
  async deleteSource(notebookId, sourceId) {
    return this.rpc('tGMBJ', [[[sourceId]]], `/notebook/${notebookId}`);
  },

  async deleteSources(notebookId, sourceIds) {
    const batchSize = 20;
    let deleted = 0;
    for (let i = 0; i < sourceIds.length; i += batchSize) {
      const batch = sourceIds.slice(i, i + batchSize).map(id => [id]);
      await this.rpc('tGMBJ', [batch], `/notebook/${notebookId}`);
      deleted += batch.length;
    }
    return { deleted };
  },

  // ─── Drive sync ───
  async checkSourceFreshness(sourceId, notebookId) {
    try {
      const resp = await this.rpc('yR9Yof', [null, [sourceId], [2]], `/notebook/${notebookId}`);
      const lines = resp.split('\n');
      const dataLine = lines.find(l => l.includes('wrb.fr'));
      if (!dataLine) return null;
      const parsed = JSON.parse(dataLine);
      const inner = JSON.parse(parsed[0][2]);
      if (!inner || !inner[0]) return null;
      return inner[0][0] === 1;  // 1 = fresh, 0 = stale
    } catch (e) {
      return null;
    }
  },

  async syncDriveSource(sourceId, notebookId) {
    return this.rpc('FLmJqe', [null, [sourceId], [2]], `/notebook/${notebookId}`);
  },

  getNotebookUrl(notebookId, authuser = 0) {
    return `https://notebooklm.google.com/notebook/${notebookId}?authuser=${authuser}`;
  }
};

// ─── PDF generation via Chrome Debugger ───
async function generatePdf(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4
    });
    return result.data;  // base64
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function addAsPdf(notebookId, tabId, title) {
  const pdfBase64 = await generatePdf(tabId);
  const filename = (title || 'page').replace(/[^a-zA-Z0-9_\- ]/g, '').substring(0, 80) + '.pdf';
  await NotebookLMAPI.addPdfSource(notebookId, pdfBase64, filename);
  return { success: true, filename };
}

// ─── YouTube comments parsing (state machine) ───
let parseState = {
  active: false,
  videoId: null,
  progress: { fetched: 0, total: null, phase: 'idle' },
  cancelToken: null,
  error: null,
  result: null
};

async function doParseComments(notebookId, videoId, tabId) {
  const cancelToken = { cancelled: false };
  parseState = {
    active: true, videoId,
    progress: { fetched: 0, total: null, phase: 'fetching' },
    cancelToken, error: null, result: null
  };

  try {
    // Phase 1: metadata from DOM
    const metadata = await YouTubeCommentsAPI.getVideoMetadataFromDOM(tabId, videoId);
    parseState.progress.total = metadata.commentCount;
    if (cancelToken.cancelled) return;

    // Load settings
    const settings = await chrome.storage.local.get(['commentsMode', 'commentsLimit', 'commentsIncludeReplies']);
    const mode = settings.commentsMode || 'top';
    const includeReplies = settings.commentsIncludeReplies !== undefined ? settings.commentsIncludeReplies : (mode === 'top');
    const maxComments = mode === 'top' ? 0 : (settings.commentsLimit || 1000);

    // Phase 2: fetch via InnerTube
    const comments = await YouTubeCommentsAPI.fetchAllComments(videoId, {
      progressCallback: ({ fetched, phase }) => {
        parseState.progress.fetched = fetched;
        if (phase === 'fetching_replies') parseState.progress.phase = 'fetching_replies';
      },
      cancelToken, tabId, mode, maxComments, includeReplies
    });
    if (cancelToken.cancelled) return;

    // Phase 3: format to Markdown
    parseState.progress.phase = 'formatting';
    const langStore = await chrome.storage.sync.get(['language']);
    const lang = langStore.language || 'en';
    const parts = CommentsToMd.format(metadata, comments, { lang });
    if (cancelToken.cancelled) return;

    // Phase 4: send to NLM
    parseState.progress.phase = 'sending';
    console.log(`[YT-Comments] Phase 4: sending ${parts.length} part(s) to notebook ${notebookId}`);
    await NotebookLMAPI.getTokens(currentAuthuser);
    for (let i = 0; i < parts.length; i++) {
      if (cancelToken.cancelled) return;
      console.log(`[YT-Comments] Sending part ${i + 1}/${parts.length}: title="${parts[i].title}", text length=${parts[i].text.length}`);
      try {
        const resp = await NotebookLMAPI.addTextSource(notebookId, parts[i].text, parts[i].title);
        // Check for error markers in the RPC response
        if (resp && (resp.includes('"error"') || resp.includes('er\"'))) {
          console.warn(`[YT-Comments] Part ${i + 1} response may contain error:`, resp.substring(0, 300));
        } else {
          console.log(`[YT-Comments] Part ${i + 1} sent OK, response length=${resp?.length || 0}`);
        }
      } catch (partErr) {
        console.error(`[YT-Comments] Failed to send part ${i + 1}:`, partErr);
        throw partErr;
      }
    }

    parseState.progress.phase = 'done';
    parseState.result = {
      commentCount: comments.length,
      totalComments: metadata.commentCount,
      partCount: parts.length,
      videoTitle: metadata.title
    };
  } catch (e) {
    console.error('doParseComments error:', e);
    parseState.progress.phase = 'error';
    parseState.error = { code: e.code || 'UNKNOWN', message: e.message };
  } finally {
    parseState.active = false;
  }
}

// ─── State ───
let currentAuthuser = 0;

// ─── Queue management ───
async function getQueue() {
  const data = await chrome.storage.local.get(['queue']);
  return data.queue || [];
}

async function addToQueue(items) {
  const queue = await getQueue();
  const newItems = items.map(item => ({
    url: item.url || item,
    title: item.title || '',
    addedAt: Date.now()
  }));
  queue.push(...newItems);
  await chrome.storage.local.set({ queue });
  updateBadge(queue.length);
  return queue;
}

async function clearQueue() {
  await chrome.storage.local.set({ queue: [] });
  updateBadge(0);
}

async function processQueue(notebookId) {
  const queue = await getQueue();
  if (!queue.length) return { processed: 0 };

  const settings = await chrome.storage.local.get(['addDelay']);
  const delay = settings.addDelay || 2000;

  let processed = 0;
  let errors = 0;

  for (const item of queue) {
    try {
      await NotebookLMAPI.addSource(notebookId, item.url);
      processed++;
      await addHistory({ action: 'add_source', url: item.url, title: item.title, notebookId });
    } catch (e) {
      errors++;
      await addHistory({ action: 'error', url: item.url, error: e.message, notebookId });
    }
    if (queue.indexOf(item) < queue.length - 1) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  await clearQueue();
  return { processed, errors };
}

// ─── History ───
async function addHistory(entry) {
  const data = await chrome.storage.local.get(['history']);
  const history = data.history || [];
  history.unshift({ ...entry, timestamp: Date.now() });
  if (history.length > 500) history.length = 500;
  await chrome.storage.local.set({ history });
}

async function getHistory() {
  const data = await chrome.storage.local.get(['history']);
  return data.history || [];
}

async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
}

// ─── Badge ───
function updateBadge(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#4285f4' });
}

// ─── Drive sync orchestrator ───
async function syncDriveSources(notebookId) {
  const nb = await NotebookLMAPI.getNotebook(notebookId);
  const driveSources = nb.sources.filter(s => s.canSync);
  if (!driveSources.length) return { success: true, results: { total: 0 } };

  const results = { total: driveSources.length, fresh: 0, synced: 0, skipped: 0, errors: 0 };
  for (const source of driveSources) {
    try {
      const isFresh = await NotebookLMAPI.checkSourceFreshness(source.id, notebookId);
      if (isFresh === null) results.skipped++;
      else if (isFresh) results.fresh++;
      else {
        await NotebookLMAPI.syncDriveSource(source.id, notebookId);
        results.synced++;
      }
    } catch (e) {
      results.errors++;
    }
  }
  return { success: true, results };
}

// ─── Extract YouTube URLs from tab ───
async function extractYouTubeUrls(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const links = new Set();
      document.querySelectorAll('a[href*="/watch?v="], a[href*="youtu.be/"]').forEach(a => {
        try {
          const u = new URL(a.href);
          if (u.hostname.includes('youtube.com') && u.searchParams.get('v')) {
            links.add(`https://www.youtube.com/watch?v=${u.searchParams.get('v')}`);
          } else if (u.hostname === 'youtu.be') {
            links.add(`https://www.youtube.com/watch?v=${u.pathname.slice(1)}`);
          }
        } catch (e) {}
      });
      return [...links];
    }
  });
  return results[0]?.result || [];
}

// ─── Extract all links from tab ───
async function extractAllLinks(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const links = [];
      document.querySelectorAll('a[href]').forEach(a => {
        try {
          const u = new URL(a.href);
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            links.push({ url: a.href, title: a.textContent.trim().substring(0, 100) || a.href });
          }
        } catch (e) {}
      });
      return [...new Map(links.map(l => [l.url, l])).values()];
    }
  });
  return results[0]?.result || [];
}

// ─── Extract open tabs ───
async function getOpenTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')))
    .map(t => ({ url: t.url, title: t.title || t.url, favIconUrl: t.favIconUrl || '', tabId: t.id }));
}

// ─── RSS/Sitemap detection ───
async function detectRssFeed(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const feeds = [];
      document.querySelectorAll('link[type="application/rss+xml"], link[type="application/atom+xml"]').forEach(l => {
        feeds.push({ url: l.href, title: l.title || 'RSS Feed', type: l.type });
      });
      return feeds;
    }
  });
  return results[0]?.result || [];
}

// ─── Context menu ───
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'add-to-nlm',
    title: chrome.i18n.getMessage('contextMenuAdd') || 'Add to NotebookLM',
    contexts: ['page', 'link']
  });
  chrome.contextMenus.create({
    id: 'add-as-pdf',
    title: chrome.i18n.getMessage('contextMenuPdf') || 'Save as PDF to NotebookLM',
    contexts: ['page']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.pageUrl;
  if (info.menuItemId === 'add-to-nlm') {
    await addToQueue([{ url, title: tab?.title || '' }]);
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'NotebookLM Assistant', message: `Added to queue: ${url}` });
  } else if (info.menuItemId === 'add-as-pdf') {
    await chrome.storage.local.set({ pendingPdf: { tabId: tab.id, title: tab.title, url: tab.url } });
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'NotebookLM Assistant', message: 'Open popup to select notebook and save PDF' });
  }
});

// ─── Keyboard shortcuts ───
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === 'add-current-page') {
    await addToQueue([{ url: tab.url, title: tab.title }]);
  } else if (command === 'add-as-pdf') {
    await chrome.storage.local.set({ pendingPdf: { tabId: tab.id, title: tab.title, url: tab.url } });
  }
});

// ─── Message handler ───
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender).then(sendResponse).catch(e => sendResponse({ error: e.message }));
  return true;
});

async function handleMessage(request, sender) {
  const { cmd, params } = request;

  switch (cmd) {
    // ── Auth ──
    case 'list-accounts':
      return await NotebookLMAPI.listAccounts();

    case 'set-authuser':
      currentAuthuser = params.authuser;
      await NotebookLMAPI.getTokens(currentAuthuser);
      return { success: true };

    case 'get-tokens':
      await NotebookLMAPI.getTokens(params.authuser || currentAuthuser);
      return { success: true };

    // ── Notebooks ──
    case 'list-notebooks':
      await NotebookLMAPI.getTokens(currentAuthuser);
      return await NotebookLMAPI.listNotebooks();

    case 'create-notebook':
      await NotebookLMAPI.getTokens(currentAuthuser);
      return await NotebookLMAPI.createNotebook(params.title, params.emoji);

    // ── Sources ──
    case 'add-source': {
      await NotebookLMAPI.getTokens(currentAuthuser);
      const result = await NotebookLMAPI.addSource(params.notebookId, params.url);
      await addHistory({ action: 'add_source', url: params.url, notebookId: params.notebookId });
      return { success: true };
    }

    case 'add-sources': {
      await NotebookLMAPI.getTokens(currentAuthuser);
      await NotebookLMAPI.addSources(params.notebookId, params.urls);
      for (const u of params.urls) {
        await addHistory({ action: 'add_source', url: u, notebookId: params.notebookId });
      }
      return { success: true, count: params.urls.length };
    }

    case 'add-text-source': {
      await NotebookLMAPI.getTokens(currentAuthuser);
      await NotebookLMAPI.addTextSource(params.notebookId, params.text, params.title);
      await addHistory({ action: 'add_text', title: params.title, notebookId: params.notebookId });
      return { success: true };
    }

    case 'add-as-pdf': {
      await NotebookLMAPI.getTokens(currentAuthuser);
      const r = await addAsPdf(params.notebookId, params.tabId, params.title);
      await addHistory({ action: 'add_pdf', title: params.title, notebookId: params.notebookId });
      return r;
    }

    // ── Notebook details ──
    case 'get-notebook':
      await NotebookLMAPI.getTokens(currentAuthuser);
      return await NotebookLMAPI.getNotebook(params.notebookId);

    case 'get-sources':
      await NotebookLMAPI.getTokens(currentAuthuser);
      return await NotebookLMAPI.getNotebook(params.notebookId);

    // ── Delete ──
    case 'delete-source':
      await NotebookLMAPI.getTokens(currentAuthuser);
      await NotebookLMAPI.deleteSource(params.notebookId, params.sourceId);
      await addHistory({ action: 'delete_source', sourceId: params.sourceId, notebookId: params.notebookId });
      return { success: true };

    case 'delete-sources':
      await NotebookLMAPI.getTokens(currentAuthuser);
      const delResult = await NotebookLMAPI.deleteSources(params.notebookId, params.sourceIds);
      await addHistory({ action: 'delete_sources', count: params.sourceIds.length, notebookId: params.notebookId });
      return { success: true, ...delResult };

    // ── Drive sync ──
    case 'sync-drive-sources':
      await NotebookLMAPI.getTokens(currentAuthuser);
      return await syncDriveSources(params.notebookId);

    // ── YouTube comments ──
    case 'parse-comments':
      if (parseState.active) return { error: 'Parse already in progress' };
      await NotebookLMAPI.getTokens(currentAuthuser);
      doParseComments(params.notebookId, params.videoId, params.tabId);
      return { started: true };

    case 'get-parse-status':
      return {
        active: parseState.active,
        videoId: parseState.videoId,
        progress: parseState.progress,
        error: parseState.error,
        result: parseState.result
      };

    case 'cancel-parse':
      if (parseState.cancelToken) {
        parseState.cancelToken.cancelled = true;
        parseState.progress.phase = 'cancelled';
        parseState.active = false;
      }
      return { success: true };

    // ── Queue ──
    case 'get-queue':
      return await getQueue();

    case 'add-to-queue':
      return await addToQueue(params.items);

    case 'clear-queue':
      await clearQueue();
      return { success: true };

    case 'process-queue':
      await NotebookLMAPI.getTokens(currentAuthuser);
      return await processQueue(params.notebookId);

    // ── History ──
    case 'get-history':
      return await getHistory();

    case 'clear-history':
      await clearHistory();
      return { success: true };

    // ── Tab helpers ──
    case 'get-open-tabs':
      return await getOpenTabs();

    case 'extract-yt-urls':
      return await extractYouTubeUrls(params.tabId);

    case 'extract-links':
      return await extractAllLinks(params.tabId);

    case 'detect-rss':
      return await detectRssFeed(params.tabId);

    case 'get-current-tab': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab ? { url: tab.url, title: tab.title, id: tab.id, favIconUrl: tab.favIconUrl } : null;
    }

    case 'open-tab':
      await chrome.tabs.create({ url: params.url });
      return { success: true };

    default:
      return { error: `Unknown command: ${cmd}` };
  }
}

// ─── Init badge ───
getQueue().then(q => updateBadge(q.length));
