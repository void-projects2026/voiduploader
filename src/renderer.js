let currentFolder = null;
let currentBatchId = null;
let queue = []; // { id, name, path, size, providers: { doodstream: {status, pct, url, error, speed}, earnvid: {...} } }
let idCounter = 0;

function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  const mb = bytesPerSec / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + ' MB/s';
  return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
}

const folderPathEl = document.getElementById('folderPath');
const tableWrap = document.getElementById('tableWrap');
const emptyState = document.getElementById('emptyState');
const startBtn = document.getElementById('startBtn');
const copyLinksBtn = document.getElementById('copyLinksBtn');
const summaryEl = document.getElementById('summary');

function fmtSize(bytes) {
  if (bytes > 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function activeProviders() {
  const list = [];
  if (document.getElementById('useDoodstream').checked) list.push('doodstream');
  if (document.getElementById('useEarnvid').checked) list.push('earnvid');
  return list;
}

function renderTable() {
  if (!queue.length) {
    tableWrap.innerHTML = '';
    tableWrap.appendChild(emptyState);
    return;
  }
  const providers = activeProviders().length ? activeProviders() : Object.keys(queue[0].providers);
  let html = '<table><thead><tr><th>File</th><th>Size</th>';
  for (const p of providers) html += `<th>${p}</th>`;
  html += '</tr></thead><tbody>';

  for (const item of queue) {
    html += `<tr><td>${item.name}</td><td>${fmtSize(item.size)}</td>`;
    for (const p of providers) {
      const st = item.providers[p];
      if (!st) { html += '<td>-</td>'; continue; }
      html += '<td><div class="status">';
      html += `<span class="badge ${st.status}">${st.status}</span>`;
      if (st.status === 'uploading') {
        const speedTxt = fmtSpeed(st.speed);
        html += `<div class="progress-bar" style="width:80px"><div class="progress-fill" style="width:${st.pct}%"></div></div><span>${st.pct}%${speedTxt ? ' · ' + speedTxt : ''}</span>`;
      } else if (st.status === 'done') {
        html += `<a class="link" href="#" data-copy="${st.url}">${st.url}</a> <button class="test-link-btn" data-test="${st.url}">Test</button><span class="link-test-result" data-testresult="${st.url}"></span>`;
      } else if (st.status === 'failed') {
        html += `<span class="error-text">${st.error || 'failed'}</span><button class="retry-btn" data-retry="${item.id}" data-provider="${p}">Retry</button>`;
      }
      html += '</div></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  tableWrap.innerHTML = html;

  tableWrap.querySelectorAll('[data-copy]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigator.clipboard.writeText(el.dataset.copy);
    });
  });
  tableWrap.querySelectorAll('[data-retry]').forEach((el) => {
    el.addEventListener('click', () => {
      const item = queue.find((q) => q.id == el.dataset.retry);
      uploadItemProvider(item, el.dataset.provider);
    });
  });
  tableWrap.querySelectorAll('[data-test]').forEach((el) => {
    el.addEventListener('click', async () => {
      const url = el.dataset.test;
      const resultEl = tableWrap.querySelector(`[data-testresult="${CSS.escape(url)}"]`);
      if (resultEl) resultEl.textContent = 'testing...';
      const res = await window.api.testLink(url);
      if (resultEl) {
        resultEl.textContent = res.success ? `OK (${res.status || 200})` : `FAIL (${res.error || res.status || 'unreachable'})`;
        resultEl.className = 'link-test-result ' + (res.success ? 'ok' : 'fail');
      }
    });
  });

  updateSummary();
}

function updateSummary() {
  const providers = activeProviders();
  let done = 0, total = 0, failed = 0;
  for (const item of queue) {
    for (const p of providers) {
      const st = item.providers[p];
      if (!st) continue;
      total++;
      if (st.status === 'done') done++;
      if (st.status === 'failed') failed++;
    }
  }
  summaryEl.textContent = total ? `${done}/${total} uploaded, ${failed} failed` : '';
  copyLinksBtn.disabled = done === 0;
}

document.getElementById('pickFolderBtn').addEventListener('click', async () => {
  const folder = await window.api.pickFolder();
  if (!folder) return;
  currentFolder = folder;
  folderPathEl.textContent = folder;
  folderPathEl.title = folder;

  const files = await window.api.scanFolder(folder);
  queue = files.map((f) => {
    const providers = {};
    for (const p of activeProviders()) providers[p] = { status: 'queued', pct: 0, url: '', error: '', speed: 0 };
    return { id: idCounter++, name: f.name, path: f.path, size: f.size, providers };
  });
  startBtn.disabled = queue.length === 0;

  const batch = await window.api.addHistoryBatch({ folderPath: folder });
  currentBatchId = batch && batch.id;

  renderTable();
});

['useDoodstream', 'useEarnvid'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    for (const item of queue) {
      for (const p of activeProviders()) {
        if (!item.providers[p]) item.providers[p] = { status: 'queued', pct: 0, url: '', error: '' };
      }
    }
    renderTable();
  });
});

