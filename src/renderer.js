const HOST_LABEL = { earnvid: 'EarnVid', doodstream: 'Doodstream', voe: 'Voe' };

let selectedWork = null; // { id, title }
let anilistResultsCache = [];
let bulkFiles = [];

const $ = (id) => document.getElementById(id);

function showApp() {
  $('login-screen').style.display = 'none';
  $('app').classList.add('visible');
}

function showLogin() {
  $('login-screen').style.display = 'flex';
  $('app').classList.remove('visible');
}

async function boot() {
  const session = await window.api.getSession();
  if (session.loggedIn) {
    $('who-label').textContent = `${session.profile.username || ''} (${session.profile.isAdmin ? 'أدمن' : 'مساعد أدمن'})`;
    showApp();
    refreshOps();
    loadConfigIntoSettings();
  } else {
    showLogin();
  }
}

$('login-btn').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  $('error-msg').textContent = '';
  $('login-btn').disabled = true;
  const result = await window.api.login(email, password);
  $('login-btn').disabled = false;
  if (!result.success) {
    $('error-msg').textContent = result.error || 'فشل تسجيل الدخول';
    return;
  }
  $('who-label').textContent = `${result.profile.username || ''} (${result.profile.isAdmin ? 'أدمن' : 'مساعد أدمن'})`;
  showApp();
  refreshOps();
  loadConfigIntoSettings();
});

$('logout-btn').addEventListener('click', async () => {
  await window.api.logout();
  showLogin();
});

// ---------------------------------------------------------------------------
// Sidebar navigation
// ---------------------------------------------------------------------------
document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    item.classList.add('active');
    $(`panel-${item.dataset.panel}`).classList.add('active');
  });
});

// ---------------------------------------------------------------------------
// Anime tab
// ---------------------------------------------------------------------------
$('work-search-btn').addEventListener('click', async () => {
  const q = $('work-search').value.trim();
  const result = await window.api.searchAnimeWorks(q);
  const select = $('work-results');
  select.innerHTML = '';
  if (!result.success) return;
  (result.works || []).forEach((w) => {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = `${w.title_ar || w.title || w.title_en || w.id} (${w.id})`;
    opt.dataset.title = w.title_ar || w.title || w.title_en || '';
    select.appendChild(opt);
  });
});

$('work-results').addEventListener('change', () => {
  const select = $('work-results');
  const opt = select.selectedOptions[0];
  if (!opt) return;
  selectedWork = { id: opt.value, title: opt.dataset.title };
  $('selected-work-label').textContent = `${selectedWork.title} (${selectedWork.id})`;
});

$('anilist-search-btn').addEventListener('click', async () => {
  const q = $('anilist-search').value.trim();
  const result = await window.api.anilistSearch(q);
  const select = $('anilist-results');
  select.innerHTML = '';
  if (!result.success) return;
  anilistResultsCache = result.results || [];
  anilistResultsCache.forEach((r, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = `${r.title_ar || r.title || r.title_en} — ${r.episodesCount || r.episodes || '?'} حلقة`;
    select.appendChild(opt);
  });
});

$('anilist-create-btn').addEventListener('click', async () => {
  const select = $('anilist-results');
  const idx = select.value;
  if (idx === '') return;
  const chosen = anilistResultsCache[idx];
  const result = await window.api.anilistCreate(chosen);
  if (!result.success) {
    alert(result.error || 'فشل الإنشاء');
    return;
  }
  selectedWork = { id: result.work.id, title: result.work.title_ar || result.work.title };
  $('selected-work-label').textContent = `${selectedWork.title} (${selectedWork.id})`;
  alert('تم إنشاء العمل بنجاح');
});

// ---------------------------------------------------------------------------
// Upload tab - single episode
// ---------------------------------------------------------------------------
let singleFilePath = null;

$('single-pick-btn').addEventListener('click', async () => {
  const filePath = await window.api.pickFile();
  if (!filePath) return;
  singleFilePath = filePath;
  $('single-file-label').textContent = filePath.split(/[\\/]/).pop();
});

function getSelectedHosts() {
  return Array.from(document.querySelectorAll('#host-checklist input:checked')).map((i) => i.value);
}

$('single-upload-btn').addEventListener('click', async () => {
  if (!selectedWork) return alert('اختر عملاً أولاً من تاب الأنمي');
  const episodeNumber = Number($('single-ep-num').value);
  if (!episodeNumber) return alert('أدخل رقم الحلقة');
  if (!singleFilePath) return alert('اختر ملف الفيديو');
  const hosts = getSelectedHosts();
  if (!hosts.length) return alert('اختر استضافة واحدة على الأقل');

  const check = await window.api.checkEpisode({ animeId: selectedWork.id, episodeNumber });
  let effectiveHosts = hosts;
  if (check.success && check.exists) {
    const already = hosts.filter((h) => check.hostsPresent[h]);
    if (already.length) {
      const names = already.map((h) => HOST_LABEL[h]).join('، ');
      const ok = confirm(`الحلقة ${episodeNumber} موجودة بالفعل على: ${names}. استبدال؟`);
      if (!ok) effectiveHosts = hosts.filter((h) => !already.includes(h));
    }
  }
  if (!effectiveHosts.length) return;

  const result = await window.api.queueEpisodeUpload({
    animeId: selectedWork.id,
    animeTitle: selectedWork.title,
    episodeNumber,
    filePath: singleFilePath,
    hosts: effectiveHosts,
  });
  if (!result.success) return alert(result.error || 'فشل بدء الرفع');
  document.querySelector('.nav-item[data-panel="ops"]').click();
  refreshOps();
});

