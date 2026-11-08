import { candidatesFromSearch, decide } from '../src/lib.js';

const UA = 'anime-memory-dev/0.1 (https://example.com)';
const QUERIES = [
  '进击的巨人', '进击的巨人人', '进巨', '巨人', '鬼灭', '鬼灭之刃',
  '千与千寻', '你的名字', 'attack on titan', 'spy family', 'aot', 'sao',
  'gmdzr', '四谎', '芙莉莲', '葬送的芙莉莲', '迷宫饭', '胆大党', '86',
  're0', '小圆', '魔法少女小圆', '某科学的超电磁炮', '火影忍者', '海贼王',
  '龙珠', '进击的巨人 最终季', '葬送的芙莉莲 第二季', '不存在的番剧名XYZ'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function search(q){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch('https://api.bgm.tv/v0/search/subjects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ keyword: q, filter: { type: [2] } }),
      signal: ctrl.signal
    });
    if (res.status === 429 || res.status >= 500){
      await sleep(2000);
      return search(q);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

let fails = 0;
for (const q of QUERIES) {
  try {
    const body = await search(q);
    const items = candidatesFromSearch(body);
    const d = decide(q, items);
    if (d.status === 'matched') {
      console.log(`MATCH   ${q}  ->  ${d.item.title} (${d.item.year || '?'}) score=${d.score}`);
    } else if (d.status === 'candidates') {
      const list = d.candidates.map(c => `${c.title}(${c.score})`).join(' | ');
      console.log(`ASK     ${q}  ->  ${list}`);
    } else {
      console.log(`NONE    ${q}`);
    }
  } catch (err) {
    fails++;
    console.log(`ERROR   ${q}  ${err.message}`);
  }
  await sleep(1200);
}
console.log(fails ? `\n${fails} network errors` : '\ndone');