async function uploadItemProvider(item, provider) {
  item.providers[provider] = { status: 'uploading', pct: 0, url: '', error: '', speed: 0 };
  renderTable();
  const res = await window.api.uploadFile({ provider, filePath: item.path, id: item.id });
  if (res.success) {
    item.providers[provider] = { status: 'done', pct: 100, url: res.embedUrl, error: '', speed: 0 };
    if (currentBatchId) {
      window.api.recordHistoryLink({
        batchId: currentBatchId,
        fileName: item.name,
        size: item.size,
        provider,
        url: res.embedUrl
      });
    }
  } else {
    item.providers[provider] = { status: 'failed', pct: 0, url: '', error: res.error, speed: 0 };
  }
  renderTable();
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  const providers = activeProviders();
  if (!providers.length) {
    alert('Select at least one provider (DoodStream or EarnVid).');
    startBtn.disabled = false;
    return;
  }
  // Sequential per file (to keep progress readable and avoid hammering the API),
  // but the two providers for a single file run in parallel.
  for (const item of queue) {
    await Promise.all(providers.map((p) => uploadItemProvider(item, p)));
  }
  startBtn.disabled = false;
});

copyLinksBtn.addEventListener('click', () => {
  const providers = activeProviders();
  const primary = providers[0];
  const lines = queue
    .filter((item) => item.providers[primary] && item.providers[primary].status === 'done')
    .map((item) => item.providers[primary].url);
  navigator.clipboard.writeText(lines.join('\n'));
});

window.api.onProgress(({ id, provider, pct, bytesPerSec }) => {
  const item = queue.find((q) => q.id === id);
  if (!item || !item.providers[provider]) return;
  item.providers[provider].pct = pct;
  item.providers[provider].speed = bytesPerSec || 0;
  renderTable();
});

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
const settingsModal = document.getElementById('settingsModal');
const doodKeyInput = document.getElementById('doodKeyInput');
const earnKeyInput = document.getElementById('earnKeyInput');

async function openSettings() {
  const cfg = await window.api.getConfig();
  doodKeyInput.value = cfg.doodstreamApiKey || '';
  earnKeyInput.value = cfg.earnvidApiKey || '';
  settingsModal.classList.add('open');
}

document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('closeSettingsBtn').addEventListener('click', () => settingsModal.classList.remove('open'));
document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  await window.api.setConfig({
    doodstreamApiKey: doodKeyInput.value.trim(),
    earnvidApiKey: earnKeyInput.value.trim()
  });
  settingsModal.classList.remove('open');
});

// First-run prompt: if no keys saved yet, open settings automatically.
(async () => {
  const cfg = await window.api.getConfig();
  if (!cfg.doodstreamApiKey && !cfg.earnvidApiKey) openSettings();
})();

// ---------------------------------------------------------------------------
// Test Connection (item 3)
// ---------------------------------------------------------------------------
const testDoodBtn = document.getElementById('testDoodBtn');
const testEarnBtn = document.getElementById('testEarnBtn');
const doodTestResult = document.getElementById('doodTestResult');
const earnTestResult = document.getElementById('earnTestResult');

