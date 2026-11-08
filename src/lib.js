/* 匹配置信度与归一化 —— 前端、Worker、测试共用（纯函数，无运行时依赖） */

const TRAD_PAIRS = "進进 撃击 戰战 鬥斗 龍龙 門门 國国 學学 愛爱 劇剧 場场 術术 會会 動动 畫画 靈灵 貓猫 讓让 說说 戀恋 線线 緣缘 結结 終终 記记 憶忆 夢梦 現现 實实 虛虚 劍剑 氣气 強强 銀银 鐵铁 車车 醫医 藥药 師师 傳传 獸兽 獵猎 殺杀 屍尸 惡恶 異异 聞闻 轟轰 華华 麗丽 漢汉 藝艺 閒闲 間间 陽阳 陰阴 兒儿 兩两 個个 們们 時时 東东 馬马 鳥鸟 魚鱼 電电 聲声 讀读 書书 寫写 對对 頭头 髮发 體体 點点 麼么 這这 誰谁 為为 與与 從从 來来 見见 處处 業业 樂乐 園园 團团 圖图 館馆 壞坏 變变 歸归 鄉乡 萬万 億亿 號号 稱称 種种 類类 級级 極极 決决 開开 關关 閉闭 無无 雙双 單单 邊边 遠远 運运 達达 過过 還还 連连 續续 經经 給给 請请 謝谢 認认 識识 話话 語语 誤误 課课 試试 驗验 證证 據据 檔档 網网 鋼钢 鍊炼 爐炉 燒烧 燈灯 熱热 願愿 聖圣 優优 視视 頻频 頁页 議议 樓楼 廁厕 鳳凤 蟲虫 螢萤 雲云 風风 紅红 藍蓝 綠绿 黃黄 銅铜 寶宝 貝贝 幣币 錢钱 買买 賣卖 貴贵 輸输 贏赢 勝胜 敗败 爭争 搶抢 奪夺 護护 衛卫 軍军 隊队 將将 帥帅 槍枪 彈弹 機机 飛飞 躍跃 傷伤 癒愈 誠诚 偽伪 祕秘 謎谜 題题 問问 難难 險险 舊旧 櫻樱 涼凉 宮宫 島岛 浜滨 広广 沢泽 絵绘 緒绪 縁缘 響响 黒黑 竜龙 剣剑 闘斗 覚觉 変变 対对 証证 録录 弾弹 滅灭 遊游 戲戏 戯戏 姫姬";
const TRAD = Object.create(null);
TRAD_PAIRS.split(/\s+/).forEach(function(pair){
  if (pair.length >= 2) TRAD[pair[0]] = pair[1];
});

