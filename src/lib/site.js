'use strict';

// All HTTP calls to despair-world.com itself: Supabase email/password auth
// (same flow the website's own React app uses - supabase.auth.signInWithPassword)
// plus the admin/subadmin-or-uploader-key-gated REST endpoints documented in
// docs/API.md of the main site repo. We talk to these with a plain Supabase
// session bearer token (obtained at login below), never with an uploader key,
// since the owner asked for an email+password login screen specifically.

const SUPABASE_URL = 'https://despair-world.com/supabase-api';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzkwMzczMDE4LCJleHAiOjE5NDgwNTMwMTh9.xYgAlC_9SuUCdzdff6wBYGWzYFmAI9apP_mk4DCPaVI';
const SITE_URL = 'https://despair-world.com';

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body, leave data null
  }
  return { ok: res.ok, status: res.status, data, raw: text };
}

async function login(email, password) {
  const { ok, data } = await jsonFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  if (!ok || !data?.access_token) {
    return { success: false, error: data?.error_description || data?.msg || 'بيانات الدخول غير صحيحة' };
  }
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const userId = data.user?.id;

  const profileRes = await jsonFetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=username,is_admin,is_subadmin,avatar_url`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` } }
  );
  const profile = Array.isArray(profileRes.data) ? profileRes.data[0] : null;
  if (!profile || !(profile.is_admin || profile.is_subadmin)) {
    return { success: false, error: 'هذا الحساب غير أدمن أو مساعد أدمن' };
  }
  return {
    success: true,
    session: { accessToken, refreshToken, userId },
    profile: { username: profile.username, isAdmin: !!profile.is_admin, isSubadmin: !!profile.is_subadmin, avatarUrl: profile.avatar_url },
  };
}

async function refreshSession(refreshToken) {
  const { ok, data } = await jsonFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!ok || !data?.access_token) return { success: false };
  return { success: true, accessToken: data.access_token, refreshToken: data.refresh_token, userId: data.user?.id };
}

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
}

async function searchAnimeWorks(accessToken, q) {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  const { ok, data } = await jsonFetch(`${SITE_URL}/api/cache/uploader/anime/works${qs}`, {
    headers: authHeaders(accessToken),
  });
  if (!ok) return { success: false, error: data?.error || 'فشل البحث عن الأعمال' };
  return { success: true, works: data?.works || data?.items || data || [] };
}

async function anilistSearch(accessToken, q) {
  const { ok, data } = await jsonFetch(`${SITE_URL}/api/cache/uploader/anime/anilist-search?q=${encodeURIComponent(q)}`, {
    headers: authHeaders(accessToken),
  });
  if (!ok) return { success: false, error: data?.error || 'فشل البحث في AniList' };
  return { success: true, results: data?.results || data?.items || data || [] };
}

// Matches the website admin panel's own "إنشاء عمل من AniList" preview step
// (src/lib/animeHostUpload.ts: translateAnilistPreview) - called right after
// a search result is picked, before the admin confirms creation, so the
// Arabic synopsis/genres/tags shown for review are real translations, not
// placeholders.
async function anilistTranslatePreview(accessToken, { descriptionEn, genres, tags }) {
  const { ok, data } = await jsonFetch(`${SITE_URL}/api/cache/uploader/anime/anilist-translate-preview`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ descriptionEn, genres, tags }),
  });
  if (!ok) return { success: false, error: data?.error || 'فشلت الترجمة' };
  return { success: true, synopsisAr: data?.synopsisAr || '', genresAr: data?.genresAr || [], tagsAr: data?.tagsAr || [] };
}

async function anilistCreate(accessToken, payload) {
  const { ok, data } = await jsonFetch(`${SITE_URL}/api/cache/uploader/anime/anilist-create`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(payload),
  });
  if (!ok) return { success: false, error: data?.error || 'فشل إنشاء العمل' };
  return { success: true, id: data?.id, episodesCreated: data?.episodesCreated };
}

async function listEpisodes(accessToken, animeId) {
  const { ok, data } = await jsonFetch(`${SITE_URL}/api/cache/uploader/anime/works/${encodeURIComponent(animeId)}/episodes`, {
    headers: authHeaders(accessToken),
  });
  if (!ok) return { success: false, error: data?.error || 'فشل جلب الحلقات' };
  return { success: true, episodes: data?.episodes || data?.items || data || [] };
}

async function createEpisode(accessToken, { animeId, episodeNumber, title, teamId, isFree }) {
  const { ok, data } = await jsonFetch(`${SITE_URL}/api/cache/uploader/anime/episode`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ anime_id: animeId, episode_number: episodeNumber, title, team_id: teamId, is_free: isFree }),
  });
  if (!ok) return { success: false, error: data?.error || 'فشل إنشاء الحلقة' };
  return { success: true, episode: data?.episode || data };
}

async function listHostJobs(accessToken, episodeId) {
  const { ok, data } = await jsonFetch(
    `${SITE_URL}/api/cache/admin/anime/host-upload/jobs?episode_id=${encodeURIComponent(episodeId)}`,
    { headers: authHeaders(accessToken) }
  );
  if (!ok) return { success: false, error: data?.error || 'فشل جلب مهام الرفع' };
  return { success: true, jobs: data?.jobs || data?.items || data || [] };
}