async function testConnection(provider, keyInput, resultEl) {
  resultEl.textContent = 'Testing...';
  resultEl.className = 'test-result';
  const res = await window.api.testConnection({ provider, apiKey: keyInput.value.trim() });
  if (res.success) {
    const acct = res.account || {};
    resultEl.textContent = `Valid${acct.email ? ' — ' + acct.email : ''}${acct.balance ? ' — balance ' + acct.balance : ''}`;
    resultEl.className = 'test-result ok';
  } else {
    resultEl.textContent = 'Invalid: ' + (res.error || 'unknown error');
    resultEl.className = 'test-result fail';
  }
}

if (testDoodBtn) testDoodBtn.addEventListener('click', () => testConnection('doodstream', doodKeyInput, doodTestResult));
if (testEarnBtn) testEarnBtn.addEventListener('click', () => testConnection('earnvid', earnKeyInput, earnTestResult));

// ---------------------------------------------------------------------------
// Create Folder (item 6)
// ---------------------------------------------------------------------------
const newFolderBtn = document.getElementById('newFolderBtn');
if (newFolderBtn) {
  newFolderBtn.addEventListener('click', async () => {
    const name = prompt('New folder name (e.g. a series/work title):');
    if (!name) return;
    const res = await window.api.createFolder({ name });
    if (res.success) {
      alert(`Created: ${res.path}`);
      // Immediately switch to the newly-created folder so uploads can be
      // dropped in and then picked up via "Choose Folder".
      currentFolder = res.path;
      folderPathEl.textContent = res.path;
      folderPathEl.title = res.path;
    } else {
      alert('Could not create folder: ' + res.error);
    }
  });
}

// ---------------------------------------------------------------------------
// Upload History (item 5)
// ---------------------------------------------------------------------------
const historyModal = document.getElementById('historyModal');
const historyBtn = document.getElementById('historyBtn');
const closeHistoryBtn = document.getElementById('closeHistoryBtn');
const historyList = document.getElementById('historyList');

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

async function renderHistory() {
  const batches = await window.api.listHistory();
  if (!batches.length) {
    historyList.innerHTML = '<div class="empty-state">No upload history yet.</div>';
    return;
  }
  let html = '';
  for (const batch of batches) {
    html += `<div class="history-batch">`;
    html += `<div class="history-batch-header"><strong>${batch.folderName}</strong> <span class="muted">${fmtDate(batch.createdAt)}</span> <span class="muted">(${batch.files.length} file${batch.files.length === 1 ? '' : 's'})</span>`;
    html += ` <button class="secondary copy-batch-btn" data-batch="${batch.id}">Copy all links</button></div>`;
    if (batch.files.length) {
      html += '<ul class="history-files">';
      for (const f of batch.files) {
        const linkParts = Object.entries(f.links || {}).map(([p, u]) => `<a class="link" href="#" data-copy="${u}">${p}: ${u}</a>`).join('<br>');
        html += `<li>${f.name} — ${linkParts || '<span class="muted">no links</span>'}</li>`;
      }
      html += '</ul>';
    }
    html += '</div>';
  }
  historyList.innerHTML = html;

  historyList.querySelectorAll('[data-copy]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigator.clipboard.writeText(el.dataset.copy);
    });
  });
  historyList.querySelectorAll('.copy-batch-btn').forEach((el) => {
    el.addEventListener('click', async () => {
      const batches = await window.api.listHistory();
      const batch = batches.find((b) => b.id === el.dataset.batch);
      if (!batch) return;
      const lines = [];
      for (const f of batch.files) {
        for (const url of Object.values(f.links || {})) lines.push(url);
      }
      navigator.clipboard.writeText(lines.join('\n'));
    });
  });
}

if (historyBtn) {
  historyBtn.addEventListener('click', async () => {
    await renderHistory();
    historyModal.classList.add('open');
  });
}
if (closeHistoryBtn) closeHistoryBtn.addEventListener('click', () => historyModal.classList.remove('open'));
