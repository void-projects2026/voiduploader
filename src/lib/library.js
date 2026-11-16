'use strict';

// "تحميلاتي": the real folder on disk where downloaded episodes live, one
// sub-folder per anime. Every destructive operation is guarded so it can
// only ever touch files inside this folder.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { configStore } = require('./stores');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm']);

function root() {
  const custom = configStore.get('downloadsDir', '');
  return custom || path.join(app.getPath('downloads'), 'Anime Upload');
}

function ensureRoot() {
  fs.mkdirSync(root(), { recursive: true });
  return root();
}

function real(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// True only if `p` is strictly inside the downloads root (symlinks resolved,
// so a link can't be used to escape it).
function isInside(p) {
  if (!p) return false;
  const base = real(root());
  const target = fs.existsSync(p) ? real(p) : path.resolve(p);
  const rel = path.relative(base, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function episodeOf(name) {
  const m = name.match(/\bEp (\d{1,4})\b/);
  return m ? Number(m[1]) : null;
}

function list() {
  const base = root();
  if (!fs.existsSync(base)) return { root: base, animes: [] };
  const animes = [];
  for (const dirent of fs.readdirSync(base, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(base, dirent.name);
    const episodes = [];
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const ext = path.extname(f.name).toLowerCase();
      const partial = ext === '.part';
      if (!partial && !VIDEO_EXT.has(ext)) continue;
      const full = path.join(dir, f.name);
      const st = fs.statSync(full);
      episodes.push({ name: f.name, path: full, size: st.size, mtime: st.mtimeMs, partial, episode: episodeOf(f.name) });
    }
    episodes.sort((a, b) => (a.episode ?? 1e9) - (b.episode ?? 1e9) || a.name.localeCompare(b.name));
    animes.push({
      name: dirent.name,
      path: dir,
      episodes,
      totalSize: episodes.reduce((s, e) => s + e.size, 0),
      mtime: Math.max(0, ...episodes.map((e) => e.mtime)),
    });
  }
  animes.sort((a, b) => b.mtime - a.mtime);
  return { root: base, animes };
}

// Removes the anime folder once nothing is left in it.
function cleanEmptyParent(file) {
  const dir = path.dirname(file);
  if (!isInside(dir)) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best effort */ }
}

function deleteFile(file) {
  if (!isInside(file)) return false;
  try {
    fs.rmSync(file, { force: true });
    fs.rmSync(file + '.part', { force: true });
  } catch {
    return false;
  }
  cleanEmptyParent(file);
  return true;
}

function deleteAnime(name) {
  const dir = path.join(root(), path.basename(name));
  if (!isInside(dir) || !fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = { root, ensureRoot, isInside, list, deleteFile, deleteAnime, episodeOf };
