/* 身份、会话、密码 —— Cloudflare Workers / D1 */

const COOKIE_NAME = 'am_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 365;
const DEFAULT_ITERATIONS = 25000;
const MAX_ITERATIONS = 200000;
const GUEST_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';
const USERNAME_RE = /^[\p{L}\p{N}_]{2,20}$/u;

const encoder = new TextEncoder();

function hex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function unhex(value) {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.substr(i * 2, 2), 16);
  return out;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(text)));
  return hex(new Uint8Array(digest));
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return hex(buf);
}

function randomChars(count) {
  const buf = new Uint8Array(count);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < count; i++) out += GUEST_CHARS[buf[i] % GUEST_CHARS.length];
  return out;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isUniqueViolation(err) {
  const message = String(err && err.message || err).toLowerCase();
  return message.includes('unique') || message.includes('constraint');
}

export function clampIterations(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_ITERATIONS;
  return Math.min(MAX_ITERATIONS, Math.max(1000, Math.floor(n)));
}

export async function hashPassword(password, saltHex, iterations, pepper) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(password) + '\u0000' + String(pepper || '')),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unhex(saltHex), iterations: iterations, hash: 'SHA-256' },
    material,
    256
  );
  return hex(new Uint8Array(bits));
}

export async function verifyPassword(password, row, pepper) {
  if (!row || !row.password_hash || !row.password_salt) return false;
  const iterations = clampIterations(row.password_iter);
  const hash = await hashPassword(password, row.password_salt, iterations, pepper);
  return safeEqual(String(row.password_hash), hash);
}

/* ---------------- cookie / session ---------------- */