// Owner decision 2026-11-15: the app never asks the admin to paste in host
// API keys - it gets a fresh, short-lived upload URL + the real key straight
// from the server (same endpoint the website's own browser-based admin
// panel uses for its direct-from-device uploads), every time, right before
// each upload starts. Keys live only in server/anime-hosts.mjs env vars.
async function getDirectUploadConfig(accessToken, host) {
  const { ok, data } = await jsonFetch(
    `${SITE_URL}/api/cache/admin/anime/host-upload/direct-init?host=${encodeURIComponent(host)}`,
    { headers: authHeaders(accessToken) }
  );
  if (!ok || !data?.uploadUrl) return { success: false, error: data?.error || `تعذر الحصول على رابط رفع ${host}` };
  return { success: true, uploadUrl: data.uploadUrl, fieldName: data.fieldName, apiKey: data.apiKey };
}

async function directProgress(accessToken, { episodeId, animeId, slot, host, progress }) {
  return jsonFetch(`${SITE_URL}/api/cache/admin/anime/host-upload/direct-progress`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ episodeId, animeId, slot, host, progress }),
  });
}

async function directFinalize(accessToken, { episodeId, animeId, slot, host, fileCode }) {
  const { ok, data } = await jsonFetch(`${SITE_URL}/api/cache/admin/anime/host-upload/direct-finalize`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ episodeId, animeId, slot, host, fileCode }),
  });
  if (!ok) return { success: false, error: data?.error || 'فشل حفظ رابط الرفع في الموقع' };
  return { success: true, embedUrl: data?.embedUrl || data?.embed_url };
}

// Direct PostgREST reads (same anon-key + session-token pattern login() already
// uses for `profiles`). Only the few columns needed to know which hosts an
// episode already has, so this stays light compared to /api/cache/media-tables.
const restHeaders = (accessToken) => ({ apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` });

async function restAll(accessToken, pathAndQuery) {
  const rows = [];
  for (let offset = 0; offset < 50000; offset += 1000) {
    const { ok, data } = await jsonFetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}&limit=1000&offset=${offset}`, { headers: restHeaders(accessToken) });
    if (!ok || !Array.isArray(data)) return null;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

const hasUrl = (v) => typeof v === 'string' && v.trim() !== '';
// Host columns written by direct-finalize (server PIPELINE_HOST_FIELD).
function hostsOfRow(r) {
  return { earnvid: hasUrl(r.earnvid_url), doodstream: hasUrl(r.doodstream_url), voe: hasUrl(r.embed_url_4) };
}

// Every anime work + per-episode host presence, for the schedule tab.
async function listWorksWithHosts(accessToken) {
  const works = await restAll(accessToken, 'anime_works?select=id,title_ar,title_en,cover_url,anilist_id,episodes_count&order=updated_at.desc');
  const eps = await restAll(accessToken, 'anime_episodes?select=anime_id,episode_number,earnvid_url,doodstream_url,embed_url_4&order=anime_id.asc');
  if (!works || !eps) return { success: false, error: 'فشل جلب الأعمال من الموقع' };
  const byWork = new Map();
  for (const e of eps) {
    if (!byWork.has(e.anime_id)) byWork.set(e.anime_id, new Map());
    byWork.get(e.anime_id).set(Number(e.episode_number), hostsOfRow(e));
  }
  return {
    success: true,
    works: works.map((w) => {
      const present = byWork.get(w.id) || new Map();
      const total = Math.max(Number(w.episodes_count) || 0, ...present.keys(), 0);
      const missing = [];
      for (let n = 1; n <= total; n += 1) {
        const h = present.get(n);
        const lacking = ['earnvid', 'doodstream', 'voe'].filter((k) => !(h && h[k]));
        if (lacking.length) missing.push({ n, lacking });
      }
      return { id: w.id, title: w.title_ar || w.title_en || w.id, titleEn: w.title_en || '', coverUrl: w.cover_url, anilistId: w.anilist_id, total, missing };
    }),
  };
}

// Host presence for one work's episodes: { [episodeNumber]: {earnvid,doodstream,voe} }.
async function episodeHosts(accessToken, animeId) {
  const rows = await restAll(accessToken, `anime_episodes?anime_id=eq.${encodeURIComponent(animeId)}&select=episode_number,earnvid_url,doodstream_url,embed_url_4`);
  if (!rows) return { success: false, error: 'فشل جلب حالة الحلقات' };
  const out = {};
  for (const r of rows) out[Number(r.episode_number)] = hostsOfRow(r);
  return { success: true, hosts: out };
}

module.exports = {
  listWorksWithHosts,
  episodeHosts,
  login,
  refreshSession,
  searchAnimeWorks,
  anilistSearch,
  anilistTranslatePreview,
  anilistCreate,
  listEpisodes,
  createEpisode,
  listHostJobs,
  getDirectUploadConfig,
  directProgress,
  directFinalize,
};
