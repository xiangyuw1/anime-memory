/* 本地 auth / 进度 / 历史 / 排行榜冒烟测试（需要 wrangler dev 在 8787） */
const BASE = 'http://127.0.0.1:8787';

function cookieFrom(res) {
  const values = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const value of values) {
    const m = /am_session=([^;]+)/.exec(value);
    if (m) return 'am_session=' + m[1];
  }
  return '';
}

class Jar {
  constructor(label) { this.label = label; this.cookie = ''; }
  async req(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(BASE + path, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
    const next = cookieFrom(res);
    if (next) this.cookie = next;
    let data = null;
    try { data = await res.json(); } catch (err) {}
    return { status: res.status, data };
  }
}

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('ok   ', label);
  else { failures++; console.log('FAIL ', label, extra === undefined ? '' : JSON.stringify(extra)); }
}

const loginName = 'test_' + Math.random().toString(36).slice(2, 8);
const password = 'testpass123';

const A = new Jar('A');
const B = new Jar('B');
const C = new Jar('C');

check('no cookie -> /me 401', (await A.req('/api/auth/me')).status === 401);

const guestA = await A.req('/api/auth/guest', { method: 'POST' });
check('guest A created', guestA.status === 200 && guestA.data.identity.type === 'guest', guestA.data);
check('guest A name format', /^游客[23456789abcdefghjkmnpqrstuvwxyz]{5}$/.test(guestA.data.identity.displayName || ''), guestA.data.identity.displayName);

const meA = await A.req('/api/auth/me');
check('me A same id', meA.data.identity.id === guestA.data.identity.id);

const e1 = await A.req('/api/entries', { method: 'POST', body: { key: 'local:0', title: '鬼灭之刃', subtitle: 'Demon Slayer', year: 2019, tags: ['热血', '奇幻'], source: 'local' } });
check('add entry A', e1.status === 200 && e1.data.ok, e1.data);
check('entries A 1', (await A.req('/api/entries')).data.entries.length === 1);

const r1 = await A.req('/api/rounds', { method: 'POST' });
check('save round A', r1.status === 200 && r1.data.round.count === 1, r1.data);
check('rounds A 1', (await A.req('/api/rounds')).data.rounds.length === 1);

const reg = await A.req('/api/auth/register', { method: 'POST', body: { username: loginName, password } });
check('register upgrades guest', reg.status === 200 && reg.data.identity.type === 'user' && reg.data.identity.id === guestA.data.identity.id, reg.data);
check('register preserves entries', (await A.req('/api/entries')).data.entries.length === 1);
check('register preserves rounds', (await A.req('/api/rounds')).data.rounds.length === 1);

const guestB = await B.req('/api/auth/guest', { method: 'POST' });
check('guest B different id', guestB.data.identity.id !== guestA.data.identity.id);
check('guest B different name', guestB.data.identity.displayName !== guestA.data.identity.displayName, [guestA.data.identity.displayName, guestB.data.identity.displayName]);
await B.req('/api/entries', { method: 'POST', body: { key: 'bgm:325808', title: '地狱乐', subtitle: '地獄楽', year: 2023, tags: ['奇幻'], source: 'bgm' } });

const loginB = await B.req('/api/auth/login', { method: 'POST', body: { username: loginName, password } });
check('login merges guest', loginB.status === 200 && loginB.data.identity.id === guestA.data.identity.id, loginB.data);
const entriesB = await B.req('/api/entries');
check('merged entries 2', entriesB.data.entries.length === 2, entriesB.data.entries.map(e => e.title));

const board = await B.req('/api/leaderboard?scope=all');
check('leaderboard has user', board.data.rows.length === 1 && board.data.rows[0].id === loginB.data.identity.id && board.data.rows[0].count === 2, board.data);
check('leaderboard me rank 1', board.data.me && board.data.me.rank === 1 && board.data.me.count === 2, board.data.me);

const stats = await B.req('/api/stats');
check('stats entries 2', stats.data.entries === 2 && stats.data.titles === 2, stats.data);

await C.req('/api/auth/guest', { method: 'POST' });
const dupReg = await C.req('/api/auth/register', { method: 'POST', body: { username: loginName, password } });
check('duplicate username 409', dupReg.status === 409 && dupReg.data.error === 'username_taken', dupReg.data);
const badLogin = await C.req('/api/auth/login', { method: 'POST', body: { username: loginName, password: 'wrongpass' } });
check('wrong password 401', badLogin.status === 401 && badLogin.data.error === 'invalid_credentials', badLogin.data);
const caseLogin = await C.req('/api/auth/login', { method: 'POST', body: { username: loginName.toUpperCase(), password } });
check('username case-insensitive', caseLogin.status === 200, caseLogin.data);

const logoutB = await B.req('/api/auth/logout', { method: 'POST' });
check('logout gives guest', logoutB.status === 200 && logoutB.data.identity.type === 'guest' && logoutB.data.identity.id !== loginB.data.identity.id, logoutB.data);
check('guest after logout has no entries', (await B.req('/api/entries')).data.entries.length === 0);

const userBoard = await C.req('/api/leaderboard?scope=users');
check('users leaderboard', userBoard.data.rows.length === 1 && userBoard.data.rows[0].count === 2, userBoard.data);

// 清理测试进度，保留测试账号（没有进度就不会出现在排行榜）
await C.req('/api/entries', { method: 'DELETE' });
await B.req('/api/entries', { method: 'DELETE' });
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