export function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export function getSessionToken(request) {
  const token = getCookie(request, COOKIE_NAME);
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

function secureFlag(url) {
  return url && url.protocol === 'https:' ? '; Secure' : '';
}

export function sessionCookie(token, url) {
  return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
    Math.floor(SESSION_TTL_MS / 1000) + secureFlag(url);
}

export function clearSessionCookie(url) {
  return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secureFlag(url);
}

export async function createSession(env, identityId) {
  const token = randomHex(32);
  const hash = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, identity_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(hash, identityId, now, now + SESSION_TTL_MS).run();
  try {
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  } catch (err) { /* 清理失败不影响登录 */ }
  return token;
}

export function publicIdentity(row) {
  return {
    id: row.id,
    type: row.type,
    displayName: row.display_name,
    startedAt: Number(row.started_at) || 0,
    createdAt: Number(row.created_at) || 0
  };
}

export async function getIdentity(request, env) {
  const token = getSessionToken(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  let row;
  try {
    row = await env.DB.prepare(
      'SELECT i.*, s.expires_at AS session_expires FROM sessions s ' +
      'JOIN identities i ON i.id = s.identity_id WHERE s.token_hash = ?'
    ).bind(hash).first();
  } catch (err) {
    return null;
  }
  if (!row) return null;
  if (Number(row.session_expires) <= Date.now()) {
    try { await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run(); } catch (err) {}
    return null;
  }
  const now = Date.now();
  if (now - Number(row.last_seen_at || 0) > 3600000) {
    try { await env.DB.prepare('UPDATE identities SET last_seen_at = ? WHERE id = ?').bind(now, row.id).run(); } catch (err) {}
  }
  return publicIdentity(row);
}

export async function deleteSession(env, token) {
  if (!token) return;
  const hash = await sha256Hex(token);
  try { await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run(); } catch (err) {}
}

/* ---------------- 游客 ---------------- */

export async function createGuest(env) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = crypto.randomUUID();
    const name = '游客' + randomChars(5);
    const now = Date.now();
    try {
      await env.DB.prepare(
        'INSERT INTO identities (id, type, display_name, created_at, last_seen_at, started_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(id, 'guest', name, now, now, now).run();
      const token = await createSession(env, id);
      return {
        identity: { id: id, type: 'guest', displayName: name, startedAt: now, createdAt: now },
        token: token
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error('guest_name_exhausted');
}

/* ---------------- 用户 ---------------- */

export function normalizeUsername(raw) {
  const name = String(raw || '').normalize('NFKC').trim();
  if (!USERNAME_RE.test(name)) return null;
  if (name.indexOf('游客') === 0) return null;
  return { name: name, lower: name.toLowerCase() };
}

export function validPassword(password) {
  if (typeof password !== 'string') return false;
  const length = Array.from(password).length;
  return length >= 6 && length <= 64 && password.trim().length > 0;
}

export async function registerUser(env, options) {
  const username = normalizeUsername(options.username);
  if (!username) return { error: 'bad_username' };
  if (!validPassword(options.password)) return { error: 'bad_password' };
  const iterations = clampIterations(options.iterations);
  const salt = randomHex(16);
  const hash = await hashPassword(options.password, salt, iterations, options.pepper || '');
  const current = options.current || null;

  if (current && current.type === 'user') return { error: 'already_logged_in' };

  const conflict = await env.DB.prepare(
    'SELECT id FROM identities WHERE username_lower = ? OR display_name = ? LIMIT 1'
  ).bind(username.lower, username.name).first();
  if (conflict) return { error: 'username_taken' };

  const now = Date.now();
  if (current && current.type === 'guest') {
    try {
      await env.DB.prepare(
        'UPDATE identities SET type = ?, display_name = ?, username_lower = ?, ' +
        'password_hash = ?, password_salt = ?, password_iter = ?, last_seen_at = ? ' +
        'WHERE id = ? AND type = ?'
      ).bind('user', username.name, username.lower, hash, salt, iterations, now, current.id, 'guest').run();
    } catch (err) {
      if (isUniqueViolation(err)) return { error: 'username_taken' };
      throw err;
    }
    // 权限变了，换一个会话，避免会话固定
    try { await env.DB.prepare('DELETE FROM sessions WHERE identity_id = ?').bind(current.id).run(); } catch (err) {}
    const token = await createSession(env, current.id);
    const row = await env.DB.prepare('SELECT * FROM identities WHERE id = ?').bind(current.id).first();
    return { identity: publicIdentity(row), token: token };
  }

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      'INSERT INTO identities (id, type, display_name, username_lower, password_hash, password_salt,' +
      ' password_iter, created_at, last_seen_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, 'user', username.name, username.lower, hash, salt, iterations, now, now, now).run();
  } catch (err) {
    if (isUniqueViolation(err)) return { error: 'username_taken' };
    throw err;
  }
  const token = await createSession(env, id);
  return {
    identity: { id: id, type: 'user', displayName: username.name, startedAt: now, createdAt: now },
    token: token
  };
}

export async function loginUser(env, options) {
  const username = normalizeUsername(options.username);
  if (!username || typeof options.password !== 'string' || !options.password) {
    return { error: 'invalid_credentials' };
  }
  const row = await env.DB.prepare(
    'SELECT * FROM identities WHERE username_lower = ? AND type = ? LIMIT 1'
  ).bind(username.lower, 'user').first();
  if (!row) return { error: 'invalid_credentials' };
  const ok = await verifyPassword(options.password, row, options.pepper || '');
  if (!ok) return { error: 'invalid_credentials' };

  const current = options.current || null;
  if (current && current.type === 'user' && current.id !== row.id) {
    return { error: 'already_logged_in' };
  }
  if (current && current.type === 'guest' && current.id !== row.id) {
    try { await mergeGuest(env, current.id, row.id); }
    catch (err) { /* 合并失败不阻断登录，游客进度仍保留在游客身份下 */ }
  }
  const token = await createSession(env, row.id);
  const now = Date.now();
  try { await env.DB.prepare('UPDATE identities SET last_seen_at = ? WHERE id = ?').bind(now, row.id).run(); } catch (err) {}
  return { identity: publicIdentity(row), token: token };
}

export async function mergeGuest(env, guestId, userId) {
  if (!guestId || !userId || guestId === userId) return;
  const guest = await env.DB.prepare('SELECT id, type FROM identities WHERE id = ?').bind(guestId).first();
  if (!guest || guest.type !== 'guest') return;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO entries (identity_id, key, title, subtitle, year, tags, source, added_at) ' +
      'SELECT ?, key, title, subtitle, year, tags, source, added_at FROM entries WHERE identity_id = ?'
    ).bind(userId, guestId),
    env.DB.prepare('DELETE FROM entries WHERE identity_id = ?').bind(guestId),
    env.DB.prepare('UPDATE rounds SET identity_id = ? WHERE identity_id = ?').bind(userId, guestId),
    env.DB.prepare('DELETE FROM sessions WHERE identity_id = ?').bind(guestId),
    env.DB.prepare('DELETE FROM identities WHERE id = ? AND type = ?').bind(guestId, 'guest')
  ]);
}

/* ---------------- 人机验证 / 限流 ---------------- */

export async function verifyTurnstile(request, env, token) {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return true;
  if (typeof token !== 'string' || !token) return false;
  try {
    const form = new FormData();
    form.append('secret', secret);
    form.append('response', token);
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form
    });
    const data = await res.json();
    return !!data.success;
  } catch (err) {
    return false;
  }
}

const authBuckets = new Map();

export function authRateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const bucket = authBuckets.get(ip);
  if (!bucket || now > bucket.reset) {
    authBuckets.set(ip, { count: 1, reset: now + 10 * 60 * 1000 });
    return false;
  }
  bucket.count++;
  return bucket.count > 20;
}
