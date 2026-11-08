import { candidatesFromSearch, decide, normalizeTitle } from './lib.js';
import {
  authRateLimited,
  clearSessionCookie,
  createGuest,
  deleteSession,
  getIdentity,
  getSessionToken,
  loginUser,
  registerUser,
  sessionCookie,
  verifyTurnstile
} from './auth.js';

const MATCH_VERSION = 'v2';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_NAMES_PER_REQUEST = 5;
const KEY_RE = /^(local|bgm|custom):[A-Za-z0-9_-]{1,64}$/;

let lastBangumiAt = 0;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }, extraHeaders)
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || '';
}

async function readJson(request) {
  try { return await request.json(); } catch (err) { return null; }
}

/* ---------------- Bangumi 在线检索 ---------------- */

async function throttleBangumi() {
  const wait = Math.max(0, 250 - (Date.now() - lastBangumiAt));
  if (wait) await sleep(wait);
  lastBangumiAt = Date.now();
}

async function fetchBangumi(name, env) {
  const ua = (env && env.BGM_UA) || 'anime-memory/1.0';
  await throttleBangumi();
  const call = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      return await fetch('https://api.bgm.tv/v0/search/subjects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': ua
        },
        body: JSON.stringify({ keyword: name, filter: { type: [2] } }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await call();
  if (res.status === 429 || res.status >= 500) {
    await sleep(1500);
    res = await call();
  }
  if (!res.ok) throw new Error('bangumi_' + res.status);
  return res.json();
}

async function cacheGet(env, key) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT payload, fetched_at FROM match_cache WHERE q = ?'
    ).bind(key).first();
    if (row && row.payload && Date.now() - Number(row.fetched_at) < CACHE_TTL_MS) {
      return JSON.parse(row.payload);
    }
  } catch (err) { /* 缓存不可用 */ }
  return null;
}

async function cachePut(env, key, decision) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      'INSERT INTO match_cache (q, payload, fetched_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(q) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at'
    ).bind(key, JSON.stringify(decision), Date.now()).run();
  } catch (err) { /* 不影响本次请求 */ }
}

async function searchOne(name, env) {
  const q = MATCH_VERSION + ':' + normalizeTitle(name);
  if (!q) return { status: 'none' };
  const cached = await cacheGet(env, q);
  if (cached) return cached;
  const body = await fetchBangumi(name, env);
  const items = candidatesFromSearch(body);
  const decision = decide(name, items);
  await cachePut(env, q, decision);
  return decision;
}

async function handleMatch(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const body = await readJson(request);
  const raw = Array.isArray(body && body.names) ? body.names : [];
  const names = raw.map(cleanName).filter(Boolean);
  if (!names.length) return json({ error: 'no_names' }, 400);
  if (names.length > MAX_NAMES_PER_REQUEST) return json({ error: 'too_many_names' }, 400);

  const results = [];
  for (const name of names) {
    try {
      const decision = await searchOne(name, env);
      results.push(Object.assign({ query: name }, decision));
    } catch (err) {
      results.push({ query: name, status: 'error', message: String(err && err.message || 'search_failed') });
    }
  }
  return json({ results });
}

/* ---------------- 身份 / 会话 ---------------- */

const ERROR_STATUS = {
  bad_username: 400,
  bad_password: 400,
  username_taken: 409,
  invalid_credentials: 401,
  already_logged_in: 409,
  turnstile_failed: 400,
  rate_limited: 429,
  no_identity: 401,
  no_entries: 400
};

function failure(code) {
  return json({ error: code }, ERROR_STATUS[code] || 400);
}

