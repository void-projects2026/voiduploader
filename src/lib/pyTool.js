'use strict';

// Runs the ani-cli-arabic Python tool for us: finds/installs Python, fetches
// the tool + its requirements, and talks to src/python/bridge.py over
// JSON-lines on stdin/stdout. Everything lives under <userData>/pytool, so
// admins never have to touch a terminal.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const axios = require('axios');
const { configStore } = require('./stores');

const TOOL_ZIP = 'https://github.com/np4abdou1/ani-cli-arabic/archive/refs/heads/main.zip';
const PY_EMBED = 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip';
const PY_EMBED_PTH = 'python312._pth';
const GET_PIP = 'https://bootstrap.pypa.io/get-pip.py';
const IS_WIN = process.platform === 'win32';

const dirs = () => {
  const base = path.join(app.getPath('userData'), 'pytool');
  return {
    base,
    embed: path.join(base, 'python'),
    venv: path.join(base, 'venv'),
    tool: path.join(base, 'ani-cli-arabic'),
    bridge: path.join(base, 'bridge.py'),
  };
};

const venvPython = (d) => (IS_WIN ? path.join(d.venv, 'Scripts', 'python.exe') : path.join(d.venv, 'bin', 'python'));
const embedPython = (d) => path.join(d.embed, 'python.exe');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 60000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Streams a long-running command's output line by line (pip install).
function runStreaming(cmd, args, onLine, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let tail = '';
    const feed = (chunk) => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-4000);
      text.split(/\r?\n/).filter(Boolean).forEach((l) => onLine && onLine(l));
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', (e) => resolve({ code: 1, tail: String(e.message) }));
    p.on('close', (code) => resolve({ code, tail }));
  });
}

async function pythonOk(cmd, args) {
  const r = await run(cmd, [...args, '-c', 'import sys;print(sys.version_info[0],sys.version_info[1])'], { timeout: 15000 });
  if (r.code !== 0) return false;
  const m = r.stdout.trim().match(/^(\d+) (\d+)$/);
  return !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 9));
}

async function findSystemPython() {
  const custom = configStore.get('pythonPath', '');
  const candidates = [];
  if (custom) candidates.push({ cmd: custom, args: [] });
  if (IS_WIN) candidates.push({ cmd: 'py', args: ['-3'] });
  candidates.push({ cmd: 'python', args: [] }, { cmd: 'python3', args: [] });
  for (const c of candidates) {
    if (await pythonOk(c.cmd, c.args)) return c;
  }
  return null;
}

async function download(url, dest, onPct) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await axios.get(url, { responseType: 'stream', timeout: 30000, maxRedirects: 5 });
  const total = Number(res.headers['content-length']) || 0;
  let done = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.data.on('data', (c) => {
      done += c.length;
      if (total && onPct) onPct(Math.round((done / total) * 100));
    });
    res.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.data.pipe(out);
  });
}

// Windows 10+ ships bsdtar, which extracts .zip - no extra dependency needed.
async function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = await run('tar', ['-xf', zipPath, '-C', destDir], { timeout: 300000 });
  if (r.code !== 0) throw new Error('فشل فك الضغط: ' + (r.stderr || '').slice(-200));
}

function toolDirCandidates() {
  const custom = configStore.get('toolDir', '');
  return { custom, managed: dirs().tool };
}

function isToolDir(p) {
  return !!p && fs.existsSync(path.join(p, 'src', 'providers')) && fs.existsSync(path.join(p, 'requirements.txt'));
}

function resolveToolDir() {
  const { custom, managed } = toolDirCandidates();
  if (custom && isToolDir(custom)) return { dir: custom, managed: false };
  if (isToolDir(managed)) return { dir: managed, managed: true };
  return { dir: null, managed: !custom };
}

function resolvePython() {
  const d = dirs();
  if (fs.existsSync(venvPython(d))) return venvPython(d);
  if (IS_WIN && fs.existsSync(embedPython(d))) return embedPython(d);
  return null;
}

function reqHash(toolDir) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(toolDir, 'requirements.txt'))).digest('hex');
  } catch {
    return '';
  }
}

function status() {
  const py = resolvePython();
  const { dir, managed } = resolveToolDir();
  const depsOk = !!(py && dir && configStore.get('depsHash', '') === `${py}|${reqHash(dir)}`);
  return { pythonReady: !!py, toolReady: !!dir, toolDir: dir, toolManaged: managed, depsReady: depsOk, ready: !!(py && dir && depsOk) };
}

async function fetchTool(emit, force) {
  const d = dirs();
  emit({ step: 'tool', message: force ? 'جارِ تحديث أداة التحميل...' : 'جارِ تنزيل أداة التحميل...', pct: 0 });
  const zip = path.join(d.base, '_tool.zip');
  const tmp = path.join(d.base, '_tool_tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  await download(TOOL_ZIP, zip, (pct) => emit({ step: 'tool', message: 'جارِ تنزيل أداة التحميل...', pct }));
  await unzip(zip, tmp);
  const inner = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => isToolDir(p));
  if (!inner) throw new Error('محتوى أداة التحميل غير متوقع');
  if (force) await stopBridge();
  fs.rmSync(d.tool, { recursive: true, force: true });
  fs.renameSync(inner, d.tool);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
}

