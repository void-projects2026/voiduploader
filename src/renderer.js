let currentFolder = null;
let queue = []; // { id, name, path, size, providers: { doodstream: {status, pct, url, error}, earnvid: {...} } }
let idCounter = 0;

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
        html += `<div class="progress-bar" style="width:80px"><div class="progress-fill" style="width:${st.pct}%"></div></div><span>${st.pct}%</span>`;
      } else if (st.status === 'done') {
        html += `<a class="link" href="#" data-copy="${st.url}">${st.url}</a>`;
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
    for (const p of activeProviders()) providers[p] = { status: 'queued', pct: 0, url: '', error: '' };
    return { id: idCounter++, name: f.name, path: f.path, size: f.size, providers };
  });
  startBtn.disabled = queue.length === 0;
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
  item.providers[provider] = { status: 'uploading', pct: 0, url: '', error: '' };
  renderTable();
  const res = await window.api.uploadFile({ provider, filePath: item.path, id: item.id });
  if (res.success) {
    item.providers[provider] = { status: 'done', pct: 100, url: res.embedUrl, error: '' };
  } else {
    item.providers[provider] = { status: 'failed', pct: 0, url: '', error: res.error };
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

window.api.onProgress(({ id, provider, pct }) => {
  const item = queue.find((q) => q.id === id);
  if (!item || !item.providers[provider]) return;
  item.providers[provider].pct = pct;
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