async function handleAuth(request, env, url, path) {
  if (path === '/api/auth/me') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const identity = await getIdentity(request, env);
    if (!identity) return failure('no_identity');
    return json({ identity: identity });
  }

  if (path === '/api/auth/guest') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const existing = await getIdentity(request, env);
    if (existing) return json({ identity: existing });
    if (!env.DB) return json({ error: 'db_unavailable' }, 503);
    try {
      const guest = await createGuest(env);
      return json({ identity: guest.identity }, 200, { 'Set-Cookie': sessionCookie(guest.token, url) });
    } catch (err) {
      return json({ error: 'guest_failed' }, 503);
    }
  }

  if (path === '/api/auth/register' || path === '/api/auth/login') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!env.DB) return json({ error: 'db_unavailable' }, 503);
    const ip = clientIp(request);
    if (authRateLimited(ip)) return failure('rate_limited');
    const body = await readJson(request) || {};
    if (!(await verifyTurnstile(request, env, body.turnstileToken))) return failure('turnstile_failed');
    const current = await getIdentity(request, env);

    if (path === '/api/auth/register') {
      const result = await registerUser(env, {
        username: body.username,
        password: body.password,
        current: current,
        pepper: env.PASSWORD_PEPPER || '',
        iterations: env.PBKDF2_ITERATIONS
      });
      if (result.error) return failure(result.error);
      return json({ identity: result.identity }, 200, { 'Set-Cookie': sessionCookie(result.token, url) });
    }

    const result = await loginUser(env, {
      username: body.username,
      password: body.password,
      current: current,
      pepper: env.PASSWORD_PEPPER || ''
    });
    if (result.error) return failure(result.error);
    return json({ identity: result.identity }, 200, { 'Set-Cookie': sessionCookie(result.token, url) });
  }

  if (path === '/api/auth/logout') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    await deleteSession(env, getSessionToken(request));
    if (!env.DB) return json({ error: 'db_unavailable' }, 503);
    try {
      const guest = await createGuest(env);
      return json({ identity: guest.identity }, 200, { 'Set-Cookie': sessionCookie(guest.token, url) });
    } catch (err) {
      return json({ identity: null }, 200, { 'Set-Cookie': clearSessionCookie(url) });
    }
  }

  return json({ error: 'not_found' }, 404);
}

/* ---------------- 进度 ---------------- */

async function handleEntries(request, env, url) {
  if (!env.DB) return json({ error: 'db_unavailable' }, 503);
  const identity = await getIdentity(request, env);
  if (!identity) return failure('no_identity');

  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT key, title, subtitle, year, tags, source, added_at FROM entries ' +
      'WHERE identity_id = ? ORDER BY added_at ASC LIMIT 2000'
    ).bind(identity.id).all();
    const entries = (rows.results || []).map(row => ({
      key: row.key,
      title: row.title,
      subtitle: row.subtitle || '',
      year: row.year || null,
      tags: parseTags(row.tags),
      source: row.source,
      addedAt: Number(row.added_at)
    }));
    return json({ entries: entries });
  }

  if (request.method === 'POST') {
    const body = await readJson(request);
    if (!body) return json({ error: 'bad_json' }, 400);
    const key = typeof body.key === 'string' ? body.key : '';
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    const subtitle = typeof body.subtitle === 'string' ? body.subtitle.trim().slice(0, 120) : '';
    const source = ['local', 'bgm', 'custom'].includes(body.source) ? body.source : '';
    const tags = Array.isArray(body.tags)
      ? body.tags.filter(t => typeof t === 'string').map(t => t.trim().slice(0, 16)).filter(Boolean).slice(0, 4)
      : [];
    const year = Number.isInteger(body.year) && body.year >= 1900 && body.year <= 2100 ? body.year : null;
    if (!KEY_RE.test(key) || !title || !source) return json({ error: 'bad_entry' }, 400);

    await env.DB.prepare(
      'INSERT INTO entries (identity_id, key, title, subtitle, year, tags, source, added_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(identity_id, key) DO NOTHING'
    ).bind(identity.id, key, title, subtitle, year, JSON.stringify(tags), source, Date.now()).run();
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const key = url.searchParams.get('key') || '';
    if (key) {
      if (!KEY_RE.test(key)) return json({ error: 'bad_key' }, 400);
      await env.DB.prepare(
        'DELETE FROM entries WHERE identity_id = ? AND key = ?'
      ).bind(identity.id, key).run();
      return json({ ok: true });
    }
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM entries WHERE identity_id = ?').bind(identity.id),
      env.DB.prepare('UPDATE identities SET started_at = ? WHERE id = ?').bind(now, identity.id)
    ]);
    return json({ ok: true, startedAt: now });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

function parseTags(value) {
  try {
    const tags = JSON.parse(value || '[]');
    return Array.isArray(tags) ? tags.filter(t => typeof t === 'string').slice(0, 4) : [];
  } catch (err) {
    return [];
  }
}

/* ---------------- 历史结果 ---------------- */