// ---------------------------------------------------------------------------
// Upload tab - bulk folder
// ---------------------------------------------------------------------------
$('bulk-pick-btn').addEventListener('click', async () => {
  const result = await window.api.pickAndScanFolder();
  if (!result) return;
  bulkFiles = result.files;
  renderBulkFileList();
});

function renderBulkFileList() {
  const from = Number($('bulk-from').value) || 1;
  const to = Number($('bulk-to').value) || 9999;
  const container = $('bulk-file-list');
  container.innerHTML = '';
  bulkFiles
    .filter((f) => f.guessedEpisode && f.guessedEpisode >= from && f.guessedEpisode <= to)
    .forEach((f) => {
      const div = document.createElement('div');
      div.textContent = `حلقة ${f.guessedEpisode}: ${f.name}`;
      container.appendChild(div);
    });
}

$('bulk-from').addEventListener('input', renderBulkFileList);
$('bulk-to').addEventListener('input', renderBulkFileList);

$('bulk-upload-btn').addEventListener('click', async () => {
  if (!selectedWork) return alert('اختر عملاً أولاً من تاب الأنمي');
  const from = Number($('bulk-from').value) || 1;
  const to = Number($('bulk-to').value) || 9999;
  const hosts = getSelectedHosts();
  if (!hosts.length) return alert('اختر استضافة واحدة على الأقل');
  const matched = bulkFiles.filter((f) => f.guessedEpisode && f.guessedEpisode >= from && f.guessedEpisode <= to);
  if (!matched.length) return alert('لا توجد ملفات مطابقة للنطاق');

  for (const file of matched) {
    const check = await window.api.checkEpisode({ animeId: selectedWork.id, episodeNumber: file.guessedEpisode });
    let effectiveHosts = hosts;
    if (check.success && check.exists) {
      const already = hosts.filter((h) => check.hostsPresent[h]);
      if (already.length) {
        const names = already.map((h) => HOST_LABEL[h]).join('، ');
        const ok = confirm(`الحلقة ${file.guessedEpisode} موجودة على: ${names}. استبدال؟ (إلغاء = تخطي هذه الاستضافات فقط)`);
        if (!ok) effectiveHosts = hosts.filter((h) => !already.includes(h));
      }
    }
    if (!effectiveHosts.length) continue;
    await window.api.queueEpisodeUpload({
      animeId: selectedWork.id,
      animeTitle: selectedWork.title,
      episodeNumber: file.guessedEpisode,
      filePath: file.path,
      hosts: effectiveHosts,
    });
  }
  document.querySelector('.nav-item[data-panel="ops"]').click();
  refreshOps();
});

// ---------------------------------------------------------------------------
// Operations tab
// ---------------------------------------------------------------------------
async function refreshOps() {
  const jobs = await window.api.listOps();
  renderOps(jobs);
}

function renderOps(jobs) {
  const tbody = $('ops-tbody');
  tbody.innerHTML = '';
  jobs.forEach((job) => {
    const tr = document.createElement('tr');
    const hostsHtml = job.hosts
      .map((h) => {
        const retryBtn = h.status === 'error' ? `<button data-job="${job.id}" data-host="${h.host}" class="retry-btn">إعادة</button>` : '';
        return `<div class="host-cell">
          <span class="name">${HOST_LABEL[h.host] || h.host}</span>
          <span class="badge ${h.status}">${h.status}</span>
          <span class="progress-bar"><div style="width:${h.progress || 0}%"></div></span>
          <span class="hint">${h.progress || 0}%</span>
          ${retryBtn}
          ${h.error ? `<span class="hint" title="${h.error}">⚠</span>` : ''}
        </div>`;
      })
      .join('');
    tr.innerHTML = `
      <td>${job.animeTitle || job.animeId}</td>
      <td>${job.episodeNumber}</td>
      <td>${job.fileName}</td>
      <td>${hostsHtml}</td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.retry-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await window.api.retryHost({ jobId: btn.dataset.job, host: btn.dataset.host });
      refreshOps();
    });
  });
}

window.api.onOpsUpdated((jobs) => renderOps(jobs));

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------
async function loadConfigIntoSettings() {
  const cfg = await window.api.getConfig();
  $('cfg-earnvid').value = cfg.earnvidApiKey || '';
  $('cfg-doodstream').value = cfg.doodstreamApiKey || '';
  $('cfg-voe').value = cfg.voeApiKey || '';
  $('cfg-concurrency').value = cfg.concurrency || 3;
}

$('cfg-save-btn').addEventListener('click', async () => {
  await window.api.setConfig({
    earnvidApiKey: $('cfg-earnvid').value.trim(),
    doodstreamApiKey: $('cfg-doodstream').value.trim(),
    voeApiKey: $('cfg-voe').value.trim(),
    concurrency: Number($('cfg-concurrency').value) || 3,
  });
  $('cfg-saved').textContent = 'تم الحفظ';
  setTimeout(() => ($('cfg-saved').textContent = ''), 2000);
});

boot();