async function ensurePython(emit) {
  const d = dirs();
  if (resolvePython()) return resolvePython();

  const sys = await findSystemPython();
  if (sys) {
    emit({ step: 'python', message: 'جارِ إنشاء بيئة بايثون معزولة...' });
    const r = await run(sys.cmd, [...sys.args, '-m', 'venv', d.venv], { timeout: 180000 });
    if (r.code === 0 && fs.existsSync(venvPython(d))) return venvPython(d);
    fs.rmSync(d.venv, { recursive: true, force: true });
    if (!IS_WIN) throw new Error('فشل إنشاء venv: ' + r.stderr.slice(-200));
  }
  if (!IS_WIN) throw new Error('ثبّت Python 3.9 أو أحدث أولاً');

  // No usable Python on this PC: fetch the official embeddable build.
  emit({ step: 'python', message: 'بايثون غير مثبّت - جارِ تنزيل نسخة مدمجة...', pct: 0 });
  const zip = path.join(d.base, '_py.zip');
  await download(PY_EMBED, zip, (pct) => emit({ step: 'python', message: 'جارِ تنزيل بايثون...', pct }));
  fs.rmSync(d.embed, { recursive: true, force: true });
  await unzip(zip, d.embed);
  fs.rmSync(zip, { force: true });
  const pth = path.join(d.embed, PY_EMBED_PTH);
  if (fs.existsSync(pth)) fs.writeFileSync(pth, fs.readFileSync(pth, 'utf8').replace(/^#\s*import site/m, 'import site'));
  emit({ step: 'python', message: 'جارِ تثبيت pip...' });
  const gp = path.join(d.base, 'get-pip.py');
  await download(GET_PIP, gp);
  const r = await runStreaming(embedPython(d), [gp, '--no-warn-script-location'], (l) => emit({ step: 'python', message: l.slice(0, 120) }));
  fs.rmSync(gp, { force: true });
  if (r.code !== 0) throw new Error('فشل تثبيت pip: ' + r.tail.slice(-200));
  return embedPython(d);
}

let setupRunning = null;

// Idempotent: each step is skipped if already satisfied. `forceTool` re-fetches
// the tool (providers break whenever the sites change, so updating matters).
function setup(emit = () => {}, { forceTool = false } = {}) {
  if (setupRunning) return setupRunning;
  setupRunning = (async () => {
    try {
      const d = dirs();
      fs.mkdirSync(d.base, { recursive: true });
      const py = await ensurePython(emit);

      let { dir, managed } = resolveToolDir();
      if (!dir || (forceTool && managed)) {
        await fetchTool(emit, !!dir);
        dir = d.tool;
      }

      const wanted = `${py}|${reqHash(dir)}`;
      if (configStore.get('depsHash', '') !== wanted) {
        emit({ step: 'deps', message: 'جارِ تثبيت المتطلبات (قد يستغرق دقيقة)...' });
        await stopBridge();
        const r = await runStreaming(
          py,
          ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location', '-r', path.join(dir, 'requirements.txt')],
          (l) => emit({ step: 'deps', message: l.slice(0, 120) })
        );
        if (r.code !== 0) throw new Error('فشل تثبيت المتطلبات: ' + r.tail.slice(-300));
        configStore.set('depsHash', wanted);
      }

      emit({ step: 'verify', message: 'جارِ الفحص النهائي...' });
      const info = await request('ping', {}).promise;
      emit({ step: 'done', message: 'الأداة جاهزة', info });
      return { success: true, info };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    } finally {
      setupRunning = null;
    }
  })();
  return setupRunning;
}

// ---------------------------------------------------------------------------
// Bridge process
// ---------------------------------------------------------------------------
let proc = null;
let ready = null;
let nextId = 1;
const pending = new Map();
let stderrTail = '';

function failAll(message) {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function startBridge() {
  if (ready) return ready;
  const py = resolvePython();
  const { dir } = resolveToolDir();
  if (!py || !dir) return Promise.reject(new Error('أداة التحميل غير مجهّزة بعد'));
  ready = new Promise((resolve, reject) => {
    const d = dirs();
    fs.mkdirSync(d.base, { recursive: true });
    fs.writeFileSync(d.bridge, fs.readFileSync(path.join(__dirname, '..', 'python', 'bridge.py')));

    proc = spawn(py, ['-u', d.bridge, '--tool-dir', dir], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let buf = '';
    let settled = false;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'ready') { settled = true; resolve(); continue; }
        if (msg.type === 'fatal') { settled = true; ready = null; reject(new Error(msg.error)); continue; }
        const p = pending.get(msg.id);
        if (!p) continue;
        if (msg.type === 'result') { pending.delete(msg.id); p.resolve(msg.data); }
        else if (msg.type === 'done') { pending.delete(msg.id); p.onEvent && p.onEvent(msg); p.resolve(msg); }
        else if (msg.type === 'error') { pending.delete(msg.id); p.reject(new Error(msg.error)); }
        else if (p.onEvent) p.onEvent(msg);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => { stderrTail = (stderrTail + c).slice(-2000); });
    proc.on('error', (e) => { if (!settled) { settled = true; ready = null; reject(e); } });
    proc.on('close', () => {
      const wasSettled = settled;
      proc = null;
      ready = null;
      failAll('توقفت أداة التحميل بشكل مفاجئ');
      if (!wasSettled) reject(new Error('فشل تشغيل أداة التحميل: ' + stderrTail.slice(-300)));
    });
  });
  return ready;
}

// Returns { id, promise } - the id is needed up front so a running download
// can be cancelled while its promise is still pending.
function request(cmd, payload, onEvent) {
  const id = nextId++;
  const promise = startBridge().then(
    () =>
      new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onEvent });
        proc.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n');
      })
  );
  return { id, promise };
}

function stopBridge() {
  return new Promise((resolve) => {
    if (!proc) return resolve();
    const p = proc;
    p.once('close', () => resolve());
    try { p.kill(); } catch { resolve(); }
    setTimeout(resolve, 2000);
  });
}

module.exports = { status, setup, request, stopBridge, resolveToolDir };