async function handleRounds(request, env) {
  if (!env.DB) return json({ error: 'db_unavailable' }, 503);
  const identity = await getIdentity(request, env);
  if (!identity) return failure('no_identity');

  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT id, started_at, ended_at, count, titles FROM rounds ' +
      'WHERE identity_id = ? ORDER BY ended_at DESC LIMIT 20'
    ).bind(identity.id).all();
    const rounds = (rows.results || []).map(row => ({
      id: row.id,
      startedAt: Number(row.started_at),
      endedAt: Number(row.ended_at),
      count: Number(row.count),
      titles: parseTitles(row.titles)
    }));
    return json({ rounds: rounds });
  }

  if (request.method === 'POST') {
    const rows = await env.DB.prepare(
      'SELECT key, title, subtitle, year, tags, source FROM entries WHERE identity_id = ? ORDER BY added_at ASC'
    ).bind(identity.id).all();
    const entries = rows.results || [];
    if (!entries.length) return failure('no_entries');
    const titles = entries.map(row => row.title);
    const round = {
      id: crypto.randomUUID(),
      startedAt: identity.startedAt || Date.now(),
      endedAt: Date.now(),
      count: entries.length,
      titles: titles
    };
    await env.DB.prepare(
      'INSERT INTO rounds (id, identity_id, started_at, ended_at, count, titles) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(round.id, identity.id, round.startedAt, round.endedAt, round.count, JSON.stringify(titles)).run();
    try {
      await env.DB.prepare(
        'DELETE FROM rounds WHERE identity_id = ? AND id IN (' +
        'SELECT id FROM rounds WHERE identity_id = ? ORDER BY ended_at DESC LIMIT -1 OFFSET 100)'
      ).bind(identity.id, identity.id).run();
    } catch (err) { /* 清理失败不影响保存 */ }
    return json({ round: round });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

function parseTitles(value) {
  try {
    const titles = JSON.parse(value || '[]');
    return Array.isArray(titles) ? titles.filter(t => typeof t === 'string').slice(0, 500) : [];
  } catch (err) {
    return [];
  }
}

/* ---------------- 排行榜 / 统计 ---------------- */

async function handleLeaderboard(request, env, url) {
  if (!env.DB) return json({ rows: [], me: null });
  const scope = url.searchParams.get('scope') === 'users' ? 'users' : 'all';
  const scopeWhere = scope === 'users' ? "AND i.type = 'user'" : '';
  const rows = await env.DB.prepare(
    'SELECT i.id, i.display_name, i.type, i.created_at, COUNT(e.key) AS remembered, ' +
    'COALESCE((SELECT MAX(r.count) FROM rounds r WHERE r.identity_id = i.id), 0) AS best ' +
    'FROM entries e JOIN identities i ON i.id = e.identity_id ' +
    'WHERE 1 = 1 ' + scopeWhere + ' ' +
    'GROUP BY e.identity_id ORDER BY remembered DESC, i.created_at ASC LIMIT 20'
  ).all();

  const identity = await getIdentity(request, env);
  let me = null;
  if (identity) {
    const countRow = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM entries WHERE identity_id = ?'
    ).bind(identity.id).first();
    const count = Number(countRow && countRow.c || 0);
    const rankRow = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM (' +
      'SELECT e.identity_id, COUNT(*) AS c FROM entries e JOIN identities i ON i.id = e.identity_id ' +
      'WHERE 1 = 1 ' + scopeWhere + ' GROUP BY e.identity_id) t WHERE t.c > ?'
    ).bind(count).first();
    me = { id: identity.id, count: count, rank: Number(rankRow && rankRow.n || 0) + 1 };
  }

  return json({
    scope: scope,
    rows: (rows.results || []).map(row => ({
      id: row.id,
      displayName: row.display_name,
      type: row.type,
      count: Number(row.remembered),
      best: Number(row.best)
    })),
    me: me
  }, 200, { 'Cache-Control': 'no-store' });
}

async function handleStats(env) {
  if (!env.DB) return json({ entries: 0, titles: 0, identities: 0, users: 0 });
  try {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS entries, COUNT(DISTINCT key) AS titles, ' +
      'COUNT(DISTINCT identity_id) AS identities FROM entries'
    ).first();
    const users = await env.DB.prepare(
      "SELECT COUNT(*) AS users FROM identities WHERE type = 'user'"
    ).first();
    return json({
      entries: Number(row && row.entries || 0),
      titles: Number(row && row.titles || 0),
      identities: Number(row && row.identities || 0),
      users: Number(users && users.users || 0)
    });
  } catch (err) {
    return json({ entries: 0, titles: 0, identities: 0, users: 0 });
  }
}

/* ---------------- 入口 ---------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname.startsWith('/api/auth/')) return await handleAuth(request, env, url, url.pathname);
        if (url.pathname === '/api/config') {
          return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || '' },
            200, { 'Cache-Control': 'public, max-age=300' });
        }
        if (url.pathname === '/api/match') return await handleMatch(request, env);
        if (url.pathname === '/api/entries') return await handleEntries(request, env, url);
        if (url.pathname === '/api/rounds') return await handleRounds(request, env);
        if (url.pathname === '/api/leaderboard') return await handleLeaderboard(request, env, url);
        if (url.pathname === '/api/stats') return await handleStats(env);
        if (url.pathname === '/api/health') return json({ ok: true });
        return json({ error: 'not_found' }, 404);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err && err.stack || err);
      return json({ error: 'internal_error' }, 500);
    }
  }
};