const PUNCT = /[\s　☆★×♪〜《》〈〉「」『』【】\[\]（）(){}<>!?！？.,，。:：;；·・~～\-—_'"“”‘’|+*&#@%^$=]+/g;

/** 匹配用的严格归一化：保留季数/剧场版等限定词，避免把续作并成一部 */
export function normalizeTitle(input){
  if (input == null) return '';
  let s = String(input).normalize('NFKC').toLowerCase();
  s = s.replace(/./gu, function(ch){ return TRAD[ch] || ch; });
  s = s.replace(PUNCT, '').replace(/\//g, '');
  s = s.replace(/[的之]/g, '');
  return s;
}

export function cpLen(s){ return Array.from(s).length; }

export function lev(a, b){
  const A = Array.from(a), B = Array.from(b);
  const n = A.length, m = B.length;
  if (!n) return m;
  if (!m) return n;
  let prev = new Array(m + 1), cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++){
    cur[0] = i;
    for (let j = 1; j <= m; j++){
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}

/** 0~1 相似度：相等 1，包含 0.7~0.98，其余用编辑距离 */
export function similarity(q, k){
  if (!q || !k) return 0;
  if (q === k) return 1;
  const ql = cpLen(q), kl = cpLen(k);
  const min = Math.min(ql, kl), max = Math.max(ql, kl);
  if (!min) return 0;
  // 纯数字短查询（如 86）按前缀匹配，避免被长度差规则挡住
  if (min >= 2 && /^\d+$/.test(q) && k.indexOf(q) === 0){
    return 0.88 + 0.10 * (min / max);
  }
  const ascii = /^[a-z0-9]+$/.test(q);
  if (min >= 2 && (q.indexOf(k) >= 0 || k.indexOf(q) >= 0)){
    if (!(ascii && min < 3)) return 0.70 + 0.28 * (min / max);
  }
  if (Math.abs(ql - kl) > Math.max(2, Math.floor(max * 0.4))) return 0;
  return Math.max(0, 1 - lev(q, k) / max);
}

const ALIAS_KEYS = new Set(['别名', '中文名', '英文名', '日文名', '罗马字', '英文名（别名）', '别名（英文）']);

function pushAlias(out, v){
  if (typeof v !== 'string') return;
  const t = v.trim();
  if (!t || t.length > 80) return;
  if (/^https?:/i.test(t)) return;
  if (/^[\d.\s-]+$/.test(t)) return;
  out.push(t);
}

export function collectAliases(item){
  const out = [];
  pushAlias(out, item.name_cn);
  pushAlias(out, item.name);
  const box = Array.isArray(item.infobox) ? item.infobox : [];
  for (const row of box){
    if (!row || !ALIAS_KEYS.has(row.key)) continue;
    if (typeof row.value === 'string') pushAlias(out, row.value);
    else if (Array.isArray(row.value)){
      for (const v of row.value) pushAlias(out, v && v.v);
    }
  }
  const seen = new Set();
  const res = [];
  for (const t of out){
    const n = normalizeTitle(t);
    if (n && !seen.has(n)){ seen.add(n); res.push(t); }
  }
  return res;
}

const TAG_STOP = new Set([
  'TV', 'WEB', 'OVA', 'OAD', '剧场版', '动画', '日本', '中国', '国产', '美国',
  '漫画改', '轻小说改', '游戏改', '原创', '续作', '系列', '短片', '泡面番', '动态漫画'
]);

export function pickTags(item){
  const source = Array.isArray(item.meta_tags) && item.meta_tags.length
    ? item.meta_tags.slice()
    : (Array.isArray(item.tags) ? item.tags.map(function(t){ return t && t.name; }) : []);
  const out = [];
  for (const raw of source){
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (!t || t.length > 8) continue;
    if (TAG_STOP.has(t)) continue;
    if (/^\d/.test(t)) continue;
    if (out.indexOf(t) >= 0) continue;
    out.push(t);
    if (out.length === 2) break;
  }
  return out;
}

export function processItem(item){
  const date = typeof item.date === 'string' ? item.date : '';
  const year = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
  const title = (item.name_cn || item.name || '').trim();
  const subtitle = item.name_cn && item.name ? String(item.name).trim() : '';
  return {
    id: item.id,
    title: title,
    subtitle: subtitle,
    year: year,
    tags: pickTags(item),
    aliases: collectAliases(item),
    platform: item.platform || ''
  };
}

export function scoreItems(query, items){
  const q = normalizeTitle(query);
  return items.map(function(item, rank){
    let best = 0, matchedName = '';
    const names = [item.title, item.subtitle].concat(item.aliases || []);
    for (const name of names){
      const n = normalizeTitle(name);
      if (!n) continue;
      const s = similarity(q, n);
      if (s > best){ best = s; matchedName = name; }
    }
    return { item: item, score: best, matchedName: matchedName, rank: rank };
  }).sort(function(a, b){
    return b.score - a.score || a.rank - b.rank;
  });
}

const AUTO_SCORE = 0.9;
const AUTO_MARGIN = 0.04;

export function decide(query, items){
  if (!items || !items.length) return { status: 'none' };
  const scored = scoreItems(query, items);
  const best = scored[0];
  const second = scored[1];
  const margin = best.score - (second ? second.score : 0);
  const q = normalizeTitle(query);
  // 两三个字母的缩写（aot/op/...）只信完全相同的别名，避免 AOTU 这类前缀误判
  const shortAscii = /^[a-z0-9]{2,3}$/.test(q) && !/^\d+$/.test(q);
  if (shortAscii && best.score < 1) return { status: 'none' };
  if (best.score >= AUTO_SCORE && margin >= AUTO_MARGIN){
    return { status: 'matched', item: best.item, score: Math.round(best.score * 100) / 100 };
  }
  if (best.score < 0.35) return { status: 'none' };
  const candidates = scored.slice(0, 4).map(function(x){
    return Object.assign({}, x.item, { score: Math.round(x.score * 100) / 100 });
  });
  return { status: 'candidates', candidates: candidates };
}

/** 把 Bangumi 返回体整理成候选；供 worker 与测试共用 */
export function candidatesFromSearch(body){
  const rows = body && Array.isArray(body.data) ? body.data : [];
  return rows.slice(0, 10).map(processItem);
}
