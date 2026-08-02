const http = require('http');     
const https = require('https');  
const { execFile } = require('child_process');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');


// ========== TVBox API（拆分为独立模块）==========
const { TVBoxAPI, tvboxSources, sourceMeta } = require("./tvbox_api.js");

// 当前激活源（持久化到文件）
const _SOURCE_CONFIG_FILE = path.join(__dirname, 'data', 'active_source.json');
function _loadActiveSource() {
  try {
    const cfg = JSON.parse(fs.readFileSync(_SOURCE_CONFIG_FILE, 'utf8'));
    if (cfg.source && tvboxSources[cfg.source]) return cfg.source;
  } catch (e) {}
  return 'bubu';
}
var _activeSourceKey = _loadActiveSource();
function getActiveSource() { return tvboxSources[_activeSourceKey]; }
function setActiveSource(key) {
  if (!tvboxSources[key]) return false;
  _activeSourceKey = key;
  try { fs.writeFileSync(_SOURCE_CONFIG_FILE, JSON.stringify({ source: key }, null, 2), 'utf-8'); } catch(e) {}
  return true;
}
const defaultSource = tvboxSources.bubu; // 保持引用兼容，实际用 getActiveSource()

const PORT = 9975;
const _DEFAULT_SITE = 'https://ds3xy2yunsa.xyz';
const _SITE_CONFIG_FILE = path.join(__dirname, 'data', 'site_url.json');

function _loadSite() {
  try {
    const cfg = JSON.parse(fs.readFileSync(_SITE_CONFIG_FILE, 'utf8'));
    if (cfg.url && /^https?:\/\//.test(cfg.url)) return cfg.url.replace(/\/+$/, '');
  } catch (e) {}
  return _DEFAULT_SITE;
}
const SITE = _loadSite();
const TMDB_BASE = 'https://api.tmdb.org/3';

// ========== TMDB Key 三层回退：环境变量 → 配置文件 → 内置默认值 ==========
const _TMDB_CONFIG_FILE = path.join(__dirname, 'data', 'tmdb_key.json');
const _DEFAULT_TMDB_KEY = '';

function _loadTmdbKey() {
  // 1. 环境变量
  if (process.env.TMDB_KEY) return process.env.TMDB_KEY;
  // 2. 配置文件（用户可自定义覆盖）
  try {
    const cfg = JSON.parse(fs.readFileSync(_TMDB_CONFIG_FILE, 'utf8'));
    if (cfg.key) return cfg.key;
  } catch (e) {}
  // 3. 内置默认值
  return _DEFAULT_TMDB_KEY;
}
const TMDB_KEY = _loadTmdbKey();
const _imgCache = new Map();
const _playDataCache = new Map();
const _pageCache = new Map(); // 缓存 vodUrl -> 完整 HTML // 缓存 vodUrl -> {sources, timestamp}

// ========== HTTPS Agent 复用 ==========
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

// ========== 缓存（LRU 上限 100） ==========
const MAX_CACHE = 100;
const cache = new Map();
function cacheGet(key) { return cache.get(key); }
function cacheSet(key, val) {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, val);
}

// ========== SSRF 防护 ==========
const ALLOWED_HOSTS = ['api.tmdb.org', 'image.tmdb.org', 'images.tmdb.org', 'mov.cenguigui.cn', '4k-av.com', 'www.4k-av.com'];
try { const _sh = new URL(SITE).hostname; if (!ALLOWED_HOSTS.includes(_sh)) ALLOWED_HOSTS.push(_sh); } catch(e) {}
function isSafeUrl(target) {
  try {
    const u = new URL(target);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(h)) return false;
    return ALLOWED_HOSTS.some(ah => h === ah || h.endsWith('.' + ah));
  } catch { return false; }
}

// ========== 收藏 & 历史 数据存储 ==========
const DATA_DIR = '/sdcard/Download/movies';
const FAV_FILE = path.join(DATA_DIR, 'favorites.json');
const HIS_FILE = path.join(DATA_DIR, 'history.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ========== 本地影片库列表缓存（按 mtime 失效，防大文件 OOM 闪退）==========
const _localListCache = new Map(); // key: absPath -> {mtime, size, list}
const LOCAL_MAX_SIZE = 80 * 1024 * 1024; // 单文件超过 80MB 直接拒绝，避免 OOM 闪退
function getLocalList(absPath) {
  var st = fs.statSync(absPath);
  if (st.size > LOCAL_MAX_SIZE) {
    throw new Error('文件过大（' + (st.size / 1048576).toFixed(1) + 'MB），暂不支持直接打开');
  }
  var cached = _localListCache.get(absPath);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.list;
  var raw = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  var list = raw.list || raw.data || raw || [];
  if (!Array.isArray(list)) list = [list];
  if (_localListCache.size > 20) _localListCache.clear(); // 简单防膨胀
  _localListCache.set(absPath, { mtime: st.mtimeMs, size: st.size, list: list });
  return list;
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return []; }
}

function writeJSON(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function favList() { return readJSON(FAV_FILE); }
function hisList() { return readJSON(HIS_FILE); }

function favAdd(item) {
  const list = favList();
  const id = item.id || (item.url || '').replace(/[^a-zA-Z0-9]/g, '_');
  if (list.some(f => f.id === id)) return { ok: true, msg: 'already' };
  list.unshift({ id, title: item.title||'', img: item.img||'', url: item.url||'', source: item.source||'bubutv', addedAt: Date.now() });
  writeJSON(FAV_FILE, list);
  return { ok: true, msg: 'added' };
}

function favRemove(id) {
  const list = favList().filter(f => f.id !== id);
  writeJSON(FAV_FILE, list);
  return { ok: true };
}

function favCheck(id) { return favList().some(f => f.id === id); }

function hisAdd(item) {
  const list = hisList();
  const id = item.id || (item.url || '').replace(/[^a-zA-Z0-9]/g, '_');
  const exist = list.findIndex(h => h.id === id);
  if (exist >= 0) {
    // 记录已存在：更新进度等字段，title/img在非空时覆盖
    if (item.title) list[exist].title = item.title;
    if (item.img) list[exist].img = item.img;
    if (item.progress !== undefined) list[exist].progress = item.progress;
    if (item.duration !== undefined) list[exist].duration = item.duration;
    if (item.playUrl !== undefined) list[exist].playUrl = item.playUrl;
    if (item.lastWatch) list[exist].lastWatch = item.lastWatch;
    if (item.episode !== undefined) list[exist].episode = item.episode;
    if (item.source) list[exist].source = item.source;
    if (item.url) list[exist].url = item.url;
    if (item.lineName !== undefined) list[exist].lineName = item.lineName;
    // 移到最前（最近观看）
    const entry = list.splice(exist, 1)[0];
    if (!entry.lastWatch) entry.lastWatch = Date.now();
    list.unshift(entry);
    if (list.length > 200) list.length = 200;
    writeJSON(HIS_FILE, list);
    return { ok: true };
  }
  // 新记录：使用全部字段创建
  const entry = { id, title: item.title||'', img: item.img||'', url: item.url||'', source: item.source||'bubutv', lastWatch: Date.now(), episode: item.episode||'', lineName: item.lineName||'', progress: item.progress || 0, duration: item.duration || 0, playUrl: item.playUrl||'' };
  list.unshift(entry);
  if (list.length > 200) list.length = 200;
  writeJSON(HIS_FILE, list);
  return { ok: true };
}

function hisRemove(id) {
  const list = hisList().filter(h => h.id !== id);
  writeJSON(HIS_FILE, list);
  return { ok: true };
}

function hisClear() { writeJSON(HIS_FILE, []); return { ok: true }; }

// ========== 工具函数 ==========
function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function escAttr(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// fetchPage：防重入 + response error 处理 + Agent 复用
function fetchPage(target, cb) {
  const hit = cacheGet(target);
  if (hit && Date.now() - hit.t < 10*60*1000) return cb(null, hit.v);
  const u = new URL(target);
  let called = false;
  function done(err, data) { if (!called) { called = true; cb(err, data); } }

  const req = https.request(u, {
    method: 'GET',
    agent: httpsAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      'Referer': SITE + '/',
      'Accept': 'text/html,*/*',
      'Accept-Encoding': 'identity'
    },
    timeout: 15000
  }, r => {
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      cacheSet(target, { t: Date.now(), v: text });
      console.log(`[fetch] ${r.statusCode} ${target} len=${text.length}`);
      done(null, text);
    });
    r.on('error', e => done(e));
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', e => done(e));
  req.end();
}

function strip(s) { return String(s||'').replace(/<[^>]+>/g,'').replace(/&nbsp;?/gi,'').replace(/&#?\w+;/g,'').replace(/\s+/g,' ').trim(); }
function urlFix(img) { return img && img.startsWith('http') ? img : (img ? SITE + img : ''); }

// 按tab分割HTML
function splitTabs(html) {
  const parts = html.split(/class="module-main tab-list[^"]*"/);
  const tabs = [];
  for (let i = 1; i < parts.length; i++) {
    const endIdx1 = parts[i].indexOf('class="module-main tab-list');
    const endIdx2 = parts[i].indexOf('class="footer');
    let endIdx = -1;
    if (endIdx1 > 0 && endIdx2 > 0) endIdx = Math.min(endIdx1, endIdx2);
    else if (endIdx1 > 0) endIdx = endIdx1;
    else if (endIdx2 > 0) endIdx = endIdx2;
    const block = endIdx > 0 ? parts[i].substring(0, endIdx) : parts[i];
    tabs.push(block);
  }
  return tabs;
}

// 解析影片列表
function parseCards(html) {
  const cards = [];
  const reg = /<a[^>]*href="(\/voddetail\/[0-9]+\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = reg.exec(html))) {
    const url = m[1], block = m[2];
    const imgMatch = block.match(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"/);
    if (!imgMatch) continue;
    const img = imgMatch[1], title = strip(imgMatch[2]);
    if (!title) continue;
    const tagMatch = block.match(/<div class="tag[^"]*">([^<]+)<\/div>/);
    const tag = tagMatch ? strip(tagMatch[1]) : '';
    const noteMatch = block.match(/class="[^"]*module-item-note[^"]*">([^<]*)<\/div>/);
    const note = noteMatch ? noteMatch[1].trim() : '';
    const infoTimeMatch = block.match(/class="[^"]*info-time[^"]*">([\s\S]*?)<\/div>/);
    const infoTime = infoTimeMatch ? strip(infoTimeMatch[1]) : '';
    const scoreMatch = block.match(/class="[^"]*score[^"]*">\s*([\d.]+)\s*<\/div>/);
    const score = scoreMatch ? scoreMatch[1].trim() : '';
    const rolesMatch = block.match(/class="[^"]*info-roles[^"]*">([\s\S]*?)<\/div>/);
    const roles = rolesMatch ? strip(rolesMatch[1]).replace(/^主演[：:]\s*/, '') : '';
    const introMatch = block.match(/class="[^"]*info-intro[^"]*">([\s\S]*?)<\/div>/);
    const intro = introMatch ? strip(introMatch[1]).replace(/^简介[：:]\s*/, '') : '';
    const hitsMatch = block.match(/class="[^"]*hits[^"]*">\s*(?:<[^>]*>)\s*([\d.]+[\w]*)\s*<\/div>/i);
    const hits = hitsMatch ? hitsMatch[1].trim() : '';
    const infoItems = [];
    const infoReg = /class="module-info-item-content">([\s\S]*?)<\/div>/g;
    let im;
    while ((im = infoReg.exec(block)) !== null) { infoItems.push(strip(im[1])); }
    const proxyImg = img ? '/img?url=' + encodeURIComponent(urlFix(img)) : '';
    cards.push({ title, url, img: proxyImg, directImg: urlFix(img), tag: note || tag, top: '', note, infoTime, score, roles, hits, desc: roles || infoItems[1] || '', meta: infoItems[0] || '', actors: roles || infoItems[1] || '', intro });
  }
  return cards;
}


// 解析影片库"剧情"筛选选项，返回 [{name, slug}]
function parseTypeFilters(html) {
  const opts = [];
  // 匹配: <div class="filter-title">剧情</div> ... <div class="filter-ul"> ... </div>
  const m = html.match(/filter-title">剧情<\/div>[\s\S]*?<div class="filter-ul">([\s\S]*?)<\/div>/);
  if (!m) return opts;
  const links = m[1].match(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g) || [];
  for (const lk of links) {
    const href = (lk.match(/href="([^"]+)"/) || ['',''])[1];
    const txt = (lk.match(/>([^<]+)</) || ['',''])[1].trim();
    if (!txt || txt === '全部') continue;
    // /vodshow/{cid}---{filter}--------.html, filter 是 URL 编码的中文
    const parts = href.replace('/vodshow/','').replace('.html','').split('-');
    const slug = parts[3] ? decodeURIComponent(parts[3]) : '';
    if (slug) opts.push({name: txt, slug: slug});
  }
  return opts;
}

function parseMapItems(html) {
  const posterItems = parseCards(html);
  const cardItems = parseCardItems(html);
  if (posterItems.length) return posterItems;
  if (cardItems.length) return cardItems;
  return [];
}

function parseCardItems(html) {
  const items = [];
  const reg = /<div class="module-card-item module-item[^"]*">([\s\S]*?)(?=<div class="module-card-item module-item|<div class="footer|$)/g;
  let cm;
  while ((cm = reg.exec(html))) {
    const block = cm[1];
    const href = (block.match(/href="(\/detail\/[^"]+\.html)"/) || ['',''])[1];
    const title = (block.match(/<strong>([^<]*)<\/strong>/) || ['',''])[1].trim();
    const img = (block.match(/data-original="([^"]*?)"/) || ['',''])[1];
    const noteMatch = block.match(/class="[^"]*module-item-note[^"]*">([^<]*)<\/div>/);
    const note = noteMatch ? noteMatch[1].trim() : '';
    const top = (block.match(/class="module-item-top[^"]*">([^<]*)/) || ['',''])[1].trim();
    const clsMatch = block.match(/class="[^"]*module-card-item-class[^"]*">([^<]*)<\/div>/);
    const cls = clsMatch ? clsMatch[1].trim() : '';
    const infoTimeMatch = block.match(/class="[^"]*info-time[^"]*">([\s\S]*?)<\/div>/);
    const infoTime = infoTimeMatch ? strip(infoTimeMatch[1]) : '';
    const infoItems = [];
    const infoReg = /class="module-info-item-content">([\s\S]*?)<\/div>/g;
    let im;
    while ((im = infoReg.exec(block)) !== null) { infoItems.push(strip(im[1])); }
    const yearRegion = infoItems[0] || '';
    const actors = infoItems[1] || '';
    const scoreMatch = block.match(/class="[^"]*score[^"]*">\s*([\d.]+)\s*<\/div>/);
    const score = scoreMatch ? scoreMatch[1].trim() : '';
    const rolesMatch = block.match(/class="[^"]*info-roles[^"]*">([\s\S]*?)<\/div>/);
    const roles = rolesMatch ? strip(rolesMatch[1]).replace(/^主演[：:]\s*/, '') : '';
    const introMatch = block.match(/class="[^"]*info-intro[^"]*">([\s\S]*?)<\/div>/);
    const intro = introMatch ? strip(introMatch[1]).replace(/^简介[：:]\s*/, '') : '';
    const hitsMatch = block.match(/class="[^"]*hits[^"]*">\s*(?:<[^>]*>)\s*([\d.]+[\w]*)\s*<\/div>/i);
    const hits = hitsMatch ? hitsMatch[1].trim() : '';
    if (title && href) {
      const proxyImg = img ? '/img?url=' + encodeURIComponent(urlFix(img)) : '';
      items.push({ title, url: href, img: proxyImg, tag: top || note || cls, top, note, infoTime, score, roles, hits, desc: actors, meta: yearRegion, actors: roles || actors, intro });
    }
  }
  if (!items.length) return parseCards(html);
  return items;
}

function parseRankItems(html) {
  const items = [];
  const catBlocks = html.split(/(?=<div[^>]*class="module-paper-item module-item")/);
  for (let ci = 1; ci < catBlocks.length; ci++) {
    const block = catBlocks[ci];
    const catTitle = (block.match(/class="module-paper-item-title">([^<]*)/) || ['',''])[1].trim();
    const itemReg = /<a[^>]*href="([^"]*?)">[\s\S]*?class="module-paper-item-infotitle">([^<]*)<\/span>[\s\S]*?<\/a>/gi;
    let localIdx = 0;
    let m;
    while ((m = itemReg.exec(block))) {
      const href = m[1];
      const title = m[2].trim();
      const status = (m[0].match(/<p>([^<]*)<\/p>/) || ['',''])[1].trim();
      if (title && href) {
        localIdx++;
        items.push({ title, url: href, img: '', tag: localIdx, desc: status, catTitle });
      }
    }
  }
  if (!items.length) {
    const posterItems = parseCards(html);
    if (posterItems.length) return posterItems;
    return parseCardItems(html);
  }
  return items;
}

function parseTopicItems(html) {
  const items = [];
  const reg = /<a[^>]*href="([^"]*?)"[^>]*title="([^"]*?)"[\s\S]*?class="module-(?:poster|paper)-item[\s\S]*?<\/a>/gi;
  let m;
  while ((m = reg.exec(html))) {
    const block = m[0];
    const img = (block.match(/data-original="([^"]*?)"/) || ['',''])[1];
    const note = (block.match(/class="module-item-note">([^<]*)<\/div>/) || ['',''])[1].trim();
    const proxyImg2 = img ? '/img?url=' + encodeURIComponent(urlFix(img)) : '';
    items.push({ title: m[2], url: m[1], img: proxyImg2, tag: note, desc: '' });
  }
  if (!items.length) return parseCards(html);
  return items;
}

// ========== 解析播放线路和集数 ==========
function parsePlaySources(html) {
  const sources = [];
  const pm = html.match(/var\s+player_aaaa\s*=\s*(\{[^}<]+\})/);
  let playerData = null;
  if (pm) { try { playerData = JSON.parse(pm[1]); } catch(e) {} }

  // 1. 解析线路 tab 名称（兼容详情页和播放页两种格式）
  const routeMap = {};
  // 详情页格式: <a href="#playlist2" ... class="swiper-slide-text">DY</a>
  const rt1 = /<a[^>]*href="#playlist(\d+)"[^>]*class="swiper-slide-text[^"]*"[^>]*>([^<]+)<\/a>/gi;
  let tm;
  while ((tm = rt1.exec(html))) { if (tm[1] && tm[2]) routeMap[tm[1]] = strip(tm[2]); }
  // 播放页格式: <a href="/vodplay/ID-N-1.html" class="swiper-slide-text ..."><span>DY</span></a>
  const rt2 = /<a[^>]*href="\/vodplay\/[0-9]+-([0-9]+)-1\.html"[^>]*class="swiper-slide-text[^"]*"[^>]*>[\s\S]*?<span>([^<]*)<\/span>[\s\S]*?<\/a>/gi;
  while ((tm = rt2.exec(html))) { if (tm[1] && tm[2] && !routeMap[tm[1]]) routeMap[tm[1]] = strip(tm[2]); }

  // 2. 按 playlist 块解析每条线路的集数（兼容 id="playlist2" 和 id="playlist21"）
  const playlistReg = /<div[^>]*id="playlist(\d+)"[^>]*class="[^"]*lists-box[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*id="playlist|<div[^>]*class="footer|$)/gi;
  let pm2;
  while ((pm2 = playlistReg.exec(html))) {
    const routeNum = pm2[1];
    const block = pm2[2];
    const eps = [];
    const epReg = /<a[^>]*href="(\/vodplay\/[0-9]+-[0-9]+-([0-9]+)\.html)"[^>]*>([^<]*)<\/a>/gi;
    let em;
    while ((em = epReg.exec(block))) {
      eps.push({ url: em[1], title: strip(em[3]) || ('第' + em[2] + '集') });
    }
    if (eps.length) sources.push({ name: routeMap[routeNum] || ('线路' + routeNum), episodes: eps });
  }

  // 3. 兜底
  if (!sources.length) {
    const epReg2 = /<a[^>]*href="(\/vodplay\/[0-9]+-[0-9]+-([0-9]+)\.html)"[^>]*>([^<]*)<\/a>/g;
    const eps = [];
    let m;
    while ((m = epReg2.exec(html))) eps.push({ url: m[1], title: strip(m[3]) || ('第' + m[2] + '集') });
    if (eps.length) sources.push({ name: '默认线路', episodes: eps });
  }

  if (playerData) sources._playerData = playerData;
  return sources;
}

// ========== 公共样式片段 ==========
const COMMON_STYLE = `
html,body{background:transparent!important;min-height:100vh}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;margin:0;padding:0;-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
.wrap{background:rgba(0,0,0,0);backdrop-filter:blur(2px);border-radius:16px;padding:14px;margin:12px;box-shadow:0 8px 30px rgba(0,0,0,0.3)}
input,textarea{-webkit-user-select:text;-moz-user-select:text;-ms-user-select:text;user-select:text}
`;

// ========== 公共禁止长按复制脚本 ==========
const COMMON_ANTI_COPY = `<script>document.addEventListener('contextmenu',function(e){e.preventDefault()},false);document.addEventListener('selectstart',function(e){e.preventDefault()},false);document.addEventListener('copy',function(e){e.preventDefault()},false);document.addEventListener('touchstart',function(e){if(e.touches.length>1)e.preventDefault()},{passive:false});document.addEventListener('gesturestart',function(e){e.preventDefault()},false);<\/script>`;

// ========== 首页数据API ==========
function handleHomeApi(res) {
  getActiveSource().home().then(result => {
    if (!result.ok) return send(res, 200, JSON.stringify({ok:false,error:result.error}));
    
    const sections = [];
    
    // Use inline video data from home API categories (no extra API calls needed)
    const categories = result.categories || [];
    categories.forEach(cat => {
      if (cat.videos && cat.videos.length) {
        sections.push({ title: cat.type_name, items: cat.videos.slice(0, 18) });
      }
    });
    
    if (!sections.length && result.items.length) {
      sections.push({ title: '热门推荐', items: result.items.slice(0, 18) });
    }
    
    const lunbos = result.lunbos || [];
    
    const sectionsHtml = sections.map(sec => {
      const cardsHtml = sec.items.map(it => {
        const imgSrc = esc(it.img);
        const title = esc(it.title);
        const desc = it.desc ? '<div class=\'crdr\'>' + esc(it.desc) + '</div>' : '';
        const tag = it.tag ? '<div class=\'crd-tag\'>' + esc(it.tag) + '</div>' : '';
        return '<div class=\'crd\' data-url=\'' + esc(it.url) + '\' data-title=\'' + title + '\' data-img=\'' + imgSrc + '\'>' +
          '<div style=\'position:relative\'><img src=\'' + imgSrc + '\' style=\'display:block;width:100%;height:160px;object-fit:cover\' onerror=\'this.src="https://picsum.photos/seed/"+Math.floor(Math.random()*1000)+"/300/400"\'>' + tag + '</div>' +
          '<div class=\'crdi\'><div class=\'crdn\'>' + title + '</div>' + desc + '</div></div>';
      }).join('');
      return { title: sec.title, html: cardsHtml };
    });
    
    send(res, 200, JSON.stringify({ok:true, lunbos, sectionsHtml}), 'application/json');
  }).catch(e => {
    send(res, 200, JSON.stringify({ok:false,error:e.message}));
  });
}
function categoryHtml(cid, name) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title>
<style>
${COMMON_STYLE}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.gr{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{background:rgba(255,255,255,.06);border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 32px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .15s,box-shadow .3s}.card:active{transform:scale(.97)}.poster{position:relative;overflow:hidden}.poster img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;min-height:120px;transition:transform .4s}.card:active .poster img{transform:scale(1.05)}.poster::after{content:'';position:absolute;bottom:0;left:0;right:0;height:40%;background:linear-gradient(transparent,rgba(0,0,0,.6));pointer-events:none}.badge{position:absolute;right:4px;top:4px;z-index:2;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);font-size:9px;color:#fff;border:1px solid rgba(255,255,255,.2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.section{margin-bottom:20px}.sec-title{font-size:16px;font-weight:700;padding:12px 4px 8px;color:#fff;display:flex;align-items:center;gap:6px}.sec-title::before{content:'';width:3px;height:16px;background:#4fc3f7;border-radius:2px;flex-shrink:0}.crd{background:rgba(255,255,255,.06);border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.12);cursor:pointer;transition:transform .15s}.crd:active{transform:scale(.97)}.crd-tag{position:absolute;right:4px;top:4px;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);font-size:9px;color:#fff;border:1px solid rgba(255,255,255,.2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crdi{padding:6px 4px;text-align:center;background:rgba(255,255,255,.06)}.crdn{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff}.crdr{font-size:10px;color:rgba(255,255,255,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.info{padding:6px 4px;text-align:center;background:rgba(255,255,255,.06)}
.name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.desc{font-size:10px;color:#ffd966;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
.btt{position:fixed;bottom:24px;right:16px;width:44px;height:44px;border-radius:50%;background:rgba(79,195,247,.45);color:#fff;font-size:22px;display:none;align-items:center;justify-content:center;cursor:pointer;z-index:200;border:1px solid rgba(79,195,247,.3);backdrop-filter:blur(6px)}
.btt:active{background:rgba(79,195,247,.7)}
.ftabs{display:flex;gap:8px;padding:0 0 12px 0;overflow-x:auto;-webkit-overflow-scrolling:touch;position:relative;z-index:10;will-change:transform}.ftabs::-webkit-scrollbar{display:none}
.ftab{flex-shrink:0;padding:5px 10px;border-radius:16px;font-size:13px;font-weight:600;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.15);cursor:pointer;transition:all .2s;white-space:nowrap;height:30px;line-height:20px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;position:relative;z-index:10}
.ftab.on{background:rgba(79,195,247,.25);border-color:rgba(79,195,247,.5);color:#4fc3f7}
.search-bar{display:none;gap:8px;padding:12px 0}
.search-bar input{flex:1;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:10px 14px;color:#fff;font-size:15px;outline:none}
.search-bar input::placeholder{color:rgba(255,255,255,.4)}
.search-bar button{flex-shrink:0;padding:0 18px;background:rgba(79,195,247,.2);border:1px solid rgba(79,195,247,.35);border-radius:12px;color:#4fc3f7;font-size:14px;font-weight:600;cursor:pointer}
.search-bar button:active{background:rgba(79,195,247,.35)}
.carousel{display:none;position:relative;width:100%;aspect-ratio:16/7;border-radius:14px;overflow:hidden;margin-bottom:14px;background:#111}
.carousel-inner{display:flex;transition:transform .35s ease;height:100%}
.carousel-item{flex:0 0 100%;height:100%;position:relative}
.carousel-item img{width:100%;height:100%;object-fit:cover}
.carousel-item .car-title{position:absolute;bottom:0;left:0;right:0;padding:30px 14px 12px;background:linear-gradient(transparent,rgba(0,0,0,.75));font-size:15px;font-weight:700;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.6)}
.carousel-dots{position:absolute;bottom:8px;right:12px;display:flex;gap:5px}
.carousel-dots .dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.4);transition:all .2s}
.carousel-dots .dot.on{background:#4fc3f7;width:16px;border-radius:3px}
@media(min-width:600px){.gr{grid-template-columns:repeat(4,1fr)}}
@media(min-width:900px){.gr{grid-template-columns:repeat(5,1fr)}}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap">
<div class="search-bar" id="searchBar"><input id="searchInput" placeholder="搜索影片..."><button id="searchBtn">搜索</button><button id="fsBtn" style="flex-shrink:0;padding:0 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:12px;color:#fff;font-size:16px;cursor:pointer">⛶</button></div>
<div class="carousel" id="carousel"><div class="carousel-inner" id="carInner"></div><div class="carousel-dots" id="carDots"></div></div>
<div class="ftabs" id="ftabs"></div>
<div class="ftabs" id="filterTabs" style="display:none"></div>
<div id="sections"></div>
<div class="gr" id="grid"></div>
<div class="tip" id="tip">准备加载...</div>
<div id="loadMore" style="display:none;text-align:center;padding:12px"><button onclick="load()" style="padding:8px 24px;border-radius:20px;background:rgba(79,195,247,.2);border:1px solid rgba(79,195,247,.35);color:#4fc3f7;font-size:14px;cursor:pointer">加载更多</button></div>
</div>
<script>
var _isBrowser=window.parent===window;
var baseCid=${JSON.stringify(cid)},cid=${JSON.stringify(cid)},curFilter='',page=0,loading=false,finished=false,count=0,filters=null;
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url)&&!item.url.startsWith('/api/'))item.url='http://'+item.url;if(!_isBrowser){try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}else{location.href='/tmdb-page?vodUrl='+encodeURIComponent(item.url)+'&title='+encodeURIComponent(item.title||'')+'&img='+encodeURIComponent(item.img||'')}}
function card(it){var d=document.createElement('div');d.className='card';var poster=document.createElement('div');poster.className='poster';var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';poster.appendChild(img);if(it.tag){var badge=document.createElement('span');badge.className='badge';badge.textContent=it.tag;poster.appendChild(badge)}d.appendChild(poster);var info=document.createElement('div');info.className='info';var name=document.createElement('div');name.className='name';name.textContent=it.title;info.appendChild(name);if(it.desc){var descEl=document.createElement('div');descEl.className='desc';descEl.textContent=it.desc;info.appendChild(descEl)}d.appendChild(info);d.onclick=function(){openVod(it)};return d}
/* 浏览器模式：显示搜索框+轮播+暗色背景 */
if(_isBrowser){
  var _bgStyle=document.createElement('style');_bgStyle.textContent='html,body{background:#0a0e1a!important}';document.head.appendChild(_bgStyle);
  var sb=el('#searchBar');sb.style.display='flex';
  el('#searchBtn').onclick=function(){var q=el('#searchInput').value.trim();if(q)location.href='/search?wd='+encodeURIComponent(q)};
  el('#searchInput').onkeydown=function(e){if(e.key==='Enter'){var q=this.value.trim();if(q)location.href='/search?wd='+encodeURIComponent(q)}};
  el('#fsBtn').onclick=function(){var de=document.documentElement;if(!document.fullscreenElement&&!document.webkitFullscreenElement){if(de.requestFullscreen)de.requestFullscreen();else if(de.webkitRequestFullscreen)de.webkitRequestFullscreen()}else{if(document.exitFullscreen)document.exitFullscreen();else if(document.webkitExitFullscreen)document.webkitExitFullscreen()}};
  if(cid===''){
  fetch('/home-api').then(function(r){return r.json()}).then(function(j){
    if(!j.ok||!j.lunbos||!j.lunbos.length)return;
    var lunbos=j.lunbos;var carEl=el('#carousel');var inner=el('#carInner');var dots=el('#carDots');
    var h='';var dh='';
    lunbos.forEach(function(b,i){h+='<div class="carousel-item"><img src="'+(b.img||'')+'" loading="lazy"><div class="car-title">'+(b.title||'')+'</div></div>';dh+='<div class="dot'+(i===0?' on':'')+'" data-i="'+i+'"></div>'});
    inner.innerHTML=h;dots.innerHTML=dh;carEl.style.display='block';
    var cur=0;var total=lunbos.length;
    function goTo(i){cur=(i+total)%total;inner.style.transform='translateX(-'+cur*100+'%)';dots.querySelectorAll('.dot').forEach(function(d,j){d.className='dot'+(j===cur?' on':'')})}
    carEl.onclick=function(){var item=lunbos[cur];if(item&&item.url)openVod(item)};
    var sx=0;carEl.ontouchstart=function(e){sx=e.changedTouches[0].screenX};carEl.ontouchend=function(e){var dx=sx-e.changedTouches[0].screenX;if(Math.abs(dx)>30){if(dx>0)goTo(cur+1);else goTo(cur-1)}};
    setInterval(function(){goTo(cur+1)},4000);
    // Render category sections
    if(j.sectionsHtml&&j.sectionsHtml.length){
      var secContainer=el('#sections');
      secContainer.innerHTML='';
      j.sectionsHtml.forEach(function(sec){
        var section=document.createElement('div');
        section.className='section';
        var titleEl=document.createElement('div');
        titleEl.className='sec-title';
        titleEl.innerHTML='<span>'+sec.title+'</span>';
        section.appendChild(titleEl);
        var grid=document.createElement('div');
        grid.className='gr';
        grid.innerHTML=sec.html;
        // Add click handlers
        grid.querySelectorAll('.crd').forEach(function(c){
          c.onclick=function(){openVod({url:this.dataset.url,title:this.dataset.title,img:this.dataset.img})}
        });
        section.appendChild(grid);
        secContainer.appendChild(section);
      });
      el('#grid').style.display='none';
      el('#tip').style.display='none';
    }
  }).catch(function(){});
  } // end if cid===''
  else {
    // Category page - make sure grid and tip are visible
    el('#grid').style.display='';
    el('#tip').style.display='';
  }
}
/* 分类导航 */
var navCats=[{name:'首页',cid:''},{name:'电影',cid:'dianying'},{name:'剧集',cid:'2'},{name:'综艺',cid:'zongyi'},{name:'动漫',cid:'dongman'},{name:'排行榜',cid:'_rank'}];
if(!_isBrowser){el('#ftabs').style.display='none'}else{
var navHtml='';
navCats.forEach(function(c){var isCur=c.cid===baseCid;navHtml+='<a href="/category?cid='+c.cid+'&name='+encodeURIComponent(c.name)+'" style="flex-shrink:0;padding:6px 16px;border-radius:20px;font-size:13px;font-weight:600;background:'+(isCur?'rgba(79,195,247,.25)':'rgba(255,255,255,.08)')+';border:1px solid '+(isCur?'rgba(79,195,247,.5)':'rgba(255,255,255,.12)')+';color:'+(isCur?'#4fc3f7':'rgba(255,255,255,.7)')+';cursor:pointer;text-decoration:none;white-space:nowrap">'+c.name+'</a>'});
el('#ftabs').innerHTML=navHtml;
}
/* 加载分类数据 */
function load(){
  if(cid==='_rank'){location.href='/rank';return}
  if(loading||finished)return;loading=true;
  var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';
  fetch('/api?cid='+cid+'&filter='+encodeURIComponent(curFilter)+'&page='+next).then(r=>r.json()).then(j=>{
    if(!j.ok)throw new Error(j.error||'load failed');
    if(next===1&&j.filters&&j.filters.length){filters=j.filters;renderFilters();}
    if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已全部加载 —':'— 暂无内容 —';return}
    page=next;
    j.items.forEach(function(it){el('#grid').appendChild(card(it));count++});
    el('#tip').textContent='已加载 '+count+' 部。';
  }).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)}).finally(function(){loading=false;var btn=el('#loadMore');if(btn)btn.style.display=finished?'none':'block'});
}
function renderFilters(){
  var c=el('#filterTabs');
  if(!filters||!filters.length){c.style.display='none';return}
  c.style.display='flex';
  var html2='';
  filters.forEach(function(f){html2+='<div class="ftab'+(curFilter===f.slug?' on':'')+'" data-slug="'+f.slug+'">'+f.name+'</div>'});
  c.innerHTML=html2;
  c.querySelectorAll('.ftab').forEach(function(b){b.onclick=function(){selectFilter(this.dataset.slug)}});
}
function selectFilter(slug){
  if(curFilter===slug)return;curFilter=slug;page=0;finished=false;count=0;loading=false;
  el('#grid').innerHTML='';el('#tip').textContent='正在加载...';renderFilters();load();window.scrollTo(0,0);
}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
var btt=document.createElement('div');btt.className='btt';btt.textContent='↑';
btt.onclick=function(){window.scrollTo({top:0,behavior:'smooth'})};
document.body.appendChild(btt);
window.addEventListener('scroll',function(){btt.style.display=window.scrollY>400?'flex':'none'});
<\/script></body></html>`;
}

// ========== 最新页HTML ==========
function latestHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>今日更新</title>
<style>
${COMMON_STYLE}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.tabs{display:flex;gap:8px;padding:0 0 12px 0;overflow-x:auto;-webkit-overflow-scrolling:touch}.tabs::-webkit-scrollbar{display:none}
.tab{flex-shrink:0;padding:6px 16px;border-radius:20px;font-size:13px;font-weight:600;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.15);cursor:pointer;transition:all .2s;white-space:nowrap}
.tab.on{background:rgba(255,255,255,.3);border-color:rgba(255,255,255,.4)}
.gr{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{background:rgba(255,255,255,.06);border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 32px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .15s,box-shadow .3s}
.card:active{transform:scale(.97)}
.poster{position:relative;overflow:hidden}
.poster img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;min-height:120px}
.poster::after{content:'';position:absolute;bottom:0;left:0;right:0;height:40%;background:linear-gradient(transparent,rgba(0,0,0,.6));pointer-events:none}
.badge{position:absolute;right:4px;top:4px;z-index:2;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);font-size:9px;color:#fff;border:1px solid rgba(255,255,255,.2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.info{padding:6px 4px;text-align:center;background:rgba(255,255,255,.06)}
.name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list,#list{display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:12px;background:rgba(255,255,255,.06);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s}
.row:active{transform:scale(.98)}
.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}
.sposter img{width:100%;height:100%;object-fit:cover;display:block}
.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}
.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;padding:0}
.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;line-height:1.3}
.sintro{font-size:12px;color:rgba(255,255,255,.7);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:auto 0;min-height:0}
.smeta{font-size:11px;color:rgba(255,255,255,.55);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;margin-top:auto;padding-top:2px}
.sactors{font-size:12px;color:rgba(255,193,112,.85);line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px;flex-shrink:0}
.sbottom{display:flex;align-items:center;gap:8px;margin-top:6px;flex-shrink:0;font-size:11px;color:rgba(255,255,255,.45);line-height:1.3}.sbottom-item{display:flex;align-items:center;gap:3px}.sbottom-sep{color:rgba(255,255,255,.2)}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
@media(min-width:600px){.gr{grid-template-columns:repeat(4,1fr)}}
@media(min-width:900px){.gr{grid-template-columns:repeat(5,1fr)}}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap"><div class="tabs" id="tabs"></div><div id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var tabs=[{name:'今日更新',tab:0},{name:'新片上线',tab:1}];
var curTab=0,page=0,loading=false,finished=false,count=0,reqId=0;
function el(s){return document.querySelector(s)}
function initTabs(){var c=document.getElementById('tabs');tabs.forEach(function(t,i){var b=document.createElement('div');b.className='tab'+(i===0?' on':'');b.textContent=t.name;b.onclick=function(){document.querySelectorAll('.tab').forEach(function(x){x.className='tab'});b.className='tab on';curTab=t.tab;page=0;finished=false;count=0;loading=false;reqId++;el('#list').innerHTML='';load()};c.appendChild(b)})}
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url)&&!item.url.startsWith('/api/'))item.url='http://'+item.url;if(window.parent!==window){try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}else{location.href='/tmdb-page?vodUrl='+encodeURIComponent(item.url)+'&title='+encodeURIComponent(item.title||'')+'&img='+encodeURIComponent(item.img||'')}}
function pCard(it){var d=document.createElement('div');d.className='card';var poster=document.createElement('div');poster.className='poster';var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';poster.appendChild(img);if(it.tag){var badge=document.createElement('span');badge.className='badge';badge.textContent=it.tag;poster.appendChild(badge)}d.appendChild(poster);var info=document.createElement('div');info.className='info';var name=document.createElement('div');name.className='name';name.textContent=it.title;info.appendChild(name);d.appendChild(info);img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'};d.onclick=function(){openVod(it)};return d}
function cRow(it){var d=document.createElement('div');d.className='row';var sposter=document.createElement('div');sposter.className='sposter';var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';sposter.appendChild(img);if(it.top){var topEl=document.createElement('span');topEl.style.cssText='position:absolute;top:4px;left:4px;z-index:2;background:rgba(255,71,87,.85);color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px';topEl.textContent=it.top;sposter.appendChild(topEl)}if(it.note){var noteEl=document.createElement('span');noteEl.className='sptext';noteEl.textContent=it.note;sposter.appendChild(noteEl)}d.appendChild(sposter);var sinfo=document.createElement('div');sinfo.className='sinfo';var sname=document.createElement('div');sname.className='sname';sname.textContent=it.title;sinfo.appendChild(sname);if(it.actors){var sactors=document.createElement('div');sactors.className='sactors';sactors.textContent='\u{1F916} '+it.actors;sinfo.appendChild(sactors)}if(it.intro){var sintro=document.createElement('div');sintro.className='sintro';sintro.textContent=it.intro;sinfo.appendChild(sintro)}var parts=[];if(it.infoTime)parts.push(it.infoTime);if(it.score)parts.push('\u2B50 '+it.score);if(it.hits)parts.push('\uD83D\uDD25 '+it.hits);if(it.meta)parts.push(it.meta);if(parts.length){var sbottom=document.createElement('div');sbottom.className='sbottom';sbottom.innerHTML=parts.map(function(p){return'<span class="sbottom-item">'+p+'</span>'}).join('<span class="sbottom-sep"> | </span>');sinfo.appendChild(sbottom)}d.appendChild(sinfo);img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'};d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished)return;loading=true;var rid=reqId,next=page+1;el('#tip').textContent='加载中...';fetch('/latest-api?page='+next+'&tab='+curTab).then(r=>r.json()).then(function(j){if(!j.ok)throw new Error(j.error||'fail');if(!j.items.length){finished=true;el('#tip').textContent=count?'已全部加载':'暂无数据';return}if(rid!==reqId)return;page=next;var list=el('#list');if(curTab===0&&!count){var g=document.createElement('div');g.className='gr';g.id='pg';list.appendChild(g)}j.items.forEach(function(it){count++;if(curTab===0){var pg=document.getElementById('pg');if(pg)pg.appendChild(pCard(it))}else{list.appendChild(cRow(it))}});el('#tip').textContent='已加载 '+count+' 部';}).catch(function(e){if(rid!==reqId)return;loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败</span>'})}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));initTabs();load();
<\/script></body></html>`;
}

// ========== 排行页HTML ==========
function rankHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>热搜榜</title>
<style>
html,body{background:#0a0e1a!important;min-height:100vh}
${COMMON_STYLE}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.tabs{display:flex;gap:8px;padding:0 0 12px 0;overflow-x:auto;-webkit-overflow-scrolling:touch}.tabs::-webkit-scrollbar{display:none}
.tab{flex-shrink:0;padding:6px 16px;border-radius:20px;font-size:13px;font-weight:600;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.15);cursor:pointer;transition:all .2s;white-space:nowrap}
.tab.on{background:rgba(255,255,255,.3);border-color:rgba(255,255,255,.4)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.cat-card{background:rgba(255,255,255,.06);border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:12px}
.cat-name{text-align:center;font-size:15px;font-weight:700;color:#4fc3f7;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.1)}
.rit{display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer}
.rit:active{opacity:.7}
.rn{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;flex-shrink:0;background:rgba(255,255,255,.15)}
.rn.t1{background:#FF4757}.rn.t2{background:#FF6B81}.rn.t3{background:#FFA502}
.rt{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.rs{font-size:10px;color:rgba(255,255,255,.4);flex-shrink:0}
.row{display:flex;gap:12px;background:rgba(255,255,255,.06);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;margin-bottom:10px;cursor:pointer;height:170px}
.row:active{transform:scale(.98)}
.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}
.sposter img{width:100%;height:100%;object-fit:cover;display:block}
.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;padding:0;overflow:hidden}
.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;line-height:1.3}
.sactors{font-size:12px;color:rgba(255,193,112,.85);line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;margin-top:4px;min-height:17px}
.sintro{font-size:11px;color:rgba(255,255,255,.55);line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;flex:1;min-height:0;margin-top:4px}
.sbottom{display:flex;align-items:center;gap:8px;flex-shrink:0;font-size:11px;color:rgba(255,255,255,.45);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}.sbottom-item{display:flex;align-items:center;gap:3px}.sbottom-sep{color:rgba(255,255,255,.2)}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.7);font-size:13px}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap"><div class="tabs" id="tabs"></div><div id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var tabs=[{name:'分类排行',tab:0},{name:'全部影片',tab:1}];
var curTab=0,page=0,loading=false,finished=false,count=0,reqId=0;
var _detailCache={};
function el(s){return document.querySelector(s)}
function initTabs(){var c=document.getElementById('tabs');tabs.forEach(function(t,i){var b=document.createElement('div');b.className='tab'+(i===0?' on':'');b.textContent=t.name;b.onclick=function(){document.querySelectorAll('.tab').forEach(function(x){x.className='tab'});b.className='tab on';curTab=t.tab;page=0;finished=false;count=0;loading=false;reqId++;el('#list').innerHTML='';load()};c.appendChild(b)})}
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url)&&!item.url.startsWith('/api/'))item.url='http://'+item.url;if(window.parent!==window){try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}else{location.href='/tmdb-page?vodUrl='+encodeURIComponent(item.url)+'&title='+encodeURIComponent(item.title||'')+'&img='+encodeURIComponent(item.img||'')}}
function getVodId(it){var m=(it.url||'').match(/vod_id=(\\d+)/);return m?m[1]:''}
function cRow(it){var d=document.createElement('div');d.className='row';var topColors={'1':'rgba(255,71,87,.9)','2':'rgba(255,107,129,.9)','3':'rgba(255,165,2,.9)'};var topN=parseInt(it.top);var topBg=topColors[it.top]||(topN>=4?'rgba(255,255,255,.18)':'rgba(255,71,87,.9)');var sposter=document.createElement('div');sposter.className='sposter';var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'};sposter.appendChild(img);if(it.top){var topEl=document.createElement('span');topEl.style.cssText='position:absolute;top:4px;left:4px;z-index:2;background:'+topBg+';color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px';topEl.textContent=it.top;sposter.appendChild(topEl)}if(it.note){var noteEl=document.createElement('span');noteEl.style.cssText='position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)';noteEl.textContent=it.note;sposter.appendChild(noteEl)}d.appendChild(sposter);var sinfo=document.createElement('div');sinfo.className='sinfo';var sname=document.createElement('div');sname.className='sname';sname.textContent=it.title;sinfo.appendChild(sname);var sactors=document.createElement('div');sactors.className='sactors';sactors.textContent='';sinfo.appendChild(sactors);var sintro=document.createElement('div');sintro.className='sintro';sinfo.appendChild(sintro);var parts=[];if(it.catTitle)parts.push(it.catTitle);if(it.year)parts.push(it.year);if(it.area)parts.push(it.area);if(parts.length){var sbottom=document.createElement('div');sbottom.className='sbottom';sbottom.innerHTML=parts.map(function(p){return'<span class="sbottom-item">'+p+'</span>'}).join('<span class="sbottom-sep"> | </span>');sinfo.appendChild(sbottom)}d.appendChild(sinfo);d.onclick=function(){openVod(it)};d._vid=getVodId(it);d._sactors=sactors;d._sintro=sintro;var _cv=d._vid;if(_cv&&_detailCache[_cv]){var _cj=_detailCache[_cv];if(_cj.actors)sactors.textContent='\\u{1F916} '+_cj.actors;if(_cj.content)sintro.textContent=_cj.content}return d}
// tab=1 全部影片：列表渲染后渐进式加载每个影片的演员和简介
function loadAllDetails(items){
  var queue=[];
  items.forEach(function(it){var vid=getVodId(it);if(vid&&(!_detailCache[vid]))queue.push({vid:vid,it:it})});
  var idx=0,BATCH=4;
  function next(){
    if(idx>=queue.length)return;
    var batch=queue.slice(idx,idx+BATCH);idx+=BATCH;
    batch.forEach(function(q){
      fetch('/rank-detail-api?vod_id='+q.vid).then(function(r){return r.json()}).then(function(j){
        if(!j.ok)return;
        _detailCache[q.vid]=j;
        var rows=el('#list').querySelectorAll('.row');
        rows.forEach(function(row){if(row._vid===q.vid){
          if(j.actors)row._sactors.textContent='\\u{1F916} '+j.actors;
          if(j.content)row._sintro.textContent=j.content;
        }});
      }).catch(function(){});
    });
    setTimeout(next,300);
  }
  next();
}
function load(){if(loading||finished)return;loading=true;var rid=reqId,next=page+1;el('#tip').textContent='加载中...';fetch('/rank-api?page='+next+'&tab='+curTab).then(r=>r.json()).then(function(j){if(!j.ok)throw new Error(j.error||'fail');if(rid!==reqId)return;page=next;if(j.finished)finished=true;if(!j.items.length){finished=true;el('#tip').textContent=count?'已全部加载':'暂无数据';loading=false;return}var list=el('#list');if(curTab===0){var grid=list.querySelector('.grid2');if(!count){grid=document.createElement('div');grid.className='grid2';list.appendChild(grid)}var cats={};j.items.forEach(function(it){var cat=it.catTitle||'';if(!cats[cat])cats[cat]=[];cats[cat].push(it)});Object.keys(cats).forEach(function(cat){var card=document.createElement('div');card.className='cat-card';var catNameEl=document.createElement('div');catNameEl.className='cat-name';catNameEl.textContent=cat;card.appendChild(catNameEl);cats[cat].slice(0,10).forEach(function(it){var r=document.createElement('div');r.className='rit';var n=parseInt(it.tag)||1;var rn=document.createElement('div');rn.className='rn '+(n<=3?'t'+n:'');rn.textContent=n;r.appendChild(rn);var rt=document.createElement('div');rt.className='rt';rt.textContent=it.title;r.appendChild(rt);if(it.desc){var rs=document.createElement('div');rs.className='rs';rs.textContent=it.desc;r.appendChild(rs)}r.onclick=function(){openVod(it)};card.appendChild(r)});grid.appendChild(card)})}else{j.items.forEach(function(it){list.appendChild(cRow(it));count++})}count+=j.items.length;el('#tip').textContent=finished?'已全部加载（共'+count+'部）':'已加载 '+count+' 部';loading=false;if(curTab===1&&next===1){loadAllDetails(j.items)}}).catch(function(e){if(rid!==reqId)return;loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败：'+(e.message||e)+'</span><br><button onclick="loading=false;load()" style="margin-top:8px;padding:6px 16px;border-radius:8px;border:0;background:rgba(255,255,255,.2);color:#fff;cursor:pointer">重试</button>'})}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));initTabs();load();
<\/script></body></html>`;
}

// ========== 专题页HTML ==========
function topicHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>专题</title>
<style>
${COMMON_STYLE}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:14px}
.card{position:relative;border-radius:14px;overflow:hidden;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 32px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .15s;cursor:pointer}.card:active{transform:scale(.98)}
.card img{width:100%;height:180px;object-fit:cover;display:block}
.card-overlay{position:absolute;bottom:0;left:0;right:0;padding:14px 16px 12px;background:linear-gradient(transparent,rgba(0,0,0,.6));backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:space-between}
.card-title{font-size:17px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.card-count{font-size:12px;color:rgba(255,255,255,.75);background:rgba(255,255,255,.15);border-radius:10px;padding:2px 10px;flex-shrink:0;margin-left:8px}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap"><div class="title" id="title">📋 专题（0个）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var page=0,loading=false,finished=false,count=0;
function el(s){return document.querySelector(s)}
function openTopic(it){location.href='/topic-detail?url='+encodeURIComponent(it.url)+'&title='+encodeURIComponent(it.title)}
function row(it){var d=document.createElement('div');d.className='card';var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/600/300'};d.appendChild(img);var overlay=document.createElement('div');overlay.className='card-overlay';var title=document.createElement('div');title.className='card-title';title.textContent=it.title;overlay.appendChild(title);if(it.tag){var count=document.createElement('div');count.className='card-count';count.textContent=it.tag;overlay.appendChild(count)}d.appendChild(overlay);d.onclick=function(){openTopic(it)};return d}
function load(){if(loading||finished)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/topic-api?page='+next).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'暂无数据';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#title').textContent='📋 专题（'+count+'个）';el('#tip').textContent='已加载 '+count+' 个。'}).catch(e=>{loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败：'+(e.message||e)+'</span><br><button onclick="loading=false;load()" style="margin-top:8px;padding:6px 16px;border-radius:8px;border:0;background:rgba(255,255,255,.2);color:#fff;cursor:pointer">重试</button>'})}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
<\/script></body></html>`;
}

// ========== 专题详情页HTML ==========
function topicDetailHtml(topicUrl, topicTitle) {
  // XSS 修复：用 JSON.stringify 而非手动转义单引号
  const safeUrl = JSON.stringify(topicUrl);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(topicTitle)}</title>
<style>
${COMMON_STYLE}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.topbar{display:flex;align-items:center;padding:4px 0 10px;gap:10px}.back{background:rgba(0,0,0,.4);backdrop-filter:blur(8px);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}.toptitle{font-size:16px;font-weight:700}
.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px;background:rgba(255,255,255,.06);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sactors{font-size:12px;color:rgba(255,193,112,.85);line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px;flex-shrink:0}.smeta{font-size:12px;color:rgba(255,255,255,.7);margin-top:6px;line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}.sbottom{display:flex;align-items:center;gap:8px;margin-top:6px;flex-shrink:0;font-size:11px;color:rgba(255,255,255,.45);line-height:1.3}.sbottom-item{display:flex;align-items:center;gap:3px}.sbottom-sep{color:rgba(255,255,255,.2)}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap"><div class="topbar"><button class="back" onclick="history.back()">←</button><div class="toptitle">${esc(topicTitle)}</div></div><div class="title" id="title">${esc(topicTitle)}（0部）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var page=0,loading=false,finished=false,count=0;
var topicUrl=${safeUrl};
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url)&&!item.url.startsWith('/api/'))item.url='http://'+item.url;if(window.parent!==window){try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}else{location.href='/tmdb-page?vodUrl='+encodeURIComponent(item.url)+'&title='+encodeURIComponent(item.title||'')+'&img='+encodeURIComponent(item.img||'')}}
function row(it){var d=document.createElement('div');d.className='row';var sposter=document.createElement('div');sposter.className='sposter';var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';sposter.appendChild(img);if(it.tag){var tagEl=document.createElement('span');tagEl.className='sptext';tagEl.textContent=it.tag;sposter.appendChild(tagEl)}d.appendChild(sposter);var sinfo=document.createElement('div');sinfo.className='sinfo';var sname=document.createElement('div');sname.className='sname';sname.textContent=it.title;sinfo.appendChild(sname);if(it.actors){var sactors=document.createElement('div');sactors.className='sactors';sactors.textContent='\u{1F916} '+it.actors;sinfo.appendChild(sactors)}if(it.desc){var smeta=document.createElement('div');smeta.className='smeta';smeta.style.cssText='-webkit-line-clamp:5';smeta.textContent=it.desc;sinfo.appendChild(smeta)}d.appendChild(sinfo);img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'};d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/topic-detail-api?page='+next+'&url='+encodeURIComponent(topicUrl)).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'暂无数据';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#title').textContent=${JSON.stringify(esc(topicTitle))}+'（'+count+'部）';el('#tip').textContent='已加载 '+count+' 部。'}).catch(e=>{loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败：'+(e.message||e)+'</span><br><button onclick="loading=false;load()" style="margin-top:8px;padding:6px 16px;border-radius:8px;border:0;background:rgba(255,255,255,.2);color:#fff;cursor:pointer">重试</button>'})}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
<\/script></body></html>`;
}

// ========== 收藏页HTML ==========
function favoritesHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的收藏</title>
<style>
${COMMON_STYLE}
html,body{background:transparent!important}
.futuristic-pattern{position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;background:linear-gradient(145deg,rgba(169,140,76,.95),rgba(108,149,214,.95),rgba(124,43,117,.95));filter:url(#advanced-texture);pointer-events:none}
.texture-filter{position:absolute;width:0;height:0;overflow:visible}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:4px 0 10px;gap:10px}.back{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);box-shadow:0 2px 12px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1);color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}.back:active{background:rgba(255,255,255,.2);transform:scale(.92)}.toptitle{font-size:16px;font-weight:700}
.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:12px;background:rgba(255,255,255,.06);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s;position:relative}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 80px;width:80px;height:110px;border-radius:12px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}
.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}
.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.smeta{font-size:12px;color:rgba(255,255,255,.7);margin-top:6px}
.delbtn{position:absolute;top:8px;right:8px;background:rgba(255,71,87,.8);border:0;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s}
.row:hover .delbtn,.row:active .delbtn{opacity:1}
.clearbtn{background:rgba(255,71,87,.2);border:1px solid rgba(255,71,87,.4);color:#ff4757;padding:4px 12px;border-radius:16px;font-size:12px;cursor:pointer}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>${COMMON_ANTI_COPY}
<div class="futuristic-pattern"><svg class="texture-filter"><filter id="advanced-texture"><feTurbulence result="noise" numOctaves="3" baseFrequency="0.7" type="fractalNoise"/><feSpecularLighting result="specular" lighting-color="#fff" specularExponent="20" specularConstant="0.8" surfaceScale="2" in="noise"><fePointLight z="100" y="50" x="50"/></feSpecularLighting><feComposite result="litNoise" operator="in" in2="SourceGraphic" in="specular"/><feBlend mode="overlay" in2="litNoise" in="SourceGraphic"/></filter></svg></div>
<div class="wrap"><div class="topbar"><div style="display:flex;align-items:center;gap:10px"><button class="back" onclick="history.back()">←</button><div class="toptitle">❤️ 我的收藏</div></div><button class="clearbtn" onclick="if(confirm('确定清空所有收藏？')){fetch('/fav-clear',{method:'POST'}).then(()=>load())}">清空</button></div><div class="list" id="list"></div><div class="tip" id="tip">加载中...</div></div>
<script>
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url)&&!item.url.startsWith('/api/'))item.url='http://'+item.url;if(window.parent!==window){try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}else{location.href='/tmdb-page?vodUrl='+encodeURIComponent(item.url)+'&title='+encodeURIComponent(item.title||'')+'&img='+encodeURIComponent(item.img||'')}}
function load(){
  fetch('/fav-list').then(r=>r.json()).then(j=>{
    if(!j.ok||!j.items.length){el('#list').innerHTML='';el('#tip').textContent='暂无收藏，快去收藏喜欢的影片吧 ❤️';return}
    el('#list').innerHTML='';
    j.items.forEach(function(it){
      var d=document.createElement('div');d.className='row';
      var sposter=document.createElement('div');sposter.className='sposter';
      var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';sposter.appendChild(img);
      sposter.onclick=function(){openVod(it)};
      d.appendChild(sposter);
      var sinfo=document.createElement('div');sinfo.className='sinfo';
      var sname=document.createElement('div');sname.className='sname';sname.textContent=it.title;
      sname.onclick=function(){openVod(it)};
      sinfo.appendChild(sname);
      var smeta=document.createElement('div');smeta.className='smeta';smeta.textContent=new Date(it.addedAt).toLocaleDateString();
      sinfo.appendChild(smeta);
      d.appendChild(sinfo);
      var delbtn=document.createElement('button');delbtn.className='delbtn';delbtn.textContent='✕';
      delbtn.onclick=function(e){e.stopPropagation();fetch('/fav-remove?id='+encodeURIComponent(it.id),{method:'POST'}).then(()=>load())};
      d.appendChild(delbtn);
      el('#list').appendChild(d);
    });
    el('#tip').textContent='共 '+j.items.length+' 部收藏';
  }).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)})
}
load();
<\/script></body></html>`;
}

// ========== 历史页HTML ==========
function historyHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>观看历史</title>
<style>
${COMMON_STYLE}
html,body{background:transparent!important}
.futuristic-pattern{position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;background:linear-gradient(145deg,rgba(169,140,76,.95),rgba(108,149,214,.95),rgba(124,43,117,.95));filter:url(#advanced-texture);pointer-events:none}
.texture-filter{position:absolute;width:0;height:0;overflow:visible}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:4px 0 10px;gap:10px}.back{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);box-shadow:0 2px 12px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1);color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}.back:active{background:rgba(255,255,255,.2);transform:scale(.92)}.toptitle{font-size:16px;font-weight:700}
.clearbtn{background:rgba(255,71,87,.2);border:1px solid rgba(255,71,87,.4);color:#ff4757;padding:4px 12px;border-radius:16px;font-size:12px;cursor:pointer}
.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:12px;background:rgba(255,255,255,.06);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s;position:relative}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 80px;width:80px;height:110px;border-radius:12px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}
.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}
.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.smeta{font-size:12px;color:rgba(255,255,255,.7);margin-top:4px}
.sepi{font-size:12px;color:rgba(255,193,112,.85);margin-top:4px}
.prog-bar{margin-top:6px;height:4px;background:rgba(255,255,255,.15);border-radius:2px;overflow:hidden}
.prog-fill{height:100%;background:#4fc3f7;border-radius:2px}
.prog-text{font-size:11px;color:rgba(255,255,255,.5);margin-top:3px}
.delbtn{position:absolute;top:8px;right:8px;background:rgba(255,71,87,.8);border:0;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s}
.row:hover .delbtn,.row:active .delbtn,.row.show-del .delbtn{opacity:1}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>${COMMON_ANTI_COPY}
<div class="futuristic-pattern"><svg class="texture-filter"><filter id="advanced-texture"><feTurbulence result="noise" numOctaves="3" baseFrequency="0.7" type="fractalNoise"/><feSpecularLighting result="specular" lighting-color="#fff" specularExponent="20" specularConstant="0.8" surfaceScale="2" in="noise"><fePointLight z="100" y="50" x="50"/></feSpecularLighting><feComposite result="litNoise" operator="in" in2="SourceGraphic" in="specular"/><feBlend mode="overlay" in2="litNoise" in="SourceGraphic"/></filter></svg></div>
<div class="wrap"><div class="topbar"><div style="display:flex;align-items:center;gap:10px"><button class="back" onclick="history.back()">←</button><div class="toptitle">🕐 观看历史</div></div><button class="clearbtn" onclick="if(confirm('确定清空所有历史？')){fetch('/his-clear',{method:'POST'}).then(()=>load())}">清空</button></div><div class="list" id="list"></div><div class="tip" id="tip">加载中...</div></div>
<script>
function el(s){return document.querySelector(s)}
var SITE='https://ds3xy2yunsa.xyz';
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url)&&!item.url.startsWith('/api/'))item.url='http://'+item.url;if(item.playUrl){var _pu=item.playUrl;if(_pu.charAt(0)==='/')_pu=SITE+_pu;try{parent.postMessage({type:'dsjHideChrome'},'*')}catch(e){}location.href='/player?url='+encodeURIComponent(_pu)+'&title='+encodeURIComponent(item.title||'')+'&vod='+encodeURIComponent(item.url||'')+'&img='+encodeURIComponent(item.img||'');return}if(item.url){fetch('/api/parse-play?url='+encodeURIComponent(item.url)).then(function(r){return r.json()}).then(function(j){if(j.ok&&j.sources&&j.sources[0]&&j.sources[0].episodes&&j.sources[0].episodes.length){var ep=j.sources[0].episodes[0];var u=ep.url.charAt(0)==='/'?SITE+ep.url:ep.url;try{parent.postMessage({type:'dsjHideChrome'},'*')}catch(e){}location.href='/player?url='+encodeURIComponent(u)+'&title='+encodeURIComponent(item.title||ep.title||'')+'&vod='+encodeURIComponent(item.url||'')+'&img='+encodeURIComponent(item.img||'')}else{if(window.parent!==window){try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}else{location.href='/tmdb-page?vodUrl='+encodeURIComponent(item.url)+'&title='+encodeURIComponent(item.title||'')+'&img='+encodeURIComponent(item.img||'')}}}).catch(function(){if(window.parent!==window){try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}else{location.href='/tmdb-page?vodUrl='+encodeURIComponent(item.url)+'&title='+encodeURIComponent(item.title||'')+'&img='+encodeURIComponent(item.img||'')}});return}if(window.parent!==window){try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}else{location.href='/tmdb-page?vodUrl='+encodeURIComponent(item.url)+'&title='+encodeURIComponent(item.title||'')+'&img='+encodeURIComponent(item.img||'')}}
function timeAgo(ts){var d=Date.now()-ts;if(d<60000)return'刚刚';if(d<3600000)return Math.floor(d/60000)+'分钟前';if(d<86400000)return Math.floor(d/3600000)+'小时前';if(d<604800000)return Math.floor(d/86400000)+'天前';return new Date(ts).toLocaleDateString()}
function load(){
  fetch('/his-list').then(r=>r.json()).then(j=>{
    var _sn=j.sourceName||'';
    var _tt=el('.toptitle');if(_tt&&_sn)_tt.textContent='🕐 观看历史 · '+_sn;
    if(!j.ok||!j.items.length){el('#list').innerHTML='';el('#tip').textContent=_sn?'「'+_sn+'」暂无观看历史 🎬':'暂无观看历史 🎬';return}
    el('#list').innerHTML='';
    j.items.forEach(function(it){
      var d=document.createElement('div');d.className='row';
      var sposter=document.createElement('div');sposter.className='sposter';
      var img=document.createElement('img');img.loading='lazy';var _ph='https://picsum.photos/seed/'+(it.id||Math.floor(Math.random()*1000))+'/300/400';img.src=it.img||_ph;img.onerror=function(){this.src=_ph};sposter.appendChild(img);
      sposter.onclick=function(){openVod(it)};
      d.appendChild(sposter);
      var sinfo=document.createElement('div');sinfo.className='sinfo';
      var sname=document.createElement('div');sname.className='sname';sname.textContent=it.title||it.playUrl||it.url||'(未知)';
      sname.onclick=function(){openVod(it)};
      sinfo.appendChild(sname);
      if(it.episode||it.lineName){var sepi=document.createElement('div');sepi.className='sepi';var _epText='▶';if(it.lineName)_epText+=' '+it.lineName;if(it.episode)_epText+=' '+it.episode;sepi.textContent=_epText;sinfo.appendChild(sepi)}
      if(it.progress&&it.duration&&it.duration>0){var pb=document.createElement('div');pb.className='prog-bar';var pf=document.createElement('div');pf.className='prog-fill';pf.style.width=Math.min(100,Math.round(it.progress/it.duration*100))+'%';pb.appendChild(pf);sinfo.appendChild(pb);var pt=document.createElement('div');pt.className='prog-text';pt.textContent=Math.floor(it.progress/60)+'分'+Math.floor(it.progress%60)+'秒 / '+Math.floor(it.duration/60)+'分'+Math.floor(it.duration%60)+'秒';sinfo.appendChild(pt)}
      var smeta=document.createElement('div');smeta.className='smeta';smeta.textContent=timeAgo(it.lastWatch);
      sinfo.appendChild(smeta);
      d.appendChild(sinfo);
      var delbtn=document.createElement('button');delbtn.className='delbtn';delbtn.textContent='✕';
      delbtn.onclick=function(e){e.stopPropagation();if(confirm('确定删除这条历史记录吗？')){fetch('/his-remove?id='+encodeURIComponent(it.id),{method:'POST'}).then(()=>load())}};
      d.appendChild(delbtn);
      var longPressTimer=null;
      d.addEventListener('touchstart',function(e){longPressTimer=setTimeout(function(){d.classList.toggle('show-del');longPressTimer=null},600)});
      d.addEventListener('touchend',function(){if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null}});
      d.addEventListener('touchmove',function(){if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null}});
      el('#list').appendChild(d);
    });
    el('#tip').textContent='共 '+j.items.length+' 条记录';
  }).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)})
}
load();
<\/script></body></html>`;
}

// ========== 搜索页HTML ==========
function searchHtml(wd) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>搜索 ${esc(wd)}</title>
<style>
${COMMON_STYLE}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.title{display:flex;align-items:center;justify-content:space-between;font-size:18px;font-weight:700;margin:4px 0 14px;min-height:36px}.title-text{flex:1;min-width:0}.title .back{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);box-shadow:0 2px 12px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1);color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0}.title .back:active{background:rgba(255,255,255,.2);transform:scale(.92)}.list{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px;background:rgba(255,255,255,.06);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;padding:0}.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;line-height:1.3}.sactors{font-size:12px;color:rgba(255,193,112,.85);line-height:1.4;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin-top:4px;flex:1;min-height:0}.smeta{font-size:11px;color:rgba(255,255,255,.55);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;margin-top:auto;padding-top:2px}.sbottom{display:flex;align-items:center;gap:10px;margin-top:auto;flex-shrink:0;font-size:11px;color:rgba(255,255,255,.45);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sbottom-item{display:flex;align-items:center;gap:3px}.sbottom-sep{color:rgba(255,255,255,.2)}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap"><div class="title"><div class="title-text" id="titleText">搜索「${esc(wd)}」（0个）</div><button class="back" onclick="goBack()">←</button></div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var wd=${JSON.stringify(wd||'')},page=0,loading=false,finished=false,count=0;
if(window.parent===window){var _bs=document.createElement('style');_bs.textContent='html,body{background:#0a0e1a!important}';document.head.appendChild(_bs)}
function el(s){return document.querySelector(s)}
function goBack(){try{parent.postMessage({type:'searchBack'},'*')}catch(e){history.back()}}
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url)&&!item.url.startsWith('/api/'))item.url='http://'+item.url;if(window.parent!==window){try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}else{location.href='/tmdb-page?vodUrl='+encodeURIComponent(item.url)+'&title='+encodeURIComponent(item.title||'')+'&img='+encodeURIComponent(item.img||'')}}
function row(it){var d=document.createElement('div');d.className='row';var sposter=document.createElement('div');sposter.className='sposter';var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';sposter.appendChild(img);if(it.tag){var tagEl=document.createElement('span');tagEl.className='sptext';tagEl.textContent=it.tag;sposter.appendChild(tagEl)}d.appendChild(sposter);var sinfo=document.createElement('div');sinfo.className='sinfo';var sname=document.createElement('div');sname.className='sname';sname.textContent=it.title;sinfo.appendChild(sname);if(it.actors){var sactors=document.createElement('div');sactors.className='sactors';sactors.textContent='\u{1F916} '+it.actors;sinfo.appendChild(sactors)}var parts=[];if(it.type)parts.push(it.type);if(it.year)parts.push(it.year);if(it.area)parts.push(it.area);if(it.class)parts.push(it.class);if(parts.length){var sbottom=document.createElement('div');sbottom.className='sbottom';sbottom.innerHTML=parts.map(function(p){return'<span class="sbottom-item">'+p+'</span>'}).join('<span class="sbottom-sep"> | </span>');sinfo.appendChild(sbottom)}d.appendChild(sinfo);img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'};d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished||!wd)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/search-api?wd='+encodeURIComponent(wd)+'&page='+next).then(r=>r.json()).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'未找到匹配内容';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#titleText').textContent='搜索「'+wd+'」（'+count+'个）';el('#tip').textContent='已加载 '+count+' 个。'}).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)}).finally(()=>loading=false)}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
<\/script></body></html>`;
}

// ========== TMDB详情页HTML ==========
function tmdbPageHtml(d, vodUrl, fallbackImg, cachedSources) {
  const fullUrl = vodUrl && /^https?:/.test(vodUrl) ? vodUrl : vodUrl && /^[a-z]+:\/\//.test(vodUrl) ? vodUrl : vodUrl ? 'https://ds3xy2yunsa.xyz' + vodUrl : vodUrl;
  const bgImg = d.backdrop || fallbackImg || '';
  const img = fallbackImg || '';
  const gTags = d.genres.map(g=>`<span class=tag>${esc(g)}</span>`).join('');
  const rt = d.rating>0?`<span class=rtag>⭐ ${d.rating.toFixed(1)}</span>`:'';
  const yr = d.year?`<span class=tag>${esc(d.year)}</span>`:'';
  const rm = d.runtime?`<span class=tag>${d.runtime}分钟</span>`:'';
  const ss = d.seasons?`<span class=tag>共${d.seasons}季${d.eps}集</span>`:'';

  const castHtml = d.cast.map(c=>{
    const cimg = c.pic?`<img class=cimg src="${escAttr(c.pic)}" loading=lazy onerror="this.style.display='none'">`:'<div class=cimg style="background:#333;display:flex;align-items:center;justify-content:center;color:#666;font-size:18px">?</div>';
    return `<a class=cast href="/tmdb/person-page?id=${encodeURIComponent(c.id)}&name=${encodeURIComponent(c.name)}" target="_self">${cimg}<div class=cname>${esc(c.name)}</div></a>`;
  }).join('');
  var overviewHtml = '';
  if (d.overview) {
    var needFold = d.overview.length > 80;
    if (needFold) {
      overviewHtml = '<div class=sec><div class=sh>剧情简介</div><div class="desc collapsed" id=desc>' + esc(d.overview) + '</div><button class=ebtn onclick="var e=document.getElementById(\'desc\');e.classList.toggle(\'collapsed\');e.classList.toggle(\'expanded\');this.textContent=e.classList.contains(\'collapsed\')?\'展开全文\':\'收起\'">展开全文</button></div>';
    } else {
      overviewHtml = '<div class=sec><div class=sh>剧情简介</div><div class="desc">' + esc(d.overview) + '</div></div>';
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(d.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=ZCOOL+KuaiLe&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,sans-serif;background:#0a0e1a;color:#eee}
.bg{position:fixed;top:0;left:0;right:0;height:56vh;overflow:hidden;z-index:0;background:#0a0e1a}.bg img{width:100%;height:100%;object-fit:cover;object-position:center 20%;filter:brightness(.85)}.bg .fade{position:absolute;bottom:0;left:0;right:0;height:35%;background:linear-gradient(to top,#0a0e1a 0%,rgba(10,14,26,.6) 50%,transparent 100%)}
.topbar{position:fixed;top:0;left:0;right:0;z-index:20;padding:10px 14px;display:flex;align-items:center}
.nbtn{background:rgba(0,0,0,.4);backdrop-filter:blur(8px);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}
.content{position:relative;z-index:10;padding-top:38vh}
.hero{padding:40px 16px 0}.info .t{font-family:'ZCOOL KuaiLe',cursive;font-size:39px;font-weight:400;line-height:1.2;margin-bottom:16px;background:linear-gradient(135deg,#f6d365,#fda085,#f6d365,#fda085);background-size:200% 200%;-webkit-background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:gradientMove 3s ease infinite;filter:drop-shadow(6px 8px 12px rgba(79,195,247,.9)) drop-shadow(0 0 25px rgba(79,195,247,.5)) drop-shadow(0 0 60px rgba(79,195,247,.25))}.hero-logo{max-width:74%;max-height:84px;object-fit:contain;filter:drop-shadow(4px 6px 10px rgba(79,195,247,.8));display:none;margin-bottom:16px}
@keyframes gradientMove{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}.info .tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{padding:3px 10px;border-radius:14px;font-size:11px;background:rgba(79,195,247,.15);color:#4fc3f7;border:1px solid rgba(79,195,247,.3)}.rtag{padding:3px 10px;border-radius:14px;font-size:12px;font-weight:700;background:rgba(255,193,7,.15);color:#ffc107;border:1px solid rgba(255,193,7,.3)}
.play{display:block;margin:18px auto 0;width:calc(100% - 32px);max-width:400px;padding:10px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.25);border-radius:24px;color:#fff;font-size:15px;font-weight:700;cursor:pointer}.play:active{transform:scale(.97)}
.favbtn{display:block;margin:10px auto 0;width:calc(100% - 32px);max-width:400px;padding:12px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.25);border-radius:24px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:all .2s}.favbtn:active{transform:scale(.97)}
.sec{padding:20px 16px 0}.sh{font-size:15px;font-weight:700;margin-bottom:10px}
.desc{font-size:13px;color:rgba(224,224,224,.78);line-height:1.7;white-space:pre-line}
.desc.collapsed{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:normal}
.desc.expanded{display:block;white-space:pre-line}
.ebtn{background:0;border:0;color:#4fc3f7;font-size:12px;cursor:pointer;padding:4px 0}
.clist{display:flex;gap:14px;overflow-x:auto;padding-bottom:8px}.clist::-webkit-scrollbar{display:none}
.cast{flex-shrink:0;width:72px;text-align:center;cursor:pointer;text-decoration:none;color:#eee}.cimg{width:62px;height:62px;border-radius:50%;object-fit:cover;background:#222;display:block;margin:0 auto 6px;border:2px solid rgba(255,255,255,.2)}
.cname{font-size:10px;color:rgba(224,224,224,.85);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:600}
.fbtn{position:fixed;bottom:24px;right:16px;z-index:30;width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.5);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.fbtn:active{transform:scale(.9)}
.src-section{padding:20px 16px 0}.src-title{font-size:15px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:6px}.src-tabs{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px;-webkit-overflow-scrolling:touch}.src-tabs::-webkit-scrollbar{display:none}.src-tab{flex-shrink:0;padding:6px 14px;border-radius:16px;font-size:12px;font-weight:600;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);cursor:pointer;transition:all .2s;white-space:nowrap;color:rgba(255,255,255,.7)}.src-tab.on{background:rgba(79,195,247,.25);border-color:rgba(79,195,247,.5);color:#4fc3f7}.ep-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:10px;width:100%}.ep-item{padding:8px 4px;border-radius:10px;font-size:12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);cursor:pointer;transition:all .2s;color:rgba(255,255,255,.85);text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.ep-item:active{transform:scale(.95);background:rgba(79,195,247,.3)}.ep-item.on{background:rgba(79,195,247,.3);border-color:rgba(79,195,247,.6);color:#4fc3f7;font-weight:700}.ep-more{grid-column:1/-1;padding:8px 14px;border-radius:10px;font-size:12px;background:rgba(79,195,247,.15);border:1px solid rgba(79,195,247,.3);cursor:pointer;color:#4fc3f7;white-space:nowrap;text-align:center}.ep-loading{text-align:center;padding:16px;color:rgba(255,255,255,.5);font-size:12px}
</style></head><body>${COMMON_ANTI_COPY}
<div class=bg>${bgImg?'<img src="'+escAttr(bgImg)+'">':''}<div class=fade></div></div>
<div id=_hi data-img="${escAttr(img)}" data-vurl="${escAttr(fullUrl)}" style="display:none"></div>
<div class=topbar><button class=nbtn onclick="try{parent.postMessage({type:'dsjClose'},'*')}catch(e){history.back()}">←</button></div>
<div class=content><div class=hero><div class=info><img class=hero-logo id=heroLogo${d.logo?' src="'+escAttr(d.logo)+'"':''}><div class=t>${d.logo?'':esc(d.title)}</div><div class=tags>${yr}${rm}${ss}${gTags}${rt}</div></div></div>
<div style="display:flex;gap:10px;margin:18px auto 0;width:calc(100% - 32px);max-width:400px">
<button class=play style="flex:1;margin:0" id=playBtn onclick="playFirst()">▶ 播放</button>
<a class=favlink href="/fav-add-redirect?title=${encodeURIComponent(d.title)}&url=${encodeURIComponent(fullUrl)}&img=${encodeURIComponent(img||'')}" style="flex:0 0 auto;padding:10px 14px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.25);border-radius:24px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;margin:0;white-space:nowrap">❤️ 收藏</a>
<a href="/history" style="flex:0 0 auto;padding:10px 14px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.25);border-radius:24px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;margin:0;white-space:nowrap">🕐 历史</a>
</div>
<div class=src-section id=srcSection style="display:none"><div class=src-title>🎬 选集播放</div><div class=src-tabs id=srcTabs></div><div class=ep-grid id=epGrid></div></div>
<script>
(function(){var logo=document.getElementById('heroLogo');if(logo&&logo.src){logo.style.display='block';logo.onerror=function(){this.style.display='none';var t=document.querySelector('.info .t');if(t)t.style.display=''}}})();
var VOD_URL='${fullUrl.replace(/'/g, "\\'")}',SITE='https://ds3xy2yunsa.xyz';
var playSources=${cachedSources?JSON.stringify(cachedSources):'[]'},curSrc=0,showAll=false,curEpUrl='';
try{var _cached=JSON.parse(localStorage.getItem('youzi_tmdb_state')||'null');if(_cached&&_cached.vodUrl===VOD_URL){curEpUrl=_cached.curEpUrl||'';curSrc=typeof _cached.curSrc==='number'?_cached.curSrc:0}}catch(e){}
function playFirst(){
  var _playUrl=VOD_URL;
  var _m=VOD_URL.match(/vod_id=(\d+)/);
  if(_m){_playUrl=SITE+'/api.php/app/vod/get_detail?vod_id='+_m[1]}
  // 通知父页面打开C页面并关闭TMDB页面
  try{parent.postMessage({type:'dsjPlayC',url:_playUrl},'*')}catch(e){}
}
function loadPlay(){
  var el=document.getElementById('srcSection');
  var grid=document.getElementById('epGrid');
  grid.innerHTML='<div class=ep-loading>加载线路中...</div>';
  el.style.display='block';
  fetch('/api/parse-play?url='+encodeURIComponent(VOD_URL)).then(function(r){return r.json()}).then(function(j){
    if(!j.ok||!j.sources||!j.sources.length){grid.innerHTML='<div class=ep-loading>暂无播放源</div>';return}
    playSources=j.sources;if(curSrc>=j.sources.length)curSrc=0;showAll=false;
    try{sessionStorage.setItem('youzi_src_'+VOD_URL,JSON.stringify(playSources));sessionStorage.setItem('youzi_tmdb_title_'+VOD_URL,document.title);var _bg=document.querySelector('.bg img');if(_bg)sessionStorage.setItem('youzi_tmdb_bg_'+VOD_URL,_bg.src)}catch(e){}
    renderTabs();renderEps();
  }).catch(function(e){grid.innerHTML='<div class=ep-loading>加载失败</div>'})
}
function renderTabs(){
  var c=document.getElementById('srcTabs');c.innerHTML='';
  playSources.forEach(function(s,i){
    var b=document.createElement('div');b.className='src-tab'+(i===curSrc?' on':'');
    b.textContent=s.name+(s.episodes?' ('+s.episodes.length+')':'');
    b.onclick=function(){curSrc=i;showAll=false;renderTabs();renderEps()};
    c.appendChild(b)
  })
}
function renderEps(){
  var grid=document.getElementById('epGrid');grid.innerHTML='';
  var src=playSources[curSrc];
  if(!src||!src.episodes||!src.episodes.length){grid.innerHTML='<div class=ep-loading>暂无集数</div>';return}
  var eps=src.episodes;
  var showEps=showAll?eps:eps.slice(0,35);
  showEps.forEach(function(ep){
    function _nurl(u){try{u=decodeURIComponent(u)}catch(e){}return u}var d=document.createElement('div');var _eu=ep.url.charAt(0)==='/'?SITE+ep.url:ep.url;var _cu=curEpUrl&&curEpUrl.charAt(0)==='/'?SITE+curEpUrl:curEpUrl;d.className='ep-item'+(_cu&&(_nurl(_eu)===_nurl(_cu))?' on':(curEpUrl&&(_nurl(ep.url)===_nurl(curEpUrl)||_nurl(_eu).indexOf(_nurl(curEpUrl))>-1||_nurl(curEpUrl).indexOf(_nurl(ep.url))>-1)?' on':''));d.textContent=ep.title;
    d.onclick=function(){
      curEpUrl=ep.url;
      var u=ep.url.charAt(0)==='/'?SITE+ep.url:ep.url;
      try{localStorage.setItem('youzi_tmdb_state',JSON.stringify({vodUrl:VOD_URL,curEpUrl:ep.url,curSrc:curSrc}))}catch(e){}
      renderEps();
      window.location.href='/player?url='+encodeURIComponent(u)+'&title='+encodeURIComponent(ep.title)+'&vod='+encodeURIComponent(VOD_URL);
      try{var _bgi=document.querySelector('.bg img'),_hi=document.getElementById('_hi');var _tt=document.querySelector('.info .t'),_mt2=_tt&&_tt.textContent?_tt.textContent:(document.title||ep.title);sessionStorage.setItem('youzi_tmdb_bg_'+VOD_URL,(_bgi?_bgi.src:''));sessionStorage.setItem('youzi_tmdb_meta_'+VOD_URL,JSON.stringify({title:_mt2,backdrop:_bgi?_bgi.src:'',img:_hi?_hi.dataset.img:''}))}catch(e2){}
    };
    grid.appendChild(d)
  });
  if(!showAll&&eps.length>35){
    var more=document.createElement('div');more.className='ep-more';more.textContent='展开全部 '+eps.length+' 集 ▼';
    more.onclick=function(){showAll=true;renderEps()};
    grid.appendChild(more)
  }else if(showAll&&eps.length>35){
    var less=document.createElement('div');less.className='ep-more';less.textContent='收起 ▲';
    less.onclick=function(){showAll=false;renderEps()};
    grid.appendChild(less)
  }
}
${cachedSources ? "// 服务端已有缓存，直接渲染\nif(playSources.length){var el2=document.getElementById('srcSection');el2.style.display='block';showAll=false;renderTabs();renderEps()}else{loadPlay()}" : "// 启动时优先读取缓存（旧单线路缓存自动跳过）\n(function(){try{var _s=sessionStorage.getItem('youzi_src_'+VOD_URL);if(_s){playSources=JSON.parse(_s);if(playSources.length>1){var el2=document.getElementById('srcSection');el2.style.display='block';showAll=false;renderTabs();renderEps();return}}}catch(e){}loadPlay();})()"}
window.addEventListener('pageshow',function(e){
  if(e.persisted&&playSources.length){
    try{var _c2=JSON.parse(localStorage.getItem('youzi_tmdb_state')||'null');if(_c2&&_c2.vodUrl===VOD_URL){curEpUrl=_c2.curEpUrl||'';curSrc=typeof _c2.curSrc==='number'?_c2.curSrc:0;if(curSrc>=playSources.length)curSrc=0;renderTabs();renderEps()}}catch(e2){}
  }
});
</script>
${overviewHtml}
${castHtml?'<div class=sec><div class=sh>主演</div><div class=clist>'+castHtml+'</div></div>':''}
</div><button class=fbtn onclick="try{parent.postMessage({type:'dsjClose'},'*')}catch(e){history.back()}">\u2190</button></body></html>`;
}


// ========== 播放器页面HTML ==========
function playerHtml(playUrl, title, vodUrl, img, sources) {
  const safeTitle = esc(title || '播放');
  const jsPlayUrl = JSON.stringify(playUrl || '');
  const jsVodUrl = JSON.stringify(vodUrl || '');
  const jsTitle = JSON.stringify(title || '播放');
  const jsImg = JSON.stringify(img || '');
  const jsSources = sources ? JSON.stringify(sources) : 'null';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<title>${safeTitle}</title>
<script src="https://unpkg.com/hls.js@1.5.7/dist/hls.min.js"><\/script>
<script src="https://unpkg.com/flv.js@1.6.2/dist/flv.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:#000;color:#eee;font-family:-apple-system,sans-serif;overflow:hidden;height:100vh;height:100dvh;display:flex;flex-direction:column}
.topbar{height:44px;display:none;align-items:center;padding:0 12px;background:rgba(0,0,0,.9);flex-shrink:0;z-index:10}
body.fs-mode .topbar{display:flex}
.src-bar,.ep-bar{display:none}
body.fs-mode .src-bar,body.fs-mode .ep-bar{display:flex}
.nbtn{background:rgba(255,255,255,.12);border:0;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center}
.nbtn:active{background:rgba(255,255,255,.25)}
#prevEp:disabled,#nextEp:disabled,#fsPrevEp:disabled,#fsNextEp:disabled,#ifPrevEp:disabled,#ifNextEp:disabled{opacity:.3}
#rotateBtn.rotated{color:#4fc3f7}
.title{flex:1;text-align:center;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 10px}
.player-wrap{flex:1;position:relative;background:#000;display:flex;align-items:center;justify-content:center;min-height:0}
video{width:100%;height:100%;object-fit:contain;transition:transform .3s ease}
.info-bar{padding:8px 14px;background:rgba(255,255,255,.06);font-size:12px;color:rgba(255,255,255,.6);flex-shrink:0;display:flex;justify-content:space-between;align-items:center}
.ep-bar{padding:10px 14px;background:rgba(0,0,0,.95);display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch}.ep-bar::-webkit-scrollbar{display:none}
.fs-ep-panel{position:absolute;bottom:0;left:0;right:0;z-index:25;background:rgba(0,0,0,.92);backdrop-filter:blur(10px);padding:10px 12px;max-height:45vh;overflow-y:auto;display:none}
.fs-ep-panel.show{display:block}
.fs-ep-panel .ep-item{display:inline-block;padding:7px 12px;margin:4px;border-radius:8px;font-size:12px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.85);cursor:pointer}
.fs-ep-panel .ep-item:active{background:rgba(79,195,247,.3)}
.fs-ep-panel .ep-item.on{background:rgba(79,195,247,.3);border-color:rgba(79,195,247,.6);color:#4fc3f7;font-weight:700}
.auto-next{position:absolute;bottom:60px;left:50%;transform:translateX(-50%);z-index:30;background:rgba(0,0,0,.85);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.2);border-radius:14px;padding:12px 20px;display:none;align-items:center;gap:10px;color:#fff;font-size:13px}
.auto-next.show{display:flex}
.auto-next .an-btn{padding:6px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;font-size:12px;cursor:pointer}
.auto-next .an-btn:active{background:rgba(255,255,255,.25)}
.auto-next .an-btn.play{background:rgba(79,195,247,.3);border-color:rgba(79,195,247,.6);color:#4fc3f7}
.auto-next{flex-wrap:wrap;justify-content:center}
.an-bar-wrap{flex:0 0 100%;height:3px;background:rgba(255,255,255,.15);border-radius:2px;margin-top:8px;overflow:hidden}
.an-bar{height:100%;background:linear-gradient(90deg,#4fc3f7,#6ec6ff);border-radius:2px;width:100%}
#autoNextBtn,#fsAutoNextBtn{font-size:10px;letter-spacing:-1px;white-space:nowrap}
.an-toggle{transition:color .2s}
.ep-btn{flex-shrink:0;padding:8px 14px;border-radius:10px;font-size:12px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);cursor:pointer;color:rgba(255,255,255,.8);white-space:nowrap}
.ep-btn:active{transform:scale(.95)}.ep-btn.on{background:rgba(79,195,247,.3);border-color:rgba(79,195,247,.6);color:#4fc3f7}
.src-bar{padding:8px 14px;background:rgba(0,0,0,.92);display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch}.src-bar::-webkit-scrollbar{display:none}
.src-btn{flex-shrink:0;padding:6px 14px;border-radius:14px;font-size:12px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);cursor:pointer;color:rgba(255,255,255,.7);white-space:nowrap;transition:all .2s}
.src-btn:active{transform:scale(.95)}.src-btn.on{background:rgba(79,195,247,.25);border-color:rgba(79,195,247,.5);color:#4fc3f7;font-weight:600}
.loading{text-align:center;padding:40px;color:rgba(255,255,255,.5)}
.error{text-align:center;padding:40px;color:#ff6b6b}
.controls{position:absolute;bottom:0;left:0;right:0;padding:10px 14px;background:linear-gradient(transparent,rgba(0,0,0,.8));display:flex;align-items:center;gap:10px;opacity:1;transition:opacity .3s}
.controls.hide{opacity:0;pointer-events:none}
.progress{flex:1;height:4px;background:rgba(255,255,255,.2);border-radius:2px;cursor:pointer;position:relative}
.progress-bar{height:100%;background:#4fc3f7;border-radius:2px;width:0;transition:width .1s}
.time{font-size:11px;color:rgba(255,255,255,.8);white-space:nowrap}
.play-btn{background:0;border:0;color:#fff;font-size:22px;cursor:pointer;padding:4px}
.vol-wrap{display:flex;align-items:center;gap:6px}
.vol-slider{-webkit-appearance:none;width:60px;height:3px;background:rgba(255,255,255,.3);border-radius:2px;outline:none}
.vol-slider::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;background:#4fc3f7;border-radius:50%;cursor:pointer}
.speed-btn{background:rgba(255,255,255,.15);border:0;color:#fff;padding:4px 10px;border-radius:12px;font-size:11px;cursor:pointer}
.ctrl-ep-btn{background:rgba(255,255,255,.15);border:0;color:#fff;padding:4px 10px;border-radius:12px;font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0}
.ctrl-ep-btn:active{background:rgba(79,195,247,.4)}
.ctrl-ep-btn.on{background:rgba(79,195,247,.3);color:#4fc3f7}
.fs-topbar{position:absolute;top:0;left:0;right:0;z-index:20;padding:8px 12px;display:flex;align-items:center;gap:6px;background:linear-gradient(to bottom,rgba(0,0,0,.7),transparent);opacity:0;pointer-events:none;transition:opacity .3s}

.fs-btn{background:rgba(255,255,255,.15);border:0;color:#fff;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center}
.fs-btn:active{background:rgba(255,255,255,.3)}
.fs-title{flex:1;text-align:center;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff}
.loading-overlay{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;z-index:5;background:rgba(20,20,30,.85);transition:opacity .3s}.loading-overlay.hide{opacity:0;pointer-events:none}
.boxes{--size:28px;--duration:800ms;height:calc(var(--size)*2);width:calc(var(--size)*3);position:relative;transform-style:preserve-3d;transform-origin:50% 50%;margin-top:calc(var(--size)*1.5*-1);transform:rotateX(60deg) rotateZ(45deg) rotateY(0deg) translateZ(0)}
.boxes .box{width:var(--size);height:var(--size);top:0;left:0;position:absolute;transform-style:preserve-3d}
.boxes .box:nth-child(1){transform:translate(100%,0);-webkit-animation:box1 var(--duration) linear infinite;animation:box1 var(--duration) linear infinite}
.boxes .box:nth-child(2){transform:translate(0,100%);-webkit-animation:box2 var(--duration) linear infinite;animation:box2 var(--duration) linear infinite}
.boxes .box:nth-child(3){transform:translate(100%,100%);-webkit-animation:box3 var(--duration) linear infinite;animation:box3 var(--duration) linear infinite}
.boxes .box:nth-child(4){transform:translate(200%,0);-webkit-animation:box4 var(--duration) linear infinite;animation:box4 var(--duration) linear infinite}
.boxes .box>div{--background:#5C8DF6;--top:auto;--right:auto;--bottom:auto;--left:auto;--translateZ:calc(var(--size)/2);--rotateY:0deg;--rotateX:0deg;position:absolute;width:100%;height:100%;background:var(--background);top:var(--top);right:var(--right);bottom:var(--bottom);left:var(--left);transform:rotateY(var(--rotateY)) rotateX(var(--rotateX)) translateZ(var(--translateZ))}
.boxes .box>div:nth-child(1){--top:0;--left:0}
.boxes .box>div:nth-child(2){--background:#145af2;--right:0;--rotateY:90deg}
.boxes .box>div:nth-child(3){--background:#447cf5;--rotateX:-90deg}
.boxes .box>div:nth-child(4){--background:#383b3f;--top:0;--left:0;--translateZ:calc(var(--size)*3*-1)}
@keyframes box1{0%,50%{transform:translate(100%,0)}100%{transform:translate(200%,0)}}
@keyframes box2{0%{transform:translate(0,100%)}50%{transform:translate(0,0)}100%{transform:translate(100%,0)}}
@keyframes box3{0%,50%{transform:translate(100%,100%)}100%{transform:translate(0,100%)}}
@keyframes box4{0%{transform:translate(200%,0)}50%{transform:translate(200%,100%)}100%{transform:translate(100%,100%)}}
@keyframes anPulse{0%,100%{opacity:.55;transform:scale(.92)}50%{opacity:1;transform:scale(1.06)}}
</style></head><body>${COMMON_ANTI_COPY}
<div class=topbar>
  <button class=nbtn id=backBtn>←</button>
  <button class=nbtn id=prevEp style="font-size:14px">⏮</button>
  <button class=nbtn id=nextEp style="font-size:14px">⏭</button>
  <button class=nbtn id=showEpBtn style="font-size:11px;letter-spacing:-1px">选集</button>
  <button class="nbtn an-toggle" id=rotateBtn style="font-size:13px">↻</button>
  <button class="nbtn an-toggle" id=autoNextBtn style="font-size:10px;letter-spacing:-1px">连播</button>
  <div class=title id=vTitle>${esc(title || '播放')}</div>
  <button class=nbtn onclick="toggleFullscreen()">⛶</button>
</div>
<div class=player-wrap id=playerWrap>
  <div class=fs-topbar id=fsTopbar>
    <button class=fs-btn onclick="try{history.back()}catch(e){}">←</button>
    <button class=fs-btn id=fsPrevEp style="font-size:12px">⏮</button>
    <button class=fs-btn id=fsNextEp style="font-size:12px">⏭</button>
    <button class=fs-btn id=fsShowEp style="font-size:10px;letter-spacing:-1px">选集</button>
    <button class="fs-btn an-toggle" id=fsRotate style="font-size:11px">↻</button>
    <button class="fs-btn an-toggle" id=fsAutoNextBtn style="font-size:10px;letter-spacing:-1px">连播</button>
    <div class=fs-title id=fsTitle>${esc(title || '播放')}</div>
    <button class=fs-btn onclick="toggleFullscreen()" style="font-size:16px">⛶</button>
  </div>
  <video id=video playsinline webkit-playsinline referrerpolicy="no-referrer"></video>
  <div class=fs-ep-panel id=fsEpPanel></div>
  <div class=auto-next id=autoNext><span id=anText></span><button class="an-btn play" id=anPlay>立即播放</button><button class=an-btn id=anCancel>取消</button><div class=an-bar-wrap><div class=an-bar id=anBar></div></div></div>
  <div class=loading-overlay id=loadingOverlay><div class=boxes><div class=box><div></div><div></div><div></div><div></div></div><div class=box><div></div><div></div><div></div><div></div></div><div class=box><div></div><div></div><div></div><div></div></div><div class=box><div></div><div></div><div></div><div></div></div></div></div>
  <div class=controls id=controls>
    <button class=play-btn id=playBtn>▶</button>
    <div class=progress id=progress><div class=progress-bar id=progressBar></div></div>
    <div class=time id=timeText>00:00/00:00</div>
    <div class=vol-wrap>
      <span style="font-size:14px">🔊</span>
      <input type=range class=vol-slider id=volSlider min=0 max=1 step=0.05 value=1>
    </div>
    <button class=speed-btn id=speedBtn>1x</button>
    <button class=ctrl-ep-btn id=ctrlEpBtn>选集</button>
  </div>
</div>
<div class=info-bar id=infoBar style="display:none"><span id=sourceInfo>-</span><span id=netInfo>-</span></div>
<div class=src-bar id=srcBar></div>
<div class=ep-bar id=epBar></div>
<script>
var PLAY_URL=${jsPlayUrl},VOD_URL=${jsVodUrl},SITE='https://ds3xy2yunsa.xyz';
var PRESET_SOURCES=${jsSources};
var video=document.getElementById('video');
var MOVIE_TITLE=${jsTitle};
var PARAM_IMG=${jsImg};
var hls=null,curSpeed=1,speeds=[0.5,0.75,1,1.25,1.5,2],speedIdx=2;
var controlsTimer=null;

// 通用 iframe 解析播放器（加密令牌 / 线路自带 parse_url 均走此入口）
function _setupIframePlayer(iframeSrc){
  if(hls){hls.destroy();hls=null}
  if(window._flvPlayer){try{window._flvPlayer.destroy()}catch(e){};window._flvPlayer=null}
  video.src='';
  var pw=document.getElementById('playerWrap');
  pw.innerHTML='<iframe src="'+iframeSrc+'" width="100%" height="100%" allowfullscreen="true" frameborder="0" scrolling="no" style="border:0;width:100%;height:100%"></iframe>';
  pw.style.position='relative';
  var ctrlBar=document.createElement('div');
  ctrlBar.style.cssText='position:absolute;top:0;left:0;right:0;z-index:9999;padding:8px 12px;display:flex;align-items:center;gap:6px;background:linear-gradient(to bottom,rgba(0,0,0,.7),transparent)';
  ctrlBar.innerHTML='<button class="nfb" onclick="try{history.back()}catch(e){}" style="background:rgba(255,255,255,.15);border:0;color:#fff;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center">←</button>'
    +'<button class="nfb" id="ifPrevEp" style="background:rgba(255,255,255,.15);border:0;color:#fff;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center">⏮</button>'
    +'<button class="nfb" id="ifNextEp" style="background:rgba(255,255,255,.15);border:0;color:#fff;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center">⏭</button>'
    +'<button class="nfb" id="ifShowEp" style="background:rgba(255,255,255,.15);border:0;color:#fff;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:10px;display:flex;align-items:center;justify-content:center">选集</button>'
    +'<div id="ifTitle" style="flex:1;text-align:center;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff;padding:0 6px">'+document.title+'</div>';
  pw.appendChild(ctrlBar);
  var _ifP=document.getElementById('ifPrevEp'),_ifN=document.getElementById('ifNextEp'),_ifS=document.getElementById('ifShowEp');
  if(_ifP)_ifP.onclick=function(e){e.stopPropagation();switchEp(-1)};
  if(_ifN)_ifN.onclick=function(e){e.stopPropagation();switchEp(1)};
  if(_ifS)_ifS.onclick=function(e){e.stopPropagation();var bar=document.getElementById('epBar'),srcBar=document.getElementById('srcBar');if(bar){var vis=bar.style.display!=='none';bar.style.display=vis?'none':'';if(srcBar)srcBar.style.display=vis?'none':'';if(!vis){bar.scrollIntoView({behavior:'smooth'})}}};
  if(pSources&&pSources.length)updatePrevNext();
  document.getElementById('sourceInfo').textContent='正在解析...';
}

function initPlayer(url){
  var lo=document.getElementById('loadingOverlay');if(lo)lo.classList.remove('hide');
  document.getElementById('sourceInfo').textContent='正在解析...';
  var _d=VOD_URL==='live'?'&direct=1':'';
  fetch('/api/play-url?url='+encodeURIComponent(url)+_d).then(function(r){return r.json()}).then(function(j){
    if(j.ok&&j.data&&j.data.url){
      var vurl=j.data.url;
      if(j.data.encrypt===1){try{vurl=atob(vurl)}catch(e){}}
      if(vurl.charAt(0)==='@')vurl=vurl.substring(1);
      document.getElementById('sourceInfo').textContent='';
      if(j.data.parse){_setupIframePlayer(vurl);return}
      _doPlay(vurl);
    }else{_hideLoader();showError(j.error||'解析失败')}
  }).catch(function(e){_hideLoader();showError('解析失败: '+e.message)});
}
function _doPlay(url){
  if(hls){hls.destroy();hls=null}
  if(window._flvPlayer){try{window._flvPlayer.destroy()}catch(e){};window._flvPlayer=null}
  video.src='';
  if(!url){showError('无播放地址');return}
  // 非视频直链（官网播放页 v.qq.com 等 / 加密令牌 JD-xxx / co_xxx）→ iframe 专用解析服务
  // 注意：很多合法 m3u8 URL 没有 .m3u8 后缀（如 /getM3u8?name=xxx），需宽松匹配
  if(url.indexOf('http')!==0 || !/(m3u8|mp4|flv|ts|aac)/i.test(url)){
    _setupIframePlayer('https://xn--qvr2v.850088.xyz/player/?url='+encodeURIComponent(url)+'&next=&title='+encodeURIComponent(document.title.split('-')[0]));
    return;
  }
  // ixigua CDN 需要通过服务端代理（Referer 403）
  if(url.indexOf('ixigua.com')>-1){
    url='/play-stream?url='+encodeURIComponent(url);
  }
  // 4k-av.com 的 m3u8 走代理解决 CORS
  if(url.indexOf('4k-av.com')>-1 && /\.m3u8/i.test(url)){
    url='/m3u8-proxy?url='+encodeURIComponent(url);
  }
  // FLV：先直连，失败走代理
  var _rawExt=url.split('?')[0].split('.').pop().toLowerCase();
  var _isFlv=url.toLowerCase().indexOf('.flv')>-1;
  if(_isFlv||_rawExt==='flv'){
    if(typeof flvjs!=='undefined'&&flvjs.isSupported()){
      var _flvRetry=false;
      function _playFlv(flvUrl){
        var fp=flvjs.createPlayer({type:'flv',url:flvUrl,isLive:true,cors:true},{enableStashBuffer:false,lazyLoad:false,reuseRedirectedURL:true});
        fp.attachMediaElement(video);
        fp.on(flvjs.Events.ERROR,function(){
          try{fp.destroy()}catch(ex){}
          if(!_flvRetry){
            _flvRetry=true;
            _playFlv('/live-proxy?url='+encodeURIComponent(url));
          }else{
            _hideLoader();showError('FLV播放失败');
          }
        });
        fp.on(flvjs.Events.LOADING_COMPLETE,function(){});
        fp.load();window._flvPlayer=fp;
        var _flvStarted=false;
        video.addEventListener('canplay',function(){if(_flvStarted)return;_flvStarted=true;_autoPlay();_hideLoader()},{once:true});
        setTimeout(function(){if(!_flvStarted){_flvStarted=true;_autoPlay();_hideLoader()}},8000);
      }
      _playFlv(url);
    }else{
      video.src=url;
      video.addEventListener('loadedmetadata',function(){_autoPlay()},{once:true});
    }
    return;
  }
  // 非FLV才走代理
  if(url.indexOf('ixigua.com')>-1){
    url='/play-stream?url='+encodeURIComponent(url);
  }
  video.onerror=function(){
    // 原生播放失败，尝试 flv.js
    if(typeof flvjs!=='undefined'&&flvjs.isSupported()){
      try{
        var fp=flvjs.createPlayer({type:'flv',url:'/live-proxy?url='+encodeURIComponent(url),isLive:true,cors:true},{enableStashBuffer:false,lazyLoad:false,reuseRedirectedURL:true});
        fp.attachMediaElement(video);
        fp.on(flvjs.Events.ERROR,function(){try{fp.destroy()}catch(e){}_hideLoader();showError('播放失败')});
        fp.load();window._flvPlayer=fp;
        var _fb=false;video.addEventListener('canplay',function(){if(_fb)return;_fb=true;_autoPlay();_hideLoader()},{once:true});
        return;
      }catch(e){}
    }
    _hideLoader();showError('视频加载失败 code='+video.error.code);
  };
  // 格式判断：优先用后缀，代理URL从原始参数提取后缀
  var ext='';
  if(url.indexOf('/play-stream?url=')>-1||url.indexOf('/m3u8-proxy?url=')>-1){
    try{var _m=url.match(/url=([^&]+)/);if(_m){var _ru=decodeURIComponent(_m[1]);ext=_ru.split('?')[0].split('.').pop().toLowerCase()}}catch(e){}
  }
  if(!ext){ext=url.split('?')[0].split('.').pop().toLowerCase()}
  if(ext==='m3u8'&&Hls.isSupported()){
    hls=new Hls({maxBufferLength:30,maxMaxBufferLength:60,startLevel:-1,startFragPrefetch:true,fragLoadingRetry:3,manifestLoadingRetry:3,levelLoadingRetry:3});
    hls.loadSource(url);hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED,function(){_autoPlay()});
    hls.on(Hls.Events.ERROR,function(e,d){if(d.fatal){if(d.type===Hls.ErrorTypes.NETWORK_ERROR){hls.startLoad();showError('网络错误，正在重试...')}else if(d.type===Hls.ErrorTypes.MEDIA_ERROR){hls.recoverMediaError()}else{showError('播放出错');hls.destroy()}}});
  }else if(ext==='m3u8'&&video.canPlayType('application/vnd.apple.m3u8')){
    video.src=url;video.addEventListener('loadedmetadata',function(){_autoPlay()},{once:true});
  }else{
    // mp4/ts/mkv 等可直连格式直接播放
    if(url.indexOf('http')===0 && /mp4|ts|mkv|webm|mov/i.test(url)){
      video.src=url;video.addEventListener('loadedmetadata',function(){_autoPlay()},{once:true});
    }else{
      // 其他未知格式：走代理播放
      video.src='/live-proxy?url='+encodeURIComponent(url);
      video.addEventListener('loadedmetadata',function(){_autoPlay()},{once:true});
    }
  }
  document.getElementById('sourceInfo').textContent='正在加载...';
}
function showError(msg){document.getElementById('sourceInfo').innerHTML='<span style="color:#ff6b6b">'+msg+'</span>'}
function _autoPlay(){video.muted=true;video.play().catch(function(){});_restoreProgress();video.addEventListener('playing',function _unmute(){video.removeEventListener('playing',_unmute);setTimeout(function(){video.muted=false},300)},{once:true})}
function _restoreProgress(){if(!VOD_URL)return;fetch('/his-list').then(function(r){return r.json()}).then(function(j){if(!j.ok||!j.items)return;var h=null;for(var i=0;i<j.items.length;i++){if(j.items[i].url===VOD_URL){h=j.items[i];break}}if(!h||!h.progress||!h.duration)return;if(h.progress<h.duration-5&&h.progress>5){video.currentTime=h.progress}}).catch(function(){})}
function fmt(s){if(isNaN(s))return'00:00';var m=Math.floor(s/60),sec=Math.floor(s%60);return(m<10?'0':'')+m+':'+(sec<10?'0':'')+sec}

document.getElementById('playBtn').onclick=function(){if(video.paused){video.play()}else{video.pause()}if(video.muted)video.muted=false};
video.addEventListener('loadedmetadata',function(){var rot=parseInt(video.getAttribute('data-rot')||'0');if(rot!==0)_rotateBtn&&_rotateBtn.click()});
function _hideLoader(){var lo=document.getElementById('loadingOverlay');if(lo)lo.classList.add('hide')}
function _showLoader(){var lo=document.getElementById('loadingOverlay');if(lo)lo.classList.remove('hide')}
video.onplay=function(){document.getElementById('playBtn').textContent='⏸';showControls()};
video.onpause=function(){document.getElementById('playBtn').textContent='▶'};
// ===== 自动下一集（优化版：开关 / 进度条 / 防泄漏 / 末集提示） =====
var _autoNextTimer=null,_autoNextOn=true,_autoNextSec=3;
try{_autoNextOn=localStorage.getItem('youzi_auto_next')!=='0'}catch(e){}
try{var _ans=parseInt(localStorage.getItem('youzi_auto_next_sec'));if(_ans>=3&&_ans<=15)_autoNextSec=_ans}catch(e){}
function _clearAutoNext(){if(_autoNextTimer){clearInterval(_autoNextTimer);_autoNextTimer=null}var _p=document.getElementById('autoNext');if(_p)_p.classList.remove('show')}
function _updateAutoNextBtn(){var _b=document.getElementById('autoNextBtn'),_fb=document.getElementById('fsAutoNextBtn');var _on=_autoNextOn?'🔁连播':'⏹连播';if(_b){_b.textContent=_on;_b.style.color=_autoNextOn?'#4fc3f7':'rgba(255,255,255,.45)'}if(_fb){_fb.textContent=_on;_fb.style.color=_autoNextOn?'#4fc3f7':'rgba(255,255,255,.45)'}}
function _toggleAutoNext(){_autoNextOn=!_autoNextOn;try{localStorage.setItem('youzi_auto_next',_autoNextOn?'1':'0')}catch(e){}_updateAutoNextBtn();if(!_autoNextOn)_clearAutoNext();else _toast(_autoNextOn?'已开启自动连播':'已关闭自动连播')}
function _toast(msg){var t=document.createElement('div');t.textContent=msg;t.style.cssText='position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.85);color:#fff;padding:10px 22px;border-radius:10px;font-size:13px;z-index:40;pointer-events:none;transition:opacity .3s';var pw=document.getElementById('playerWrap');if(!pw)return;pw.appendChild(t);setTimeout(function(){t.style.opacity='0';setTimeout(function(){t.remove()},300)},1400)}
function _showAutoNextPanel(){
  _clearAutoNext();
  var panel=document.getElementById('autoNext'),txt=document.getElementById('anText'),bar=document.getElementById('anBar');
  if(!panel||!txt)return;
  var sec=_autoNextSec;txt.textContent='即将播放下一集 ('+sec+'s)';
  if(bar){bar.style.transition='none';bar.style.width='100%'}
  panel.classList.add('show');showControls();
  requestAnimationFrame(function(){if(bar){bar.style.transition='width '+sec+'s linear';bar.style.width='0%'}});
  var start=Date.now();
  _autoNextTimer=setInterval(function(){
    var left=sec-Math.floor((Date.now()-start)/1000);
    if(left<=0){_clearAutoNext();_playNextEp();return}
    txt.textContent='即将播放下一集 ('+left+'s)';
  },250);
  var bp=document.getElementById('anPlay'),bc=document.getElementById('anCancel');
  if(bp)bp.onclick=function(){_clearAutoNext();_playNextEp()};
  if(bc)bc.onclick=function(){_clearAutoNext()};
}
video.addEventListener('ended',function(){
  if(!_autoNextOn)return;
  if(!pSources||!pSources.length)return;
  var src=pSources[pCurSrc||0];if(!src||!src.episodes)return;
  var idx=getCurrentEpIdx();
  if(idx<0)return;
  if(idx>=src.episodes.length-1){_toast('已经是最后一集了');return}
  _showAutoNextPanel();
});
// 统一播放入口：根据 URL 类型选择正确的播放方式
function _startPlay(url){
  if(!url){_hideLoader();showError('无播放地址');return}
  // 保存播放历史（不传progress，避免覆盖已有进度）
  try{
    var _hti=VOD_URL?VOD_URL.replace(/[^a-zA-Z0-9]/g,'_'):'';
    var _hMovieName='',_hImg='';
    try{var _meta=JSON.parse(sessionStorage.getItem('youzi_tmdb_meta_'+VOD_URL)||'null');if(_meta){_hMovieName=_meta.title||'';_hImg=_meta.img||_meta.backdrop||''}}catch(e2){}
    if(!_hMovieName){try{_hMovieName=sessionStorage.getItem('youzi_tmdb_title_'+VOD_URL)||''}catch(e3){}}
    if(!_hImg){try{_hImg=sessionStorage.getItem('youzi_tmdb_bg_'+VOD_URL)||''}catch(e4){}}
    if(!_hImg&&PARAM_IMG){_hImg=PARAM_IMG;}
    var _hTitle=_hMovieName||MOVIE_TITLE||document.title.split('-')[0].trim()||'';
    if(!_hTitle){try{_hTitle=new URLSearchParams(window.location.search).get('title')||''}catch(eX){}}
    window._hisTitle=_hTitle;window._hisImg=_hImg;
    var _hLineName='';if(pSources&&pSources[pCurSrc||0])_hLineName=pSources[pCurSrc||0].name||'';
    var _hEpTitle='';var _epIdx0=getCurrentEpIdx();if(_epIdx0>=0&&pSources&&pSources[pCurSrc||0]&&pSources[pCurSrc||0].episodes&&pSources[pCurSrc||0].episodes[_epIdx0])_hEpTitle=pSources[pCurSrc||0].episodes[_epIdx0].title||'';
    fetch('/his-add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:_hti,title:_hTitle,url:VOD_URL||'',img:_hImg,source:'bubutv',playUrl:PLAY_URL||'',lineName:_hLineName,episode:_hEpTitle||String(_epIdx0)})}).catch(function(){})
  }catch(e){}
  if(url.indexOf('/vplay/')>-1){
    document.getElementById('sourceInfo').textContent='正在解析...';
    resolveAndPlay(url);
  }else{
    initPlayer(url);
  }
  // 定期保存播放进度（每10秒），同时保存当前集数索引
  clearInterval(window._progressTimer);
  window._progressTimer=setInterval(function(){
    if(!video||!video.duration||video.paused)return;
    var _hti=VOD_URL?VOD_URL.replace(/[^a-zA-Z0-9]/g,'_'):'';
    var _epIdx=getCurrentEpIdx();
    if(_epIdx>=0)try{localStorage.setItem('youzi_ep_idx_'+VOD_URL,String(_epIdx))}catch(e){}
    var _epTitle='';if(_epIdx>=0){var _src=pSources&&pSources[pCurSrc||0];if(_src&&_src.episodes&&_src.episodes[_epIdx])_epTitle=_src.episodes[_epIdx].title||''}
    if(!_epTitle)_epTitle=MOVIE_TITLE||'';
    var _epLineName='';if(pSources&&pSources[pCurSrc||0])_epLineName=pSources[pCurSrc||0].name||'';
    fetch('/his-add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:_hti,progress:Math.floor(video.currentTime),duration:Math.floor(video.duration),lastWatch:Date.now(),episode:_epTitle,lineName:_epLineName})}).catch(function(){})
  },10000);
}
function _playNextEp(){
  if(!pSources||!pSources.length)return;
  var src=pSources[pCurSrc||0];if(!src||!src.episodes)return;
  var idx=getCurrentEpIdx();var next=idx+1;if(next>=src.episodes.length){_toast('已经是最后一集了');return}
  var ep=src.episodes[next];var u=ep.url.charAt(0)==='/'?SITE+ep.url:ep.url;
  PLAY_URL=ep.url;document.title=ep.title;
  var vt=document.getElementById('vTitle');if(vt)vt.textContent=ep.title;
  var ft=document.getElementById('fsTitle');if(ft)ft.textContent=ep.title;
  try{sessionStorage.setItem('youzi_ep_'+VOD_URL,JSON.stringify({sources:pSources}))}catch(e){}
  _clearAutoNext();_showLoader();renderEpList();_startPlay(u);
}
setInterval(function(){if(video&&!video.paused&&!video.ending){_hideLoader()}},500);
video.ontimeupdate=function(){
  var pct=video.duration?(video.currentTime/video.duration*100):0;
  document.getElementById('progressBar').style.width=pct+'%';
  document.getElementById('timeText').textContent=fmt(video.currentTime)+'/'+fmt(video.duration);
};
// 进度条拖拽已由新模块接管
document.getElementById('volSlider').oninput=function(){video.volume=this.value};
document.getElementById('speedBtn').onclick=function(){
  speedIdx=(speedIdx+1)%speeds.length;
  video.playbackRate=speeds[speedIdx];
  this.textContent=speeds[speedIdx]+'x';
};
// ===== 非全屏底部线路/列表 显示隐藏切换（带记忆） =====
var _bottomVisible=true;
try{_bottomVisible=localStorage.getItem('youzi_bottom_visible')!=='0'}catch(e){}
var _ctrlEpBtn=document.getElementById('ctrlEpBtn');
function _applyBottomVisible(){
  var fs=!!(document.fullscreenElement||document.webkitFullscreenElement);
  if(fs)return;
  var srcBar=document.getElementById('srcBar'),epBar=document.getElementById('epBar'),infoBar=document.getElementById('infoBar');
  var d=_bottomVisible?'':'none';
  if(srcBar)srcBar.style.display=d;
  if(epBar)epBar.style.display=d;
  if(infoBar)infoBar.style.display=d;
  if(_ctrlEpBtn)_ctrlEpBtn.classList.toggle('on',_bottomVisible);
}
if(_ctrlEpBtn){
  _ctrlEpBtn.onclick=function(){
    var fs=!!(document.fullscreenElement||document.webkitFullscreenElement);
    if(fs)return;
    _bottomVisible=!_bottomVisible;
    try{localStorage.setItem('youzi_bottom_visible',_bottomVisible?'1':'0')}catch(e){}
    _applyBottomVisible();
  };
}
_applyBottomVisible();
function toggleFullscreen(){
  var v=document.getElementById('playerWrap');
  try{
    if(document.fullscreenElement||document.webkitFullscreenElement){
      (document.exitFullscreen||document.webkitExitFullscreen).call(document);
    }else if(v.requestFullscreen){v.requestFullscreen()}
    else if(v.webkitRequestFullscreen){v.webkitRequestFullscreen()}
    else if(v.webkitEnterFullscreen){v.webkitEnterFullscreen()}
    else if(v.msRequestFullscreen){v.msRequestFullscreen()}
  }catch(e){}
}
function _onFsChange(){var pw=document.getElementById('playerWrap');var fs=!!(document.fullscreenElement||document.webkitFullscreenElement);if(pw){if(fs){pw.classList.add('fs')}else{pw.classList.remove('fs')}}if(fs){document.body.classList.add('fs-mode')}else{document.body.classList.remove('fs-mode')}var ft=document.getElementById('fsTopbar');if(ft){ft.style.opacity=fs?'1':'0';ft.style.pointerEvents=fs?'auto':'none'}if(fs)showControls();if(!fs)_applyBottomVisible()}
document.addEventListener('fullscreenchange',_onFsChange);
document.addEventListener('webkitfullscreenchange',_onFsChange);
// 自动全屏已由偏好逻辑替代
function showControls(){
  document.getElementById('controls').classList.remove('hide');
  var fs=document.getElementById('fsTopbar');if(fs){fs.style.opacity='1';fs.style.pointerEvents='auto'}
  clearTimeout(controlsTimer);
  controlsTimer=setTimeout(function(){document.getElementById('controls').classList.add('hide');var fs2=document.getElementById('fsTopbar');if(fs2){fs2.style.opacity='0';fs2.style.pointerEvents='none'}},3000);
}
document.getElementById('playerWrap').onmousemove=showControls;
// click 已由双击快进/快退模块接管

// 加载集数列表
var pSources=null,pCurSrc=0;
function _matchSrcIdx(){if(!pSources||!pSources.length)return 0;var _pu=_normUrl(PLAY_URL);for(var i=0;i<pSources.length;i++){var src=pSources[i];if(!src||!src.episodes)continue;for(var j=0;j<src.episodes.length;j++){var _eu=src.episodes[j].url.charAt(0)==='/'?SITE+src.episodes[j].url:src.episodes[j].url;if(_normUrl(_eu)===_pu||_pu===src.episodes[j].url||_pu.indexOf(src.episodes[j].url)>-1||src.episodes[j].url.indexOf(PLAY_URL)>-1)return i}}return 0}
function loadEpisodes(){
  if(!VOD_URL){document.getElementById('epBar').innerHTML='<div style="color:#ff6b6b;padding:10px">无VOD_URL</div>';return}
  // 优先使用传入的集数列表（本地JSON数据源）
  if(PRESET_SOURCES&&PRESET_SOURCES.length){
    pSources=PRESET_SOURCES;pCurSrc=_matchSrcIdx();
    try{sessionStorage.setItem('youzi_ep_'+VOD_URL,JSON.stringify({sources:PRESET_SOURCES}))}catch(e){}
    renderSrcTabs();renderEpList();return;
  }
  try{var _c=JSON.parse(sessionStorage.getItem('youzi_ep_'+VOD_URL)||'null');if(_c&&_c.sources&&_c.sources.length){pSources=_c.sources;pCurSrc=_matchSrcIdx();renderSrcTabs();renderEpList();return}}catch(e){}
  var bar=document.getElementById('epBar');
  bar.innerHTML='<div style="color:rgba(255,255,255,.5);padding:10px">加载集数...</div>';
  fetch('/api/parse-play?url='+encodeURIComponent(VOD_URL)).then(function(r){return r.json()}).then(function(j){
    if(!j.ok||!j.sources||!j.sources.length){bar.innerHTML='<div style="color:#ff6b6b;padding:10px">无播放源</div>';return}
    pSources=j.sources;pCurSrc=_matchSrcIdx();
    try{sessionStorage.setItem('youzi_ep_'+VOD_URL,JSON.stringify({sources:j.sources}))}catch(e){}
    renderSrcTabs();
    renderEpList();
  }).catch(function(e){bar.innerHTML='<div style="color:#ff6b6b;padding:10px">加载失败</div>'});
}
function renderSrcTabs(){
  var bar=document.getElementById('srcBar');bar.innerHTML='';
  if(!pSources||pSources.length<=1)return;
  pSources.forEach(function(src,i){
    var b=document.createElement('div');b.className='src-btn'+(i===pCurSrc?' on':'');
    b.textContent=src.name+(src.episodes?' ('+src.episodes.length+')':'');
    b.onclick=function(){pCurSrc=i;renderSrcTabs();renderEpList();updatePrevNext()};
    bar.appendChild(b)
  });
}
function updatePrevNext(){var idx=getCurrentEpIdx();if(idx<0){try{idx=parseInt(localStorage.getItem('youzi_ep_idx_'+VOD_URL)||'-1')}catch(e){}}var total=((pSources[pCurSrc||0]||{}).episodes||[]).length;var disPrev=idx<=0,disNext=idx<0||idx>=total-1;if(_prevBtn){_prevBtn.disabled=disPrev;_prevBtn.style.opacity=disPrev?'.3':'1'}if(_nextBtn){_nextBtn.disabled=disNext;_nextBtn.style.opacity=disNext?'.3':'1'}if(_fsPrev){_fsPrev.disabled=disPrev;_fsPrev.style.opacity=disPrev?'.3':'1'}if(_fsNext){_fsNext.disabled=disNext;_fsNext.style.opacity=disNext?'.3':'1'}var _ip=document.getElementById('ifPrevEp'),_in=document.getElementById('ifNextEp');if(_ip){_ip.disabled=disPrev;_ip.style.opacity=disPrev?'.3':'1'}if(_in){_in.disabled=disNext;_in.style.opacity=disNext?'.3':'1'}}
function renderEpList(){
  var bar=document.getElementById('epBar');bar.innerHTML='';
  if(!pSources||!pSources.length)return;
  var src=pSources[pCurSrc]||pSources[0];
  if(!src||!src.episodes||!src.episodes.length)return;
  src.episodes.forEach(function(ep,idx){
    var b=document.createElement('div');b.className='ep-btn';
    b.textContent=ep.title;
    var _pu=_normUrl(PLAY_URL);var _eu2=ep.url.charAt(0)==='/'?SITE+ep.url:ep.url;if(_pu&&(_normUrl(_eu2)===_pu||_pu===ep.url||_pu.indexOf(ep.url)>-1||ep.url.indexOf(PLAY_URL)>-1||_normUrl(ep.url).indexOf(_pu)>-1))b.classList.add('on');
    b.onclick=function(){
      var u=ep.url.charAt(0)==='/'?SITE+ep.url:ep.url;
      try{sessionStorage.setItem('youzi_ep_'+VOD_URL,JSON.stringify({sources:pSources}))}catch(e){}
      location.replace('/player?url='+encodeURIComponent(u)+'&title='+encodeURIComponent(ep.title)+'&vod='+encodeURIComponent(VOD_URL));
    };
    bar.appendChild(b)
  });
  updatePrevNext();
  var cur=bar.querySelector('.ep-btn.on');
  if(!cur){
    var _savedIdx=-1;
    try{_savedIdx=parseInt(localStorage.getItem('youzi_ep_idx_'+VOD_URL)||'-1')}catch(e){}
    if(_savedIdx>=0&&_savedIdx<bar.children.length){bar.children[_savedIdx].classList.add('on');cur=bar.children[_savedIdx]}
    else{var first=bar.querySelector('.ep-btn');if(first){first.classList.add('on');cur=first}}
  }
  if(cur)cur.scrollIntoView({behavior:'smooth',inline:'center'});
}

function resolveAndPlay(url){
  var _s=document.getElementById('sourceInfo');
  _s.textContent='[4] 解析: '+url.substring(0,80);
  fetch('/api/play-url?url='+encodeURIComponent(url)).then(function(r){return r.json()}).then(function(j){
    if(j.ok&&j.data&&j.data.url){
      var vurl=j.data.url;
      if(j.data.encrypt===1){try{vurl=atob(vurl)}catch(e){}}
      if(vurl.charAt(0)==='@')vurl=vurl.substring(1);
      _s.innerHTML='[5] 视频: <a href="'+vurl+'" target="_blank" style="color:#4fc3f7;word-break:break-all;font-size:10px">'+vurl.substring(0,150)+'</a>';
      if(j.data.parse){_setupIframePlayer(vurl)}else{initPlayer(vurl)}
    }else{
      _hideLoader();showError('[4] 失败: '+(j.error||'无地址'));
    }
  }).catch(function(e){_hideLoader();showError('[4] fetch失败: '+e.message)});
}

// ===== 返回按钮 =====
document.getElementById('backBtn').onclick=function(){try{parent.postMessage({type:'dsjShowChrome'},'*')}catch(e){}history.back()};
// ===== 上集/下集/选集/旋转 =====
function _normUrl(u){try{u=decodeURIComponent(u)}catch(e){}var d=document.createElement('div');d.innerHTML=u;var r=d.textContent;return r||u}function _fixEpUrl(u){if(!u)return u;if(u.charAt(0)==='/')return SITE+u;return u}function getCurrentEpIdx(){var src=pSources&&pSources[pCurSrc||0];if(!src||!src.episodes)return-1;var _pu=_normUrl(PLAY_URL);for(var i=0;i<src.episodes.length;i++){var eu=_fixEpUrl(src.episodes[i].url);if(_normUrl(eu)===_pu||_pu===src.episodes[i].url||_pu.indexOf(src.episodes[i].url)>-1||src.episodes[i].url.indexOf(PLAY_URL)>-1)return i}return-1}
function switchEp(dir){_clearAutoNext();if(!pSources||!pSources.length)return;var src=pSources[pCurSrc||0];if(!src||!src.episodes)return;var idx=getCurrentEpIdx();var next=idx+dir;if(next<0||next>=src.episodes.length)return;var ep=src.episodes[next];var u=_fixEpUrl(ep.url);try{sessionStorage.setItem('youzi_ep_'+VOD_URL,JSON.stringify({sources:pSources}))}catch(e){}
location.replace('/player?url='+encodeURIComponent(u)+'&title='+encodeURIComponent(ep.title)+'&vod='+encodeURIComponent(VOD_URL))}
var _prevBtn=document.getElementById('prevEp'),_nextBtn=document.getElementById('nextEp'),_showEpBtn=document.getElementById('showEpBtn'),_rotateBtn=document.getElementById('rotateBtn');
if(_prevBtn)_prevBtn.onclick=function(){switchEp(-1)};
if(_nextBtn)_nextBtn.onclick=function(){switchEp(1)};
if(_showEpBtn)_showEpBtn.onclick=function(){var bar=document.getElementById('epBar'),srcBar=document.getElementById('srcBar');if(bar){var vis=bar.style.display!=='none';bar.style.display=vis?'none':'';if(srcBar)srcBar.style.display=vis?'none':'';if(!vis){bar.scrollIntoView({behavior:'smooth'})}}};
if(_rotateBtn)_rotateBtn.onclick=function(){var v=document.getElementById('video');var rot=((parseInt(v.getAttribute('data-rot')||'0'))+90)%360;v.setAttribute('data-rot',rot);var vw=v.videoWidth||v.width||16,vh=v.videoHeight||v.height||9;var wrap=document.getElementById('playerWrap');var cw=wrap.clientWidth||window.innerWidth,ch=wrap.clientHeight||window.innerHeight;if(rot===90||rot===270){var sw=cw/vh,sh=ch/vw;var s=Math.min(sw,sh);var dw=vw*s,dh=vh*s;v.style.width=dw+'px';v.style.height=dh+'px';v.style.position='absolute';v.style.left='50%';v.style.top='50%';v.style.transform='translate(-50%,-50%) rotate('+rot+'deg)';v.style.objectFit='fill'}else if(rot===180){v.style.cssText='width:100%;height:100%;object-fit:contain;transform:rotate(180deg)'}else{v.style.cssText='width:100%;height:100%;object-fit:contain'}this.classList.toggle('rotated',rot!==0)}
// 全屏按钮绑定
var _fsPrev=document.getElementById('fsPrevEp'),_fsNext=document.getElementById('fsNextEp'),_fsShowEp=document.getElementById('fsShowEp'),_fsRot=document.getElementById('fsRotate');
if(_fsPrev)_fsPrev.onclick=function(){switchEp(-1)};
if(_fsNext)_fsNext.onclick=function(){switchEp(1)};
if(_fsShowEp)_fsShowEp.onclick=function(){var panel=document.getElementById('fsEpPanel');if(!panel)return;panel.classList.toggle('show');if(panel.classList.contains('show')){_renderFsEpisodes(panel)}};
function _renderFsEpisodes(panel){panel.innerHTML='';if(!pSources||!pSources.length){panel.innerHTML='<div style="color:rgba(255,255,255,.5);padding:10px">无集数</div>';return}var src=pSources[pCurSrc||0]||pSources[0];if(!src||!src.episodes)return;src.episodes.forEach(function(ep){var b=document.createElement('span');b.className='ep-item';b.textContent=ep.title;var _pu=_normUrl(PLAY_URL);var _eu=_fixEpUrl(ep.url);if(_normUrl(_eu)===_pu||_pu===ep.url)b.classList.add('on');b.onclick=function(){panel.classList.remove('show');location.replace('/player?url='+encodeURIComponent(_fixEpUrl(ep.url))+'&title='+encodeURIComponent(ep.title)+'&vod='+encodeURIComponent(VOD_URL))};panel.appendChild(b)})}
if(_fsRot)_fsRot.onclick=function(){if(_rotateBtn)_rotateBtn.click()};
// ===== 自动连播开关绑定 =====
var _anBtn=document.getElementById('autoNextBtn'),_fsAnBtn=document.getElementById('fsAutoNextBtn');
if(_anBtn)_anBtn.onclick=_toggleAutoNext;
if(_fsAnBtn)_fsAnBtn.onclick=_toggleAutoNext;
_updateAutoNextBtn();
window.addEventListener('beforeunload',function(){_clearAutoNext()});
// ===== 单击显示控件 / 双击播放暂停 =====
var lastTapTime=0,singleTapTimer=null;
document.getElementById('playerWrap').addEventListener('click',function(e){if(e.target.closest('button,input,.controls,.fs-topbar,.fs-ep-panel,.auto-next,.ep-bar,.src-bar,.progress,.loading-overlay'))return;var now=Date.now();if(now-lastTapTime<300){clearTimeout(singleTapTimer);singleTapTimer=null;lastTapTime=0;video.paused?video.play():video.pause();showControls()}else{lastTapTime=now;singleTapTimer=setTimeout(function(){if(lastTapTime===now){showControls()}lastTapTime=0},310)}});
// ===== 左右滑动快进快退 / 上下滑动切集 =====
(function(){
  var pw=document.getElementById('playerWrap');if(!pw)return;
  var startX=0,startY=0,startTime=0,swiping=false;
  pw.addEventListener('touchstart',function(e){if(e.touches.length!==1)return;startX=e.touches[0].clientX;startY=e.touches[0].clientY;startTime=Date.now();swiping=true},{passive:true});
  pw.addEventListener('touchmove',function(e){if(swiping&&e.touches.length===1){var dx=e.touches[0].clientX-startX;var dy=e.touches[0].clientY-startY;if(Math.abs(dx)>10||Math.abs(dy)>10){e.preventDefault()}}},{passive:false});
  pw.addEventListener('touchend',function(e){
    if(!swiping)return;swiping=false;
    var dx=e.changedTouches[0].clientX-startX;
    var dy=e.changedTouches[0].clientY-startY;
    var dt=Date.now()-startTime;
    if(dt>600)return;
    var adx=Math.abs(dx),ady=Math.abs(dy);
    if(adx>ady&&adx>40){
      // 左右滑动：快进/快退
      var sec=Math.min(60,Math.round(adx/20)*10);
      if(dx>0){video.currentTime=Math.min(video.duration||0,video.currentTime+sec);_toast('快进'+sec+'秒')}else{video.currentTime=Math.max(0,video.currentTime-sec);_toast('快退'+sec+'秒')}
      showControls()
    }else if(ady>adx&&ady>60){
      // 上下滑动：切集
      if(dy<0){switchEp(1)}else{switchEp(-1)}
    }
  },{passive:true});
})();
// ===== 进度条拖拽 =====
(function(){var prog=document.getElementById('progress');var bar=document.getElementById('progressBar');var dragging=false;function seek(e){var r=prog.getBoundingClientRect();var cx=e.touches?e.touches[0].clientX:e.clientX;var p=Math.max(0,Math.min(1,(cx-r.left)/r.width));if(video.duration){video.currentTime=p*video.duration;bar.style.width=(p*100)+'%';document.getElementById('timeText').textContent=fmt(video.currentTime)+'/'+fmt(video.duration)}}prog.addEventListener('mousedown',function(e){dragging=true;seek(e)});document.addEventListener('mousemove',function(e){if(dragging)seek(e)});document.addEventListener('mouseup',function(){dragging=false});prog.addEventListener('touchstart',function(e){dragging=true;seek(e)},{passive:true});document.addEventListener('touchmove',function(e){if(dragging)seek(e)},{passive:true});document.addEventListener('touchend',function(){dragging=false});
})();
// ===== 自动全屏改为记住偏好 =====
var _wantFS=false;try{_wantFS=localStorage.getItem('youzi_player_fs')==='1'}catch(e){}
if(_wantFS){video.addEventListener('playing',function(){toggleFullscreen()},{once:true})}
document.addEventListener('webkitfullscreenchange',function(){try{localStorage.setItem('youzi_player_fs',document.webkitFullscreenElement?'1':'0')}catch(e){}});
document.addEventListener('fullscreenchange',function(){try{localStorage.setItem('youzi_player_fs',document.fullscreenElement?'1':'0')}catch(e){}});
// ===== info-bar 动态显隐 =====
video.addEventListener('waiting',function(){document.getElementById('infoBar').style.display=''});
video.addEventListener('canplay',function(){setTimeout(function(){if(!video.paused)document.getElementById('infoBar').style.display='none'},500)});
if(PLAY_URL){
  _startPlay(PLAY_URL);
}else if(VOD_URL){
  var _info=document.getElementById('sourceInfo');_info.textContent='正在加载...';
  try{var _epc=JSON.parse(sessionStorage.getItem('youzi_ep_'+VOD_URL)||'null');if(_epc&&_epc.sources){pSources=_epc.sources;renderSrcTabs();renderEpList()}}catch(e){}
  fetch('/api/parse-play?url='+encodeURIComponent(VOD_URL)).then(function(r){return r.json()}).then(function(j){
    if(j.ok&&j.sources&&j.sources[0]&&j.sources[0].episodes&&j.sources[0].episodes.length){
      var ep=j.sources[0].episodes[0];document.getElementById('vTitle').textContent=ep.title;
      try{sessionStorage.setItem('youzi_ep_'+VOD_URL,JSON.stringify({sources:j.sources}))}catch(e){}
      PLAY_URL=ep.url.charAt(0)==='/'?SITE+ep.url:ep.url;
      renderSrcTabs();renderEpList();
      resolveAndPlay(ep.url);
    }else{_hideLoader();showError('未找到播放源')}
  }).catch(function(e){_hideLoader();showError('加载失败: '+e.message)});
}
(function(){var _c=null;try{_c=JSON.parse(sessionStorage.getItem('youzi_ep_'+VOD_URL)||'null')}catch(e){}if(_c&&_c.sources&&_c.sources.length>1){pSources=_c.sources;pCurSrc=_matchSrcIdx();renderSrcTabs();renderEpList()}else{loadEpisodes()}})();
<\/script></body></html>`;
}

// ========== HTTP路由 ==========
// EPG 缓存：避免每次 /epg 请求都重新下载整个 XML
var _epgCacheData = null;   // 解析后的全量 EPG 数据 {channelId: {name, current, next}}
var _epgCacheTime = 0;      // 缓存时间戳
var _epgCacheLoading = false;
var _epgCacheWaiters = [];  // 等待中的回调
var _EPG_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

function _parseEpgAll(xml) {
  var now = Date.now(), result = {}, chMap = {};
  xml.replace(/<channel[^>]*id="([^"]*)"[^]*?<\/channel>/gi, function(m, id) {
    var nm = m.match(/<display-name[^>]*>([^<]*)<\/display-name>/i);
    if (nm) chMap[id.trim().toLowerCase()] = nm[1].trim();
  });
  xml.replace(/<programme[^>]*start="([^"]*)"[^>]*stop="([^"]*)"[^>]*channel="([^"]*)"[^]*?<\/programme>/gi, function(m, start, stop, cid) {
    var cc = cid.trim().toLowerCase();
    var tm = m.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (!tm) return;
    var st = _epgTs(start), en = _epgTs(stop);
    if (!result[cc]) result[cc] = {name: chMap[cc]||cc, current: null, next: null};
    if (st <= now && en > now) result[cc].current = {title:tm[1].trim(),start:st,stop:en};
    else if (st > now && !result[cc].next) result[cc].next = {title:tm[1].trim(),start:st,stop:en};
  });
  return result;
}

function _parseEpg(xml, ch, res) {
  try {
    if (!_epgCacheData) {
      _epgCacheData = _parseEpgAll(xml);
      _epgCacheTime = Date.now();
    }
    var result = {};
    if (ch) {
      for (var k in _epgCacheData) {
        if (k === ch || (_epgCacheData[k].name||'').toLowerCase() === ch) { result[k] = _epgCacheData[k]; break; }
      }
    }
    send(res, 200, JSON.stringify({ok:true, data:result}), 'application/json');
  } catch(e) { send(res, 200, JSON.stringify({ok:false,error:e.message}), 'application/json'); }
}
function _epgTs(s) {
  if (!s) return 0;
  var m = s.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]?)(\d{2})(\d{2})/);
  if (!m) return 0;
  var ts = Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]);
  if (m[7]) { var sign=m[7]==='-'?-1:1; ts -= sign*(+m[8]*3600+m[9]*60)*1000; }
  return ts;
}

// ========== 本地JSON影片库页面HTML ==========
function localHtml(file) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>本地影片库</title>
<style>
${COMMON_STYLE}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.title{display:flex;align-items:center;justify-content:space-between;font-size:18px;font-weight:700;margin:4px 0 14px;min-height:36px}
.title-text{flex:1;min-width:0}
.title .back{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);box-shadow:0 2px 12px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1);color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.title .back:active{background:rgba(255,255,255,.2);transform:scale(.92)}
.list{display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:12px;background:rgba(255,255,255,.06);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s}
.row:active{transform:scale(.98)}
.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}
.sposter img{width:100%;height:100%;object-fit:cover;display:block}
.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}
.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;padding:0}
.sname{font-size:16px;font-weight:700;word-break:break-all;line-height:1.3;flex-shrink:0;margin-bottom:2px}
.sactors{font-size:12px;color:rgba(255,193,112,.85);line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px;flex-shrink:0}
.sintro{font-size:13px;color:rgba(255,255,255,.6);line-height:1.4;margin-top:4px;flex:1;min-height:0;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;text-overflow:ellipsis;word-break:break-all}
.smeta{font-size:12px;color:rgba(47,79,79,.55);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;margin-top:auto;padding-top:2px}
.cat-bar{display:flex;gap:8px;margin-bottom:14px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:2px;scrollbar-width:none}
.cat-bar::-webkit-scrollbar{display:none}
.cat-btn{flex-shrink:0;padding:7px 18px;border-radius:20px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:rgba(255,255,255,.6);font-size:14px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap}
.cat-btn.active{background:rgba(79,195,247,.2);border-color:rgba(79,195,247,.4);color:#4fc3f7}
.cat-btn:active{transform:scale(.95)}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap"><div class="title"><div class="title-text" id="titleText">本地影片库（0个）</div><button class="back" onclick="goBack()">←</button></div><div class="cat-bar" id="catBar"><button class="cat-btn active" data-cat="">全部</button><button class="cat-btn" data-cat="movie">电影</button><button class="cat-btn" data-cat="tv">电视剧</button><button class="cat-btn" data-cat="other">其他</button></div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var file=${JSON.stringify(file||'')},page=0,loading=false,finished=false,count=0,curCat='';
var _sk='local_scroll_'+file,_pk='local_page_'+file,_ck='local_cat_'+file;
function el(s){return document.querySelector(s)}
function goBack(){
  sessionStorage.setItem(_sk,window.scrollY);
  try{parent.postMessage({type:'dsjClose'},'*')}catch(e){history.back()}
}
function openVod(it){
  sessionStorage.setItem(_sk,window.scrollY);
  if(it.sources&&it.sources.length){
    var bestEp=null;
    for(var si=0;si<it.sources.length;si++){
      var eps=it.sources[si].episodes||[];
      for(var sj=0;sj<eps.length;sj++){
        if(eps[sj].url&&/\.m3u8/i.test(eps[sj].url)){bestEp=eps[sj];break}
      }
      if(bestEp)break;
    }
    if(!bestEp){bestEp=it.sources[0].episodes[0]}
    if(bestEp){
      var _src=encodeURIComponent(JSON.stringify(it.sources));
      location.href='/player?url='+encodeURIComponent(bestEp.url)+'&title='+encodeURIComponent(it.title||bestEp.title||'')+'&vod='+encodeURIComponent(it.vodUrl||'')+'&img='+encodeURIComponent(it.img||'')+'&src='+_src;
      return;
    }
  }
  if(it.playUrl){
    location.href='/player?url='+encodeURIComponent(it.playUrl)+'&title='+encodeURIComponent(it.title||'')+'&vod='+encodeURIComponent(it.vodUrl||'')+'&img='+encodeURIComponent(it.img||'');
    return;
  }
  if(window.parent!==window){try{parent.postMessage({type:'dsjDetail',item:it},'*')}catch(e){location.href=it.url||''}}else{location.href='/tmdb-page?vodUrl='+encodeURIComponent(it.url||'')+'&title='+encodeURIComponent(it.title||'')+'&img='+encodeURIComponent(it.img||'')}
}
function row(it){
  var d=document.createElement('div');d.className='row';
  var sposter=document.createElement('div');sposter.className='sposter';
  var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';sposter.appendChild(img);
  if(it.tag){var tagEl=document.createElement('span');tagEl.className='sptext';tagEl.textContent=it.tag;sposter.appendChild(tagEl)}
  d.appendChild(sposter);
  var sinfo=document.createElement('div');sinfo.className='sinfo';
  var sname=document.createElement('div');sname.className='sname';sname.textContent=it.title;sinfo.appendChild(sname);
  if(it.actors){var sactors=document.createElement('div');sactors.className='sactors';sactors.textContent=it.actors;sinfo.appendChild(sactors)}
  if(it.intro){var sintro=document.createElement('div');sintro.className='sintro';sintro.textContent=it.intro;sinfo.appendChild(sintro)}
  var parts=[];if(it.meta)parts.push(it.meta);
  if(parts.length){var sbottom=document.createElement('div');sbottom.className='smeta';sbottom.textContent=parts.join(' | ');sinfo.appendChild(sbottom)}
  d.appendChild(sinfo);
  img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'};
  d.onclick=function(){openVod(it)};
  return d;
}
function switchCat(cat){
  curCat=cat;
  page=0;count=0;finished=false;loading=false;
  el('#list').innerHTML='';
  el('#tip').textContent='准备加载...';
  el('#titleText').textContent='本地影片库（0个）';
  sessionStorage.setItem(_ck,cat);
  load();
}
document.querySelectorAll('.cat-btn').forEach(function(btn){
  btn.onclick=function(){
    document.querySelectorAll('.cat-btn').forEach(function(b){b.classList.remove('active')});
    btn.classList.add('active');
    switchCat(btn.dataset.cat);
  };
});
function load(){
  if(loading||finished)return;loading=true;
  var next=page+1;
  el('#tip').textContent='正在加载第 '+next+' 页...';
  fetch('/local-api?file='+encodeURIComponent(file)+'&page='+next+'&category='+encodeURIComponent(curCat)).then(r=>r.json()).then(j=>{
    if(!j.ok)throw new Error(j.error||'load failed');
    if(!j.items.length){finished=true;el('#tip').textContent=count?'-- 已显示全部 --':'未找到内容';return}
    page=next;
    sessionStorage.setItem(_pk,page);
    j.items.forEach(function(it){el('#list').appendChild(row(it));count++});
    el('#titleText').textContent='本地影片库（'+count+'/'+(j.total||count)+'个）';
    el('#tip').textContent=count>=(j.total||count)?'-- 已显示全部 --':'下滑加载更多...';
  }).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)}).finally(()=>loading=false)
}
// 恢复分类选择
var savedCat=sessionStorage.getItem(_ck)||'';
if(savedCat&&savedCat!==curCat){
  curCat=savedCat;
  document.querySelectorAll('.cat-btn').forEach(function(b){
    b.classList.toggle('active',b.dataset.cat===savedCat);
  });
}
// 恢复之前加载的页数（快速加载到上次位置）
var savedPage=parseInt(sessionStorage.getItem(_pk)||'0');
var savedScroll=parseInt(sessionStorage.getItem(_sk)||'0');
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));
if(savedPage>1){
  // 快速加载到上次的页数
  var _fastLoad=function(p){
    if(p>savedPage){
      // 加载完毕，恢复滚动位置
      window.scrollTo(0,savedScroll);
      sessionStorage.removeItem(_sk);
      return;
    }
    el('#tip').textContent='正在恢复...'+p+'/'+savedPage;
    fetch('/local-api?file='+encodeURIComponent(file)+'&page='+p+'&category='+encodeURIComponent(curCat)).then(r=>r.json()).then(j=>{
      if(j.ok&&j.items.length){
        page=p;
        j.items.forEach(function(it){el('#list').appendChild(row(it));count++});
        el('#titleText').textContent='本地影片库（'+count+'/'+(j.total||count)+'个）';
        _fastLoad(p+1);
      }else{
        window.scrollTo(0,savedScroll);
        sessionStorage.removeItem(_sk);
      }
    }).catch(function(){
      window.scrollTo(0,savedScroll);
      sessionStorage.removeItem(_sk);
    });
  };
  _fastLoad(1);
}else{
  load();
}
<\/script></body></html>`;
}

// ========== 本地影片搜索页面HTML ==========
function localSearchHtml(wd) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>本地搜索 ${esc(wd)}</title>
<style>
${COMMON_STYLE}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.title{display:flex;align-items:center;justify-content:space-between;font-size:18px;font-weight:700;margin:4px 0 14px;min-height:36px}
.title-text{flex:1;min-width:0}
.title .back{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);box-shadow:0 2px 12px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1);color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.title .back:active{background:rgba(255,255,255,.2);transform:scale(.92)}
.list{display:flex;flex-direction:column;gap:12px}
.search-box{display:flex;gap:8px;margin-bottom:14px}
.search-box input{flex:1;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:10px 14px;color:#fff;font-size:15px;outline:none}
.search-box input::placeholder{color:rgba(255,255,255,.4)}
.search-box button{flex-shrink:0;padding:0 18px;background:rgba(79,195,247,.2);border:1px solid rgba(79,195,247,.35);border-radius:12px;color:#4fc3f7;font-size:14px;font-weight:600;cursor:pointer}
.search-box button:active{background:rgba(79,195,247,.35)}
.row{display:flex;gap:12px;background:rgba(255,255,255,.06);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s}
.row:active{transform:scale(.98)}
.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}
.sposter img{width:100%;height:100%;object-fit:cover;display:block}
.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}
.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;padding:0}
.sname{font-size:16px;font-weight:700;word-break:break-all;line-height:1.3;flex-shrink:0;margin-bottom:2px}
.sactors{font-size:12px;color:rgba(255,193,112,.85);line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px;flex-shrink:0}
.sintro{font-size:13px;color:rgba(255,255,255,.6);line-height:1.4;margin-top:4px;flex:1;min-height:0;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;text-overflow:ellipsis;word-break:break-all}
.smeta{font-size:11px;color:rgba(255,255,255,.55);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;margin-top:auto;padding-top:2px}
.sbottom{display:flex;align-items:center;gap:10px;margin-top:6px;flex-shrink:0;font-size:11px;color:rgba(255,255,255,.45);line-height:1.3}.sbottom-item{display:flex;align-items:center;gap:3px}.sbottom-sep{color:rgba(255,255,255,.2)}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap"><div class="title"><div class="title-text" id="titleText">本地搜索</div><button class="back" onclick="goBack()">←</button></div><div class="search-box"><input id="searchInput" placeholder="搜索本地影片..." value="${esc(wd)}"><button id="searchBtn">搜索</button></div><div class="list" id="list"></div><div class="tip" id="tip">${wd?'正在搜索...':'输入关键词搜索'}</div></div>
<script>
var wd=${JSON.stringify(wd||'')},count=0;
if(window.parent===window){var _bs=document.createElement('style');_bs.textContent='html,body{background:#0a0e1a!important}';document.head.appendChild(_bs)}
function el(s){return document.querySelector(s)}
function goBack(){try{parent.postMessage({type:'dsjClose'},'*')}catch(e){history.back()}}
function openVod(it){
  if(it.sources&&it.sources.length){
    var bestEp=null;
    for(var si=0;si<it.sources.length;si++){
      var eps=it.sources[si].episodes||[];
      for(var sj=0;sj<eps.length;sj++){
        if(eps[sj].url&&/\.m3u8/i.test(eps[sj].url)){bestEp=eps[sj];break}
      }
      if(bestEp)break;
    }
    if(!bestEp){bestEp=it.sources[0].episodes[0]}
    if(bestEp){
      var _src=encodeURIComponent(JSON.stringify(it.sources));
      location.href='/player?url='+encodeURIComponent(bestEp.url)+'&title='+encodeURIComponent(it.title||bestEp.title||'')+'&vod='+encodeURIComponent(it.vodUrl||'')+'&img='+encodeURIComponent(it.img||'')+'&src='+_src;
      return;
    }
  }
  if(it.playUrl){
    location.href='/player?url='+encodeURIComponent(it.playUrl)+'&title='+encodeURIComponent(it.title||'')+'&vod='+encodeURIComponent(it.vodUrl||'')+'&img='+encodeURIComponent(it.img||'');
    return;
  }
  if(window.parent!==window){try{parent.postMessage({type:'dsjDetail',item:it},'*')}catch(e){location.href=it.url||''}}else{location.href='/tmdb-page?vodUrl='+encodeURIComponent(it.url||'')+'&title='+encodeURIComponent(it.title||'')+'&img='+encodeURIComponent(it.img||'')}
}
function row(it){
  var d=document.createElement('div');d.className='row';
  var sposter=document.createElement('div');sposter.className='sposter';
  var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';sposter.appendChild(img);
  if(it.tag){var tagEl=document.createElement('span');tagEl.className='sptext';tagEl.textContent=it.tag;sposter.appendChild(tagEl)}
  d.appendChild(sposter);
  var sinfo=document.createElement('div');sinfo.className='sinfo';
  var sname=document.createElement('div');sname.className='sname';sname.textContent=it.title;sinfo.appendChild(sname);
  if(it.actors){var sactors=document.createElement('div');sactors.className='sactors';sactors.textContent='\u{1F916} '+it.actors;sinfo.appendChild(sactors)}
  if(it.intro){var sintro=document.createElement('div');sintro.className='sintro';sintro.textContent=it.intro;sinfo.appendChild(sintro)}
  var parts=[];if(it.infoTime)parts.push(it.infoTime);if(it.score)parts.push('\u2B50 '+it.score);if(it.hits)parts.push('\uD83D\uDD25 '+it.hits);if(it.meta)parts.push(it.meta);if(it.fromFile)parts.push(it.fromFile);
  if(parts.length){var sbottom=document.createElement('div');sbottom.className='sbottom';sbottom.innerHTML=parts.map(function(p){return'<span class="sbottom-item">'+p+'</span>'}).join('<span class="sbottom-sep"> | </span>');sinfo.appendChild(sbottom)}
  d.appendChild(sinfo);
  img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'};
  d.onclick=function(){openVod(it)};
  return d;
}
function doSearch(keyword){
  if(!keyword.trim()){el('#list').innerHTML='';el('#tip').textContent='输入关键词搜索';el('#titleText').textContent='本地搜索';return}
  el('#list').innerHTML='';count=0;
  el('#tip').textContent='正在搜索「'+keyword+'」...';
  el('#titleText').textContent='本地搜索';
  fetch('/local-search-api?wd='+encodeURIComponent(keyword)).then(r=>r.json()).then(j=>{
    if(!j.ok)throw new Error(j.error||'search failed');
    if(!j.items.length){el('#tip').textContent='未找到匹配内容';return}
    j.items.forEach(function(it){el('#list').appendChild(row(it));count++});
    el('#titleText').textContent='本地搜索「'+keyword+'」（'+count+'个）';
    el('#tip').textContent='共 '+count+' 个结果';
  }).catch(e=>{el('#tip').textContent='搜索失败：'+(e.message||e)})
}
el('#searchBtn').onclick=function(){doSearch(el('#searchInput').value)};
el('#searchInput').onkeydown=function(e){if(e.key==='Enter'||e.keyCode===13){doSearch(this.value)}};
if(wd)doSearch(wd);
<\/script></body></html>`;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://0.0.0.0:${PORT}`);
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (pathname === '/health') return send(res, 200, 'ok');

  // 网站地址读写
  if (pathname === '/site-url') {
    if (req.method === 'GET') {
      return send(res, 200, JSON.stringify({ url: SITE }), 'application/json');
    }
    if (req.method === 'POST') {
      var body = '';
      req.on('data', function(c) { body += c; });
      req.on('end', function() {
        try {
          var data = JSON.parse(body);
          var newUrl = (data.url || '').trim().replace(/\/+$/, '');
          if (!newUrl || !/^https?:\/\//.test(newUrl)) return send(res, 400, JSON.stringify({ ok: false, error: 'bad url' }), 'application/json');
          fs.writeFileSync(_SITE_CONFIG_FILE, JSON.stringify({ url: newUrl }, null, 2), 'utf-8');
          send(res, 200, JSON.stringify({ ok: true, url: newUrl }), 'application/json');
        } catch (e) {
          send(res, 500, JSON.stringify({ ok: false, error: e.message }), 'application/json');
        }
      });
      return;
    }
  }

  // 源切换 API
  if (pathname === '/api/source') {
    if (req.method === 'GET') {
      var list = Object.keys(tvboxSources).map(function(key) {
        return { key: key, name: sourceMeta[key].name, logo: sourceMeta[key].logo, active: key === _activeSourceKey };
      });
      return send(res, 200, JSON.stringify({ current: _activeSourceKey, sources: list }), 'application/json');
    }
    if (req.method === 'POST') {
      var body = '';
      req.on('data', function(c) { body += c; });
      req.on('end', function() {
        try {
          var data = JSON.parse(body);
          var key = (data.source || '').trim();
          if (!tvboxSources[key]) return send(res, 400, JSON.stringify({ ok: false, error: 'unknown source' }), 'application/json');
          setActiveSource(key);
          send(res, 200, JSON.stringify({ ok: true, source: key }), 'application/json');
        } catch (e) {
          send(res, 500, JSON.stringify({ ok: false, error: e.message }), 'application/json');
        }
      });
      return;
    }
  }

  if (pathname === '/shutdown') {
    send(res, 200, 'shutting down');
    setTimeout(() => { try { server.close(); } catch(e) {} cache.clear(); }, 200);
    return;
  }

  // 首页数据
  if (pathname === '/home-api') return handleHomeApi(res);

    // 电视直播播放器页面
  if (pathname === '/live-player') {
    var livePage = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;touch-action:none}video{width:100%;height:100%;object-fit:contain;background:#000}.topbar{position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;padding:0 10px;background:linear-gradient(180deg,rgba(0,0,0,.85) 0%,transparent 100%);z-index:100;transition:opacity .3s}.topbar.hide{opacity:0;pointer-events:none}.topbar button{width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}.topbar .t{color:#fff;font-size:14px;font-weight:600;margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}.route-btn{padding:3px 10px;border-radius:12px;background:rgba(79,195,247,.2);border:1px solid rgba(79,195,247,.4);color:#4fc3f7;font-size:11px;cursor:pointer;margin-left:6px;white-space:nowrap;flex-shrink:0;display:flex;align-items:center;gap:3px}.route-btn:active{background:rgba(79,195,247,.35)}.route-overlay{position:fixed;inset:0;z-index:200;animation:fadeIn .15s}.route-bg{position:absolute;inset:0;background:rgba(0,0,0,.4)}.route-panel{position:absolute;top:44px;right:8px;width:180px;max-height:55vh;background:rgba(18,18,28,.96);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:12px;border:1px solid rgba(255,255,255,.1);box-shadow:0 8px 32px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden}.route-header{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between}.route-header .rh-title{color:#fff;font-size:13px;font-weight:700}.route-header .rh-close{width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.08);border:none;color:#aaa;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center}.route-list{overflow-y:auto;padding:4px;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}.route-item{display:flex;align-items:center;padding:8px 10px;border-radius:8px;cursor:pointer;margin-bottom:2px;transition:background .12s;gap:8px}.route-item:active{background:rgba(255,255,255,.06)}.route-item.cur{background:rgba(79,195,247,.15)}.route-item .ri-idx{width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.06);color:rgba(255,255,255,.5);font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;flex-shrink:0}.route-item.cur .ri-idx{background:rgba(79,195,247,.3);color:#4fc3f7}.route-item .ri-name{flex:1;color:#bbb;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.route-item.cur .ri-name{color:#4fc3f7;font-weight:600}.route-item .ri-dot{width:6px;height:6px;border-radius:50%;background:transparent;flex-shrink:0}.route-item.cur .ri-dot{background:#4fc3f7}.ctrlbar{position:fixed;bottom:0;left:0;right:0;height:48px;display:flex;align-items:center;padding:0 10px;gap:8px;background:linear-gradient(0deg,rgba(0,0,0,.85) 0%,transparent 100%);z-index:100;transition:opacity .3s}.ctrlbar.hide{opacity:0;pointer-events:none}.ctrl-btn{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}.progress-wrap{flex:1;height:20px;display:flex;align-items:center;cursor:pointer;position:relative;min-width:0}.progress-bg{width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,.15);position:relative;overflow:hidden}.progress-buffer{position:absolute;left:0;top:0;height:100%;background:rgba(255,255,255,.2);border-radius:2px}.progress-fill{position:absolute;left:0;top:0;height:100%;background:#4fc3f7;border-radius:2px}.progress-dot{position:absolute;top:50%;width:12px;height:12px;border-radius:50%;background:#4fc3f7;transform:translate(-50%,-50%);box-shadow:0 0 4px rgba(79,195,247,.5);opacity:0;transition:opacity .15s}.progress-wrap:hover .progress-dot,.progress-wrap.dragging .progress-dot{opacity:1}.time-label{color:rgba(255,255,255,.7);font-size:11px;white-space:nowrap;flex-shrink:0;min-width:70px;text-align:center}.vol-wrap{display:flex;align-items:center;gap:4px;flex-shrink:0}.vol-icon{color:rgba(255,255,255,.7);font-size:14px;cursor:pointer;width:24px;text-align:center}.vol-bar{width:60px;height:4px;border-radius:2px;background:rgba(255,255,255,.15);cursor:pointer;position:relative}.vol-fill{height:100%;border-radius:2px;background:#4fc3f7;width:100%}.vol-dot{position:absolute;top:50%;width:10px;height:10px;border-radius:50%;background:#4fc3f7;transform:translate(-50%,-50%);right:0;box-shadow:0 0 3px rgba(79,195,247,.4);opacity:0;transition:opacity .15s}.vol-wrap:hover .vol-dot{opacity:1}.loading{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:90;background:rgba(0,0,0,.5);touch-action:none}.spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,.15);border-top-color:#4fc3f7;border-radius:50%;animation:spin .8s linear infinite}.load-text{color:rgba(255,255,255,.7);font-size:13px;margin-top:10px}@keyframes spin{to{transform:rotate(360deg)}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}.channel-toast{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.85);color:#fff;padding:16px 24px;border-radius:12px;font-size:14px;z-index:150;pointer-events:none;opacity:0;transition:opacity .3s;text-align:center;max-width:80vw;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}.channel-toast.show{opacity:1}.swipe-hint{position:fixed;right:16px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;z-index:120;opacity:0;transition:opacity .4s;pointer-events:none}.swipe-hint.show{opacity:.5}.swipe-arrow{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:16px;display:flex;align-items:center;justify-content:center}.swipe-label{color:rgba(255,255,255,.5);font-size:9px;text-align:center}
@keyframes epgScroll{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}.ch-panel{position:fixed;top:0;left:0;bottom:0;width:280px;background:rgba(12,12,24,.97);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);z-index:300;transform:translateX(-100%);transition:transform .25s cubic-bezier(.32,.72,0,1);display:flex;flex-direction:column;border-right:1px solid rgba(255,255,255,.08)}.ch-panel.show{transform:translateX(0)}.ch-panel-bg{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:299;opacity:0;pointer-events:none;transition:opacity .25s}.ch-panel-bg.show{opacity:1;pointer-events:auto}.ch-search{padding:12px;border-bottom:1px solid rgba(255,255,255,.08)}.ch-search input{width:100%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:8px 12px;color:#fff;font-size:13px;outline:none;box-sizing:border-box}.ch-search input::placeholder{color:rgba(255,255,255,.35)}.ch-tabs{display:flex;padding:8px 12px;gap:6px;border-bottom:1px solid rgba(255,255,255,.08);overflow-x:auto;scrollbar-width:none}.ch-tabs::-webkit-scrollbar{display:none}.ch-tab{flex-shrink:0;padding:4px 10px;border-radius:12px;font-size:11px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.6);border:1px solid rgba(255,255,255,.08);cursor:pointer}.ch-tab.on{background:rgba(79,195,247,.2);color:#4fc3f7;border-color:rgba(79,195,247,.3)}.ch-list{flex:1;overflow-y:auto;padding:4px;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}.ch-item{display:flex;align-items:center;padding:10px 12px;border-radius:10px;cursor:pointer;gap:10px;margin-bottom:2px}.ch-item:active{background:rgba(255,255,255,.06)}.ch-item.cur{background:rgba(79,195,247,.12)}.ch-item .ch-name{flex:0 0 auto;max-width:45%;color:#ccc;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ch-item.cur .ch-name{color:#4fc3f7;font-weight:600}.ch-item .ch-epg{flex:1;min-width:0;color:rgba(255,255,255,.4);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ch-item.cur .ch-epg{color:rgba(79,195,247,.6)}.ch-item .ch-fav{width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer;flex-shrink:0;border-radius:50%;background:transparent;border:none}.ch-item .ch-fav:active{background:rgba(255,255,255,.1)}
#audioBg{position:fixed;top:0;left:0;width:100%;height:100%;z-index:1;display:none;overflow:hidden;background:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
#audioBg .vinyl-container{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh}
#audioBg .vinyl-player{position:relative;width:310px;height:310px;border-radius:50%;box-shadow:0 20px 60px rgba(0,0,0,0.8);background:#0a0a0a;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;transition:box-shadow .3s}
#audioBg .vinyl-player::before{content:'';position:absolute;top:0;left:0;width:100%;height:100%;border-radius:50%;border:2px solid #000;pointer-events:none;z-index:5;box-sizing:border-box}
#audioBg .record-disc{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:50%;will-change:transform;transition:transform .2s;z-index:1}
#audioBg .vinyl-base{width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 50% 50%,#2b2b2b 0%,#1f1f1f 22%,#111 24%,#222 26%,#1a1a1a 30%,#0e0e0e 100%),repeating-radial-gradient(circle at 50% 50%,rgba(255,255,255,0.02) 0px,rgba(255,255,255,0.02) 2px,rgba(0,0,0,0.05) 2px,rgba(0,0,0,0.05) 4px);background-blend-mode:overlay,normal;position:relative}
#audioBg .cover-wrapper{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:62%;height:62%;border-radius:50%;box-shadow:0 0 0 3px #333,0 0 0 6px #111,0 8px 25px rgba(0,0,0,0.8);overflow:hidden;background:#222;z-index:2}
#audioBg .cover-wrapper img,#audioBg .cover-wrapper svg{display:block;width:100%;height:100%;object-fit:cover}
#audioBg .cover-wrapper svg.fallback{display:none}
#audioBg .center-hole{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:6%;height:6%;border-radius:50%;background:radial-gradient(circle at 40% 35%,#555,#111);box-shadow:inset 0 2px 4px rgba(255,255,255,0.2),0 0 6px rgba(0,0,0,0.9);z-index:3}
#audioBg .shine{position:absolute;top:-5%;left:-5%;width:110%;height:110%;border-radius:50%;background:radial-gradient(circle at 30% 30%,rgba(255,255,255,0.35),transparent 90%);pointer-events:none;mix-blend-mode:overlay;z-index:1}
#audioBg .tonearm{position:absolute;top:-20px;right:-20px;width:160px;height:160px;z-index:20;pointer-events:none;transform:rotate(25deg);transform-origin:85% 15%;transition:transform .6s cubic-bezier(0.34,1.56,0.64,1)}
#audioBg .tonearm img{display:block;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.3))}
#audioBg .vinyl-player.playing .tonearm{transform:rotate(16deg)}
#audioBg .vinyl-player.paused .tonearm{transform:rotate(32deg)}
#audioBg .spin{animation:vinylSpin 18s linear infinite}
#audioBg .spin-paused{animation-play-state:paused}
@keyframes vinylSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
#audioBg .play-mask{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:50%;z-index:30;display:flex;justify-content:center;align-items:center;background:transparent}
#audioBg .play-btn{width:64px;height:64px;border-radius:50%;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);display:flex;justify-content:center;align-items:center;box-shadow:0 0 0 2px rgba(255,255,255,0.15),0 8px 25px rgba(0,0,0,0.6);transition:transform .2s,background .2s;pointer-events:auto;border:none;outline:none;cursor:pointer}
#audioBg .play-btn:hover{transform:scale(1.08);background:rgba(0,0,0,0.75)}
#audioBg .play-btn svg{width:32px;height:32px;fill:white;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.4))}
#audioBg .song-info{margin-top:30px;text-align:center;color:#898a87}
#audioBg .song-info .title{font-size:18px;font-weight:600;letter-spacing:1px}
#audioBg .song-info .artist{font-size:14px;color:#999;margin-top:4px}
@media(max-width:440px){#audioBg .vinyl-player{width:260px;height:260px}#audioBg .tonearm{width:130px;height:130px;top:-15px;right:-15px}#audioBg .play-btn{width:54px;height:54px}#audioBg .play-btn svg{width:26px;height:26px}}
</style></head><body><div class="topbar" id="topbar"><button id="bb">‹</button><div style="flex:1;min-width:0;overflow:hidden;display:flex;align-items:center"><div class="t" id="tt" style="flex:0 1 auto;max-width:40%;overflow:hidden;text-overflow:ellipsis"></div><div style="flex:1;min-width:0;overflow:hidden;margin-left:8px;text-align:right"><div id="epgInfo" style="font-size:10px;color:rgba(79,195,247,.85);white-space:nowrap;display:inline-block;animation:none"></div></div></div><div class="route-btn" id="routeBtn" style="display:none">📡 总线路</div><div class="route-btn" id="chListBtn" style="margin-left:4px">📋</div></div><div class="loading" id="loading"><div class="spinner"></div><div class="load-text">正在加载...</div></div><video id="v" autoplay muted playsinline webkit-playsinline></video><div id="audioBg"><div class="vinyl-container"><div class="vinyl-player playing" id="vinylPlayer"><div class="record-disc spin" id="vinylDisc"><div class="vinyl-base"><div class="shine"></div><div class="cover-wrapper"><img id="vinylCover" src="" alt="cover" onerror="this.style.display='none';document.getElementById('vinylFallbackSvg').style.display='block';" style="display:block;width:100%;height:100%;object-fit:cover;"><svg id="vinylFallbackSvg" class="fallback" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" style="display:none;"><defs><linearGradient id="vinylGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff7e5f"/><stop offset="100%" stop-color="#feb47b"/></linearGradient></defs><circle cx="150" cy="150" r="150" fill="url(#vinylGrad)"/><text x="50%" y="18%" dominant-baseline="central" text-anchor="middle" font-size="19" fill="white" font-family="Apple Color Emoji, Segoe UI Emoji, sans-serif">🎵</text></svg></div><div class="center-hole"></div></div></div><div class="tonearm" id="vinylTonearm"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 160'%3E%3Cdefs%3E%3ClinearGradient id='a' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23d4d4d4'/%3E%3Cstop offset='50%25' stop-color='%23a0a0a0'/%3E%3Cstop offset='100%25' stop-color='%23707070'/%3E%3C/linearGradient%3E%3CradialGradient id='b' cx='40%25' cy='30%25' r='60%25'%3E%3Cstop offset='0%25' stop-color='%23e8e8e8'/%3E%3Cstop offset='100%25' stop-color='%23888888'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='135' cy='20' r='14' fill='url(%23b)' stroke='%23999' stroke-width='1'/%3E%3Ccircle cx='135' cy='20' r='6' fill='%23fff' opacity='0.3'/%3E%3Cpath d='M 128 28 C 110 25, 90 45, 75 70' stroke='url(%23a)' stroke-width='6' fill='none' stroke-linecap='round'/%3E%3Cpath d='M 70 72 L 60 82 L 70 92 L 80 82 Z' fill='url(%23b)' stroke='%23777' stroke-width='1'/%3E%3Cpolygon points='65,88 70,98 75,88' fill='%23555'/%3E%3Ccircle cx='70' cy='98' r='2' fill='%23333'/%3E%3C/svg%3E" alt="tonearm"></div><div class="play-mask" id="vinylPlayMask"><button class="play-btn" id="vinylPlayBtn" aria-label="播放/暂停"><svg viewBox="0 0 24 24" id="vinylIconPlay"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button></div></div><div class="song-info"><div class="title" id="vinylTitle">正在播放</div><div class="artist" id="vinylArtist"></div></div></div></div><div class="channel-toast" id="chToast"></div><div class="swipe-hint" id="swipeHint"><div class="swipe-arrow">▲</div><div class="swipe-label">上一个</div><div class="swipe-arrow" style="margin-top:24px">▼</div><div class="swipe-label">下一个</div></div><div class="ctrlbar" id="ctrlbar"><div class="ctrl-btn" id="playBtn">▶</div><div class="progress-wrap" id="progressWrap"><div class="progress-bg"><div class="progress-buffer" id="pBuffer"></div><div class="progress-fill" id="pFill"></div></div><div class="progress-dot" id="pDot"></div></div><div class="time-label" id="timeLabel">00:00 / 00:00</div><div class="vol-wrap"><div class="vol-icon" id="volIcon">🔊</div><div class="vol-bar" id="volBar"><div class="vol-fill" id="volFill"></div><div class="vol-dot" id="volDot"></div></div></div><div class="ctrl-btn" id="fsBtn" style="font-size:14px">⛶</div></div><div class="ch-panel-bg" id="chPanelBg"></div><div class="ch-panel" id="chPanel"><div class="ch-search"><input id="chSearchInput" placeholder="搜索频道..."></div><div class="ch-tabs" id="chTabs"></div><div class="ch-list" id="chList"></div></div><script src="https://unpkg.com/hls.js@1.5.7/dist/hls.min.js"><\/script><script src="https://unpkg.com/flv.js@1.6.2/dist/flv.min.js"><\/script><script>
var v=document.getElementById("v"),tt=document.getElementById("tt"),topbar=document.getElementById("topbar"),ctrlbar=document.getElementById("ctrlbar"),routeBtn=document.getElementById("routeBtn");
var playBtn=document.getElementById("playBtn"),pFill=document.getElementById("pFill"),pDot=document.getElementById("pDot"),pBuffer=document.getElementById("pBuffer"),progressWrap=document.getElementById("progressWrap");
var timeLabel=document.getElementById("timeLabel"),volIcon=document.getElementById("volIcon"),volFill=document.getElementById("volFill"),volBar=document.getElementById("volBar"),volDot=document.getElementById("volDot");
var allUrls=[],curIdx=0,h=null,LP="http://127.0.0.1:9975/live-proxy?url=";
var _ctx=document.createElement("canvas").getContext("2d");
var channelList=[],channelIdx=0,allChannels=[];
var _curChannelLogo='';
var loadingEl=document.getElementById("loading");
var chToast=document.getElementById("chToast");
try{var d=parent._livePlayData;if(d){tt.textContent=d.title||"";allUrls=d.urls||[];channelList=d.channels||[];allChannels=d.allChannels||channelList;channelIdx=d.channelIdx||0;parent._livePlayData=null;/* 尝试从allChannels获取当前频道logo */if(allChannels[channelIdx]&&allChannels[channelIdx].logo)_curChannelLogo=allChannels[channelIdx].logo}}catch(e){}
try{parent.postMessage({type:'dsjHideChrome'},'*')}catch(e){}
document.getElementById("bb").onclick=function(){try{parent.postMessage({type:'dsjShowChrome'},'*')}catch(e){}try{parent.postMessage({type:'liveClose'},'*')}catch(e){}};
function _liveAutoPlay(){v.muted=true;v.play().catch(function(){});v.addEventListener("playing",function _ulp(){v.removeEventListener("playing",_ulp);if(loadingEl)loadingEl.style.display="none";setTimeout(function(){v.muted=false;_checkAudioOnly()},300)},{once:true})}
/* ===== 纯音频检测 & 黑胶唱片可视化 ===== */
var _audioCtx=null,_analyser=null,_audioSrc=null,_audioRaf=null;
function _checkAudioOnly(){
  if(v.videoWidth===0&&v.videoHeight===0){_showAudioBg()}else{_hideAudioBg()}
}
v.addEventListener("loadedmetadata",function(){setTimeout(_checkAudioOnly,500)});
function _showAudioBg(){
  var bg=document.getElementById('audioBg');if(!bg||bg.style.display==='block')return;
  bg.style.display='block';
  var player=document.getElementById('vinylPlayer');
  var disc=document.getElementById('vinylDisc');
  var coverImg=document.getElementById('vinylCover');
  var titleEl=document.getElementById('vinylTitle');
  var artistEl=document.getElementById('vinylArtist');
  var logoUrl=_curChannelLogo||'';
  if(coverImg){
    if(logoUrl){coverImg.src=logoUrl;coverImg.style.display='block'}
    else{coverImg.src='https://picsum.photos/seed/'+Math.floor(Math.random()*99999)+'/300/300';coverImg.style.display='block'}
  }
  if(titleEl)titleEl.textContent=tt.textContent||'正在播放';
  if(artistEl){var epgEl=document.getElementById('epgInfo');artistEl.textContent=epgEl?epgEl.textContent:'';}
  if(player&&disc){player.classList.add('playing');player.classList.remove('paused');disc.classList.remove('spin-paused');disc.style.animationPlayState='running';}
  var icon=document.getElementById('vinylIconPlay');if(icon)icon.innerHTML='<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
}
function _hideAudioBg(){
  var bg=document.getElementById('audioBg');if(bg)bg.style.display='none';
  var disc=document.getElementById('vinylDisc');
  if(disc){disc.classList.add('spin-paused');disc.style.animationPlayState='paused'}
}
v.addEventListener("play",function(){var bg=document.getElementById('audioBg');if(!bg||bg.style.display!=='block')return;var p=document.getElementById('vinylPlayer'),d=document.getElementById('vinylDisc'),icon=document.getElementById('vinylIconPlay');if(p){p.classList.add('playing');p.classList.remove('paused')}if(d){d.classList.remove('spin-paused');d.style.animationPlayState='running'}if(icon)icon.innerHTML='<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'});
v.addEventListener("pause",function(){var bg=document.getElementById('audioBg');if(!bg||bg.style.display!=='block')return;var p=document.getElementById('vinylPlayer'),d=document.getElementById('vinylDisc'),icon=document.getElementById('vinylIconPlay');if(p){p.classList.add('paused');p.classList.remove('playing')}if(d){d.classList.add('spin-paused');d.style.animationPlayState='paused'}if(icon)icon.innerHTML='<path d="M8 5v14l11-7z"/>'});
(function(){var btn=document.getElementById('vinylPlayBtn');if(btn)btn.addEventListener('click',function(e){e.stopPropagation();if(v.paused)v.play();else v.pause()})})();
v.addEventListener("error",function(){if(loadingEl){loadingEl.innerHTML='<div style="color:#ff6b6b;font-size:14px">加载失败</div><div style="color:rgba(255,255,255,.5);font-size:12px;margin-top:6px">请尝试其他线路</div>';loadingEl.style.pointerEvents="none"}});
function fmt(s){if(!s||!isFinite(s))return"00:00";var m=Math.floor(s/60),sec=Math.floor(s%60);return(m<10?"0":"")+m+":"+(sec<10?"0":"")+sec}
function updateProgress(){if(v.duration&&isFinite(v.duration)){var pct=v.currentTime/v.duration*100;pFill.style.width=pct+"%";pDot.style.left=pct+"%";timeLabel.textContent=fmt(v.currentTime)+" / "+fmt(v.duration)}if(v.buffered&&v.buffered.length>0){var bf=v.buffered.end(v.buffered.length-1)/v.duration*100;pBuffer.style.width=bf+"%"}}
var pDragging=false;
progressWrap.addEventListener("mousedown",function(e){pDragging=true;progressWrap.classList.add("dragging");seek(e)});
document.addEventListener("mousemove",function(e){if(pDragging)seek(e)});
document.addEventListener("mouseup",function(){if(pDragging){pDragging=false;progressWrap.classList.remove("dragging")}});
progressWrap.addEventListener("touchstart",function(e){pDragging=true;progressWrap.classList.add("dragging");seek(e.touches[0])},{passive:true});
document.addEventListener("touchmove",function(e){if(pDragging)seek(e.touches[0])},{passive:true});
document.addEventListener("touchend",function(){if(pDragging){pDragging=false;progressWrap.classList.remove("dragging")}});
function seek(e){if(!v.duration||!isFinite(v.duration))return;var r=progressWrap.getBoundingClientRect();var pct=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));v.currentTime=pct*v.duration;updateProgress()}
playBtn.onclick=function(){if(v.paused){v.play().then(function(){v.muted=false}).catch(function(){})}else{v.pause()}};
v.addEventListener("play",function(){playBtn.textContent="⏸";if(hideTimer)clearTimeout(hideTimer);hideTimer=setTimeout(function(){if(!v.paused&&!v.seeking&&!v.waiting){topbar.classList.add("hide");ctrlbar.classList.add("hide")}},3000)});
v.addEventListener("pause",function(){playBtn.textContent="▶";if(hideTimer)clearTimeout(hideTimer);topbar.classList.remove("hide");ctrlbar.classList.remove("hide")});
v.addEventListener("waiting",function(){if(hideTimer)clearTimeout(hideTimer);topbar.classList.remove("hide");ctrlbar.classList.remove("hide")});
v.addEventListener("stalled",function(){if(hideTimer)clearTimeout(hideTimer);topbar.classList.remove("hide");ctrlbar.classList.remove("hide")});
v.addEventListener("playing",function(){if(!v.paused){if(hideTimer)clearTimeout(hideTimer);hideTimer=setTimeout(function(){topbar.classList.add("hide");ctrlbar.classList.add("hide")},3000)}});
v.addEventListener("timeupdate",updateProgress);
v.addEventListener("loadedmetadata",updateProgress);
var volDragging=false,lastVol=1;
volBar.addEventListener("mousedown",function(e){volDragging=true;setVol(e)});
document.addEventListener("mousemove",function(e){if(volDragging)setVol(e)});
document.addEventListener("mouseup",function(){volDragging=false});
volBar.addEventListener("touchstart",function(e){volDragging=true;setVol(e.touches[0])},{passive:true});
document.addEventListener("touchmove",function(e){if(volDragging)setVol(e.touches[0])},{passive:true});
document.addEventListener("touchend",function(){volDragging=false});
function setVol(e){var r=volBar.getBoundingClientRect();var pct=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));v.volume=pct;v.muted=false;volFill.style.width=pct*100+"%";volDot.style.right=(100-pct*100)+"%";lastVol=pct;volIcon.textContent=pct===0?"🔇":pct<0.5?"🔉":"🔊"}
volIcon.onclick=function(){if(v.muted||v.volume===0){v.muted=false;v.volume=lastVol||1;volFill.style.width=(lastVol||1)*100+"%";volDot.style.right=(100-(lastVol||1)*100)+"%";volIcon.textContent="🔊"}else{lastVol=v.volume;v.muted=true;volFill.style.width="0%";volDot.style.right="100%";volIcon.textContent="🔇"}};
document.getElementById("fsBtn").onclick=function(e){e.stopPropagation();var de=document.documentElement;if(!document.fullscreenElement&&!document.webkitFullscreenElement){if(de.requestFullscreen)de.requestFullscreen();else if(de.webkitRequestFullscreen)de.webkitRequestFullscreen()}else{if(document.exitFullscreen)document.exitFullscreen();else if(document.webkitExitFullscreen)document.webkitExitFullscreen()}};
var _mp4ProgTimer=null;
function destroyHls(){if(h){try{h.destroy()}catch(e){}h=null}if(_mp4ProgTimer){clearInterval(_mp4ProgTimer);_mp4ProgTimer=null}if(window._flvP){try{window._flvP.destroy()}catch(e){};window._flvP=null}_hideAudioBg()}
function playUrl(url){destroyHls();if(loadingEl){loadingEl.style.display="flex";loadingEl.style.pointerEvents="none";loadingEl.innerHTML='<div class="spinner"></div><div class="load-text" id="loadText">正在加载...</div>'}v.muted=true;v.removeAttribute("src");v.load();var useProxy=true;var _rawUrl=(url||"").toLowerCase();var _isFlv=_rawUrl.indexOf(".flv")>-1;if(_isFlv)useProxy=false;var playUrlFinal=useProxy?LP+encodeURIComponent(url):url;var _ltEl=document.getElementById("loadText");var _isMp4=_rawUrl.indexOf(".mp4")>-1||_rawUrl.indexOf(".mkv")>-1||_rawUrl.indexOf(".avi")>-1;if(_isFlv&&typeof flvjs!=="undefined"&&flvjs.isSupported()){var _flvRetry=false;function _flvPlay(flvUrl){var _fp=flvjs.createPlayer({type:"flv",url:flvUrl,isLive:true,cors:true},{enableStashBuffer:false,lazyLoad:false,reuseRedirectedURL:true});_fp.attachMediaElement(v);_fp.on(flvjs.Events.ERROR,function(){try{_fp.destroy()}catch(e){}if(!_flvRetry&&flvUrl!==playUrlFinal){_flvRetry=true;_flvPlay(playUrlFinal)}else{if(loadingEl){loadingEl.innerHTML='<div style="color:#ff6b6b;font-size:14px">FLV加载失败</div>';loadingEl.style.pointerEvents="none"}}});_fp.on(flvjs.Events.LOADING_COMPLETE,function(){if(loadingEl){loadingEl.innerHTML='<div style="color:#ff6b6b;font-size:14px">直播流已结束</div>'}});_fp.load();window._flvP=_fp}_flvPlay(playUrlFinal);var _flvStarted=false;v.addEventListener("canplay",function(){if(_flvStarted)return;_flvStarted=true;_liveAutoPlay()},{once:true});setTimeout(function(){if(!_flvStarted){_flvStarted=true;_liveAutoPlay()}},8000)}else if(_isMp4){v.preload="auto";v.src=playUrlFinal;var _mp4Started=false;var _onCanPlay=function(){if(_mp4Started)return;_mp4Started=true;_liveAutoPlay()};v.addEventListener("canplay",_onCanPlay,{once:true});v.addEventListener("loadedmetadata",function(){if(_ltEl&&v.duration&&isFinite(v.duration)){_ltEl.textContent="准备播放..."}},{once:true});_mp4ProgTimer=setInterval(function(){if(v.buffered&&v.buffered.length>0&&v.duration&&isFinite(v.duration)){var bf=Math.round(v.buffered.end(v.buffered.length-1)/v.duration*100);if(_ltEl)_ltEl.textContent="缓冲中 "+bf+"%";if(bf>=3&&!_mp4Started){_mp4Started=true;_liveAutoPlay()}}},300);setTimeout(function(){if(!_mp4Started){_mp4Started=true;if(v.readyState>=2){_liveAutoPlay()}else{v.play().catch(function(){})}}},8000)}else if(typeof Hls!=="undefined"&&Hls.isSupported()){h=new Hls({liveSyncDurationCount:3,liveMaxLatencyDurationCount:6,maxBufferLength:10,maxMaxBufferLength:20,maxBufferHole:0.5,enableWorker:true,lowLatencyMode:true,backBufferLength:10,startLevel:-1,startFragPrefetch:true,fragLoadingRetry:6,fragLoadingMaxRetryTimeout:64000,manifestLoadingRetry:3,levelLoadingRetry:3,xhrSetup:function(x){x.withCredentials=false}});h.loadSource(playUrlFinal);h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,function(){_liveAutoPlay()});h.on(Hls.Events.FRAG_LOADED,function(e,d){if(!d||!d.frag||!_ltEl)return;var stats=d.frag.stats||{};var loaded=d.frag.loaded||(stats.total?stats.total:0);if(!loaded)return;var t1=stats.loading?stats.loading.start:0;var t2=stats.loading?stats.loading.end:0;if(!t1||!t2)return;var _kb=Math.round(loaded/1024);var _sec=(t2-t1)/1000;if(_sec<=0)return;var _kbs=Math.round(_kb/_sec);if(_kbs>0)_ltEl.textContent=_kbs>=1024?(_kbs/1024).toFixed(1)+" MB/s":_kbs+" KB/s"});h.on(Hls.Events.ERROR,function(e,d){if(d.fatal){if(d.type===Hls.ErrorTypes.NETWORK_ERROR){destroyHls();try{v.src=playUrlFinal;v.addEventListener("loadedmetadata",function(){_liveAutoPlay()},{once:true})}catch(e2){}}else if(d.type===Hls.ErrorTypes.MEDIA_ERROR){h.recoverMediaError()}else{destroyHls();try{v.src=playUrlFinal}catch(e2){}}}})}else{v.src=playUrlFinal;v.addEventListener("loadedmetadata",function(){_liveAutoPlay()},{once:true})}}
function showRoutePanel(){var old=document.getElementById("routeOverlay");if(old){old.remove();return}var ov=document.createElement("div");ov.className="route-overlay";ov.id="routeOverlay";
ov.innerHTML='<div class="route-bg"></div><div class="route-panel"><div class="route-header"><span class="rh-title">线路('+allUrls.length+')</span><button class="rh-close" id="rhClose">✕</button></div><div class="route-list" id="routeList"></div></div>';
document.body.appendChild(ov);
ov.querySelector(".route-bg").onclick=function(){ov.remove()};
document.getElementById("rhClose").onclick=function(){ov.remove()};
var rl=document.getElementById("routeList");var rhtml="";
for(var i=0;i<allUrls.length;i++){var isCur=i===curIdx;rhtml+='<div class="route-item'+(isCur?' cur':'')+'" data-i="'+i+'"><span class="ri-idx">'+(i+1)+'</span><span class="ri-name">线路'+(i+1)+'</span><span class="ri-dot"></span></div>'}
rl.innerHTML=rhtml;
rl.querySelectorAll(".route-item").forEach(function(item){item.onclick=function(){var idx=parseInt(this.dataset.i);if(idx!==curIdx){curIdx=idx;playUrl(allUrls[idx]);routeBtn.textContent="\uD83D\uDEE0\uFE0F "+(curIdx+1)+"/"+allUrls.length}ov.remove()}})}
if(allUrls.length>1){routeBtn.style.display="flex";routeBtn.textContent="\uD83D\uDEE0\uFE0F 1/"+allUrls.length;routeBtn.onclick=function(ev){ev.stopPropagation();showRoutePanel()}}
/* ========== 自动隐藏控制栏 ========== */
var hideTimer=null;
function showControls(){topbar.classList.remove("hide");ctrlbar.classList.remove("hide");if(hideTimer)clearTimeout(hideTimer);hideTimer=setTimeout(function(){if(!v.paused){topbar.classList.add("hide");ctrlbar.classList.add("hide")}},3000)}
function hideControlsNow(){topbar.classList.add("hide");ctrlbar.classList.add("hide");if(hideTimer)clearTimeout(hideTimer)}
function _liveToast(msg){var t=document.createElement('div');t.textContent=msg;t.style.cssText='position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.85);color:#fff;padding:10px 22px;border-radius:10px;font-size:13px;z-index:999;pointer-events:none;transition:opacity .3s';document.body.appendChild(t);setTimeout(function(){t.style.opacity='0';setTimeout(function(){t.remove()},300)},1000)}
showControls();
/* ========== 单击切换显示控制栏、双击暂停/播放 ========== */
var lastTapTime=0,singleTapTimer=null;
function _onTap(){showControls()}
function _onDoubleTap(){if(v.paused){v.play().then(function(){v.muted=false}).catch(function(){})}else{v.pause()}}
/* ========== 上下滑动切换频道 ========== */
var swipeStartY=0,swipeStartX=0,swipeActive=false,swipeTriggered=false;
function _showChToast(msg){if(!chToast)return;chToast.textContent=msg;chToast.classList.add("show");setTimeout(function(){chToast.classList.remove("show")},1200)}
function _switchChannel(newIdx){if(newIdx<0||newIdx>=channelList.length||newIdx===channelIdx)return;channelIdx=newIdx;var ch=channelList[channelIdx];if(!ch)return;allUrls=ch.urls||[];curIdx=0;tt.textContent=ch.n||"";_curChannelLogo=ch.logo||'';if(!_curChannelLogo){for(var ci=0;ci<allChannels.length;ci++){if(allChannels[ci].n===ch.n&&allChannels[ci].logo){_curChannelLogo=allChannels[ci].logo;break}}}if(allUrls.length>1){routeBtn.style.display="flex";routeBtn.textContent="\uD83D\uDEE0\uFE0F 1/"+allUrls.length;routeBtn.onclick=function(ev){ev.stopPropagation();showRoutePanel()}}else{routeBtn.style.display="none"}playUrl(allUrls[0]);_showChToast(ch.n||("频道"+(channelIdx+1)))}
function _nextChannel(){if(channelList.length<=1)return;var next=channelIdx+1;if(next>=channelList.length)next=0;_switchChannel(next)}
function _prevChannel(){if(channelList.length<=1)return;var prev=channelIdx-1;if(prev<0)prev=channelList.length-1;_switchChannel(prev)}
/* ========== 触摸/点击事件绑定（绑定到document，确保loading等遮罩层也能响应滑动） ========== */
function _isUIEl(t){return t.closest('#routeOverlay,#ctrlbar,#topbar,.route-btn,.route-overlay,#chPanel,#chPanelBg')}
document.addEventListener("touchstart",function(e){if(_isUIEl(e.target))return;if(e.touches.length===1){swipeStartY=e.touches[0].clientY;swipeStartX=e.touches[0].clientX;swipeActive=true;swipeTriggered=false}},{passive:true});
document.addEventListener("touchmove",function(e){if(!swipeActive||e.touches.length!==1)return;var dy=e.touches[0].clientY-swipeStartY;var dx=e.touches[0].clientX-swipeStartX;if(!swipeTriggered&&Math.abs(dy)>60&&Math.abs(dy)>Math.abs(dx)*1.5){swipeTriggered=true;swipeActive=false;if(dy<0){_nextChannel()}else{_prevChannel()}}if(!swipeTriggered&&v.duration&&isFinite(v.duration)&&Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5){swipeTriggered=true;swipeActive=false;var sec=Math.min(120,Math.round(Math.abs(dx)/20)*10);if(dx>0){v.currentTime=Math.min(v.duration,v.currentTime+sec);_liveToast('快进'+sec+'秒')}else{v.currentTime=Math.max(0,v.currentTime-sec);_liveToast('快退'+sec+'秒')}showControls()}},{passive:true});
document.addEventListener("touchend",function(e){if(_isUIEl(e.target)){swipeActive=false;return}swipeActive=false;if(swipeTriggered)return;var now=Date.now();if(now-lastTapTime<300){if(singleTapTimer){clearTimeout(singleTapTimer);singleTapTimer=null}lastTapTime=0;_onDoubleTap()}else{lastTapTime=now;singleTapTimer=setTimeout(function(){_onTap();singleTapTimer=null;lastTapTime=0},300)}},{passive:false});
document.addEventListener("mousemove",function(){showControls()});
/* ========== 显示滑动提示（3秒后自动隐藏） ========== */
if(channelList.length>1){var swipeHint=document.getElementById("swipeHint");if(swipeHint){swipeHint.classList.add("show");setTimeout(function(){swipeHint.classList.remove("show")},3000)}}
if(allUrls.length>0)playUrl(allUrls[0]);


/* ===== Channel List Panel ===== */
var _chFavs=JSON.parse(localStorage.getItem("live_favs")||"[]");
function _chSaveFav(){localStorage.setItem("live_favs",JSON.stringify(_chFavs))}
function _chToggleFav(n){var i=_chFavs.indexOf(n);if(i>=0)_chFavs.splice(i,1);else _chFavs.push(n);_chSaveFav()}
function _chIsFav(n){return _chFavs.indexOf(n)>=0}
function _chShowPanel(filterFav){
  var panel=document.getElementById("chPanel");
  var bg=document.getElementById("chPanelBg");
  panel.classList.add("show");bg.classList.add("show");
  showControls();
  var tabs=document.getElementById("chTabs");
  var list=document.getElementById("chList");
  var input=document.getElementById("chSearchInput");
  input.value="";
  var curCat="all";
  function render(){
    var q=input.value.trim().toLowerCase();
    var favOnly=filterFav;
    var h="";
    var searchList=(q||favOnly)?allChannels:channelList;
    for(var i=0;i<searchList.length;i++){
      var ch=searchList[i];
      var name=ch.n||"";
      var isFav=_chIsFav(name);
      if(favOnly&&!isFav)continue;
      if(q&&name.toLowerCase().indexOf(q)<0)continue;
      var realIdx=channelList.indexOf(ch);
      var isCur=realIdx===channelIdx;
      h+='<div class="ch-item'+(isCur?" cur":"")+'" data-i="'+i+'" data-n="'+encodeURIComponent(name)+'"><span class="ch-name">'+name+'</span><span class="ch-epg" data-n="'+encodeURIComponent(name)+'"></span><button class="ch-fav" data-n="'+name+'">'+(isFav?"⭐":"☆")+'</button></div>';
    }
    if(!h)h='<div style="text-align:center;padding:40px;color:rgba(255,255,255,.4);font-size:13px">'+(favOnly?"暂无收藏频道":"未找到频道")+'</div>';
    list.innerHTML=h;
    list.querySelectorAll(".ch-item").forEach(function(item){
      item.onclick=function(e){
        if(e.target.closest(".ch-fav"))return;
        var idx=parseInt(this.dataset.i);
        var ch=searchList[idx];
        var realIdx=channelList.indexOf(ch);
        if(realIdx>=0){if(realIdx!==channelIdx)_switchChannel(realIdx)}
        else{channelList.push(ch);realIdx=channelList.length-1;_switchChannel(realIdx)}
        _chHidePanel();
      }
    });
    list.querySelectorAll(".ch-fav").forEach(function(btn){
      btn.onclick=function(e){
        e.stopPropagation();
        _chToggleFav(this.dataset.n);
        render();
      }
    });
    list.querySelectorAll(".ch-epg").forEach(function(el){
      var name=decodeURIComponent(el.dataset.n||'');
      if(_chEpgCache.hasOwnProperty(name)){el.textContent=_chEpgCache[name]||''}
      else if(_chEpgCache.hasOwnProperty(name.toLowerCase())){el.textContent=_chEpgCache[name.toLowerCase()]||''}
    });
    _loadChEpgBatch();
  }
  tabs.innerHTML='<div class="ch-tab'+(!filterFav?" on":"")+'" data-f="0">全部</div><div class="ch-tab'+(filterFav?" on":"")+'" data-f="1">⭐ 收藏</div>';
  tabs.querySelectorAll(".ch-tab").forEach(function(t){
    t.onclick=function(){_chShowPanel(this.dataset.f==="1")}
  });
  input.oninput=render;
  render();
  input.focus();
}
function _chHidePanel(){
  document.getElementById("chPanel").classList.remove("show");
  document.getElementById("chPanelBg").classList.remove("show");
}
document.getElementById("chListBtn").onclick=function(ev){ev.stopPropagation();_chShowPanel(false)};
document.getElementById("chPanelBg").onclick=_chHidePanel;

/* ===== EPG ===== */
var _epgText='';
var _chEpgCache={};
var _chEpgBatchLoaded=false;
function _loadChEpgBatch(){
  if(_chEpgBatchLoaded)return;
  _chEpgBatchLoaded=true;
  try{
    var x=new XMLHttpRequest();
    x.open('GET','http://127.0.0.1:9975/epg-all',true);
    x.timeout=15000;
    x.onload=function(){
      try{
        var j=JSON.parse(x.responseText);
        if(!j.ok||!j.data)return;
        var d=j.data;
        for(var k in d){
          var f=d[k],t='';
          if(f.current)t+='\u25B6 '+_ef(f.current.start)+' '+f.current.title;
          var name=(f.name||k).toLowerCase();
          var dispName=f.name||k;
          _chEpgCache[dispName]=t;
          _chEpgCache[name]=t;
        }
        document.querySelectorAll('.ch-epg').forEach(function(el){
          var n=decodeURIComponent(el.dataset.n||'');
          var key=_chEpgCache.hasOwnProperty(n)?n:n.toLowerCase();
          if(_chEpgCache.hasOwnProperty(key)){el.textContent=_chEpgCache[key]}
        });
      }catch(e){}
    };
    x.ontimeout=function(){_chEpgBatchLoaded=false};
    x.onerror=function(){_chEpgBatchLoaded=false};
    x.send();
  }catch(e){_chEpgBatchLoaded=false}
}
function _ef(ts){if(!ts)return'';var d=new Date(ts);return(d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes()}
function _epgApply(){
  var el=document.getElementById('epgInfo');if(!el)return;
  el.style.animation='none';
  if(!_epgText){el.textContent='';return}
  el.textContent=_epgText;
  void el.offsetWidth;
  var pw=el.parentElement.offsetWidth;
  if(pw>0){
    var fs=parseInt(getComputedStyle(el).fontSize)||10;
    _ctx.font=fs+'px '+(getComputedStyle(el).fontFamily||'sans-serif');
    var tw=_ctx.measureText(_epgText).width;
    if(tw>pw){
      el.innerHTML=_epgText+' &nbsp;&nbsp;&nbsp; '+_epgText;void el.offsetWidth;el.style.animation='epgScroll '+(Math.max(5,Math.ceil(tw/40)))+'s linear infinite'
    }
  }
}
function _epgLoad(ch){
  try{
    var el=document.getElementById('epgInfo');if(!el)return;
    var x=new XMLHttpRequest();
    x.open('GET','http://127.0.0.1:9975/epg?ch='+encodeURIComponent(ch),true);
    x.timeout=8000;
    x.onload=function(){
      try{
        var j=JSON.parse(x.responseText);if(!j.ok||!j.data){_epgText='';_epgApply();return}
        var k=Object.keys(j.data);if(!k.length){_epgText='';_epgApply();return}
        var f=j.data[k[0]],t='';
        if(f.current)t+='\u25B6 '+_ef(f.current.start)+'-'+_ef(f.current.stop)+' '+f.current.title;
        if(f.next)t+='  \u25B7 '+_ef(f.next.start)+' '+f.next.title;
        _epgText=t;
        _epgApply();
      }catch(e){}
    };
    x.send();
  }catch(e){}
}
setTimeout(function(){_epgLoad(tt.textContent)},2000);
var _osc=_switchChannel;
_switchChannel=function(i){_osc(i);_epgText='';var e=document.getElementById('epgInfo');if(e){e.textContent='';e.style.animation='none'}setTimeout(function(){var cn=channelList[channelIdx]?channelList[channelIdx].n:'';if(cn)_epgLoad(cn)},500)};
var _epgResizeTimer=null;
window.addEventListener('resize',function(){if(_epgResizeTimer)clearTimeout(_epgResizeTimer);_epgResizeTimer=setTimeout(_epgApply,200)});
window.addEventListener('orientationchange',function(){if(_epgResizeTimer)clearTimeout(_epgResizeTimer);_epgResizeTimer=setTimeout(_epgApply,300)});
<\/script></body></html>`;
    return send(res, 200, livePage, 'text/html; charset=utf-8');
  }

  // 直播源转换（POST body 解析 txt/m3u → json）
  if (pathname === '/live-convert-parse') {
    var body2 = '';
    req.on('data', function(c){ body2 += c; });
    req.on('end', function() {
      try {
        var lines = body2.split('\n');
        var result = {};
        var curCat = '';
        var total = 0;
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].replace(/\r/g, '').trim();
          if (!line) continue;
          if (line === '#EXTM3U' || line === '#EXTM3U8' || line.indexOf('#EXT-X-') === 0 || line.indexOf('#EXTVLCOPT:') === 0) continue;
          if (line.indexOf(',#genre#') > -1) {
            curCat = line.split(',')[0].trim();
            if (!result[curCat]) result[curCat] = [];
            continue;
          }
          // 先从 #EXTINF 行提取 group-title（单频道级），不影响后续无 group-title 的行
          var lineCat = '';
          if (line.indexOf('#EXTINF') === 0 && line.indexOf('group-title=') > -1) {
            var gt = line.match(/group-title="([^"]*)"/);
            if (gt) lineCat = gt[1].trim();
          }
          // 优先用当前行的 group-title，其次用持久分类（#genre#），最后用"未分类"
          var effectiveCat = lineCat || curCat || '未分类';
          if (!result[effectiveCat]) result[effectiveCat] = [];
          var name = '', url = '', logo = '';
          if (line.indexOf('#EXTINF') === 0) {
            var nameMatch = line.match(/tvg-name="([^"]*)"/);
            if (nameMatch) name = nameMatch[1];
            if (!name) { var cm = line.split(','); if (cm.length > 1) name = cm[cm.length-1].trim(); }
            var logoMatch = line.match(/tvg-logo="([^"]*)"/);
            if (logoMatch) logo = logoMatch[1];
            if (i+1 < lines.length) {
              var nextLine = lines[i+1].replace(/\r/g, '').trim();
              if (nextLine.indexOf('http') === 0) { url = nextLine; i++; }
            }
          } else {
            var parts = line.split(',');
            if (parts.length >= 2) { name = parts[0].trim(); url = parts[1].trim(); }
          }
          if (!name || !url || url.indexOf('http') !== 0) continue;
          var dup = false;
          for (var j = 0; j < result[effectiveCat].length; j++) {
            if (result[effectiveCat][j].n === name) { result[effectiveCat][j].u.push(url); dup = true; break; }
          }
          if (!dup) { result[effectiveCat].push({n:name,u:[url],logo:logo||''}); total++; }
        }
        var jsonStr = JSON.stringify(result);
        var jsonPath = require('path').join(__dirname, 'live_channels.json');
        fs.writeFileSync(jsonPath, jsonStr, 'utf-8');
        send(res, 200, JSON.stringify({ok:true,total:total,cats:Object.keys(result).length}), 'application/json; charset=utf-8');
      } catch(e) { send(res, 200, JSON.stringify({ok:false,error:'parse error: '+e.message}), 'application/json; charset=utf-8'); }
    });
    return;
  }

  // 直播源转换保存（POST JSON body → live_channels.json）
  if (pathname === '/live-convert-save') {
    var body3 = '';
    req.on('data', function(c){ body3 += c; });
    req.on('end', function() {
      try {
        var raw = JSON.parse(body3);
        var data = raw.channels || raw;
        var epgUrl = raw.epgUrl || '';
        if (typeof data !== 'object' || Array.isArray(data)) {
          return send(res, 200, JSON.stringify({ok:false,error:'格式错误'}), 'application/json; charset=utf-8');
        }
        var total = 0;
        var cats = Object.keys(data);
        for (var i = 0; i < cats.length; i++) { if (Array.isArray(data[cats[i]])) total += data[cats[i]].length; }
        var jsonPath = require('path').join(__dirname, 'live_channels.json');
        fs.writeFileSync(jsonPath, JSON.stringify(data), 'utf-8');
        if (epgUrl) {
          fs.writeFileSync(require('path').join(__dirname, 'live_meta.json'), JSON.stringify({epgUrl:epgUrl}));
        }
        send(res, 200, JSON.stringify({ok:true,total:total,cats:cats.length}), 'application/json; charset=utf-8');
      } catch(e) { send(res, 200, JSON.stringify({ok:false,error:'save error: '+e.message}), 'application/json; charset=utf-8'); }
    });
    return;
  }


  // EPG 节目单（单频道，使用缓存）
  // EPG 批量接口（一次返回全部频道）
  if (pathname === '/epg-all' || pathname === '/epg') {
    var epgUrl = u.searchParams.get('url') || '';
    if (!epgUrl) {
      try {
        var mp = require('path').join(__dirname, 'live_meta.json');
        if (fs.existsSync(mp)) { var mm = JSON.parse(fs.readFileSync(mp,'utf8')); epgUrl = mm.epgUrl || ''; }
      } catch(e) {}
    }
    if (!epgUrl) return send(res, 200, '{"ok":false,"error":"no epg url"}', 'application/json');
    var ch = (u.searchParams.get('ch') || '').toLowerCase();
    var isAll = (pathname === '/epg-all');

    // 有缓存且未过期 → 直接返回
    if (_epgCacheData && (Date.now() - _epgCacheTime) < _EPG_CACHE_TTL) {
      if (isAll) {
        send(res, 200, JSON.stringify({ok:true, data:_epgCacheData}), 'application/json');
      } else {
        var r1 = {};
        for (var k in _epgCacheData) {
          if (k === ch || (_epgCacheData[k].name||'').toLowerCase() === ch) { r1[k] = _epgCacheData[k]; break; }
        }
        send(res, 200, JSON.stringify({ok:true, data:r1}), 'application/json');
      }
      return;
    }

    // 正在加载 → 排队等待
    if (_epgCacheLoading) {
      _epgCacheWaiters.push(function() {
        if (isAll) {
          send(res, 200, JSON.stringify({ok:true, data:_epgCacheData}), 'application/json');
        } else {
          var r2 = {};
          for (var k2 in _epgCacheData) {
            if (k2 === ch || (_epgCacheData[k2].name||'').toLowerCase() === ch) { r2[k2] = _epgCacheData[k2]; break; }
          }
          send(res, 200, JSON.stringify({ok:true, data:r2}), 'application/json');
        }
      });
      return;
    }

    // 首次请求 → 下载并缓存
    _epgCacheLoading = true;
    var mod = epgUrl.startsWith('https') ? https : http;
    var r = mod.get(epgUrl, {timeout:10000,headers:{'User-Agent':'Mozilla/5.0'}}, function(rs) {
      if (rs.statusCode>=300 && rs.statusCode<400 && rs.headers.location) {
        rs.resume();
        var r2mod = rs.headers.location.startsWith('https') ? https : http;
        r2mod.get(rs.headers.location, {timeout:10000,headers:{'User-Agent':'Mozilla/5.0'}}, function(r2) {
          var b=''; r2.setEncoding('utf8'); r2.on('data',function(c){b+=c}); r2.on('end',function(){
            _epgCacheData = _parseEpgAll(b);
            _epgCacheTime = Date.now();
            _epgCacheLoading = false;
            var result = {};
            if (ch) { for (var k in _epgCacheData) { if (k === ch || (_epgCacheData[k].name||'').toLowerCase() === ch) { result[k] = _epgCacheData[k]; break; } } }
            send(res, 200, JSON.stringify({ok:true, data:result}), 'application/json');
            _epgCacheWaiters.forEach(function(cb){try{cb()}catch(e){}});
            _epgCacheWaiters = [];
          });
        }).on('error',function(){_epgCacheLoading=false;send(res,200,'{"ok":false,"error":"fetch failed"}','application/json')});
        return;
      }
      var b=''; rs.setEncoding('utf8'); rs.on('data',function(c){b+=c}); rs.on('end',function(){
        _epgCacheData = _parseEpgAll(b);
        _epgCacheTime = Date.now();
        _epgCacheLoading = false;
        var result = {};
        if (ch) { for (var k in _epgCacheData) { if (k === ch || (_epgCacheData[k].name||'').toLowerCase() === ch) { result[k] = _epgCacheData[k]; break; } } }
        send(res, 200, JSON.stringify({ok:true, data:result}), 'application/json');
        _epgCacheWaiters.forEach(function(cb){try{cb()}catch(e){}});
        _epgCacheWaiters = [];
      });
    });
    r.on('error',function(){_epgCacheLoading=false;send(res,200,'{"ok":false,"error":"fetch failed"}','application/json')});
    r.on('timeout',function(){r.destroy();_epgCacheLoading=false;send(res,200,'{"ok":false,"error":"timeout"}','application/json')});
    return;
  }

  // 本地影片库页面
  if (pathname === '/local') {
    const file = u.searchParams.get('file') || '';
    return send(res, 200, localHtml(file), 'text/html; charset=utf-8');
  }

  if (pathname === '/local-list-api' || pathname === '/local-api' || pathname === '/local-search-api') { return handleLocalApi(req, res, u, pathname); }
  // M3U影片源转换保存
  if (pathname === '/m3u-convert-save') {
    var body4 = '';
    req.on('data', function(c){ body4 += c; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body4);
        var list = data.list || data;
        if (!Array.isArray(list)) {
          return send(res, 200, JSON.stringify({ok:false,error:'格式错误'}), 'application/json; charset=utf-8');
        }
        if (list.length === 0) {
          return send(res, 200, JSON.stringify({ok:false,error:'没有可保存的影片'}), 'application/json; charset=utf-8');
        }
        ensureDataDir();
        var outName = 'm3u_import_' + new Date().toISOString().replace(/[:.]/g,'-').slice(0,19) + '.json';
        var outPath = path.join(DATA_DIR, outName);
        fs.writeFileSync(outPath, JSON.stringify({list: list}, null, 2), 'utf-8');
        send(res, 200, JSON.stringify({ok:true, total: list.length, file: outName}), 'application/json; charset=utf-8');
      } catch(e) { send(res, 200, JSON.stringify({ok:false,error:'save error: '+e.message}), 'application/json; charset=utf-8'); }
    });
    return;
  }

  // 直播流代理（不限域名，用于代理m3u8直播流）
  if (pathname === '/live-proxy') {
    const target = u.searchParams.get('url');
    if (!target) return send(res, 400, 'missing url');
    if (!/^https?:\/\//.test(target)) return send(res, 400, 'bad url');
    try {
      var urlObj = new URL(target);
      var clientReq = req;
      var redirectCount = 0;
      function doFetch(fetchUrl) {
        var fMod = fetchUrl.startsWith('https') ? https : http;
        var fUrl = new URL(fetchUrl);
        var fetchOpt = {
          headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/100.0 Mobile Safari/537.36' },
          agent: fMod === https ? new https.Agent({ keepAlive: true, maxSockets: 10 }) : new http.Agent({ keepAlive: true, maxSockets: 10 }),
          timeout: 60000
        };
        if (clientReq.headers.range) { fetchOpt.headers['Range'] = clientReq.headers.range; }
        var req = fMod.get(fUrl.href, fetchOpt, function(r) {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirectCount < 5) {
            redirectCount++;
            r.resume();
            var newUrl = r.headers.location.startsWith('http') ? r.headers.location : fUrl.origin + r.headers.location;
            return doFetch(newUrl);
          }
          var ct = r.headers['content-type'] || '';
          var isM3u8 = ct.indexOf('mpegurl') > -1 || ct.indexOf('m3u8') > -1 || fUrl.pathname.endsWith('.m3u8');
          if (isM3u8) {
            // m3u8 内容需要重写内部 URL，让分片也走代理
            var chunks = [];
            r.on('data', function(c) { chunks.push(c); });
            r.on('end', function() {
              try {
                var body = Buffer.concat(chunks).toString('utf-8');
                var m3u8Base = fUrl.href.substring(0, fUrl.href.lastIndexOf('/') + 1);
                var lines = body.split('\n');
                var rewritten = [];
                for (var li = 0; li < lines.length; li++) {
                  var ln = lines[li].trim();
                  if (!ln || ln.indexOf('#') === 0) {
                    rewritten.push(lines[li]);
                    continue;
                  }
                  var absUrl;
                  try { absUrl = new URL(ln, fUrl.href).href; }
                  catch(e) { absUrl = ln.indexOf('http') === 0 ? ln : m3u8Base + ln; }
                  rewritten.push('/live-proxy?url=' + encodeURIComponent(absUrl));
                }
                var out = rewritten.join('\n');
                res.writeHead(200, {
                  'Content-Type': 'application/vnd.apple.mpegurl',
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'no-cache'
                });
                res.end(out);
              } catch(e) {
                try { res.writeHead(502); res.end('rewrite error'); } catch(e2) {}
              }
            });
            r.on('error', function() { try { res.writeHead(502); res.end('fetch error'); } catch(e) {} });
          } else {
            // 非 m3u8（ts/mp4等），直接 pipe，转发关键响应头
            var respHeaders = {
              'Content-Type': ct || 'application/octet-stream',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache'
            };
            if (r.headers['content-range']) respHeaders['Content-Range'] = r.headers['content-range'];
            if (r.headers['content-length']) respHeaders['Content-Length'] = r.headers['content-length'];
            if (r.headers['accept-ranges']) respHeaders['Accept-Ranges'] = r.headers['accept-ranges'];
            res.writeHead(r.statusCode, respHeaders);
            r.pipe(res);
          }
        });
        req.on('error', function(e) { try { res.writeHead(502); res.end('proxy error: ' + e.message); } catch(e2) {} });
        req.on('timeout', function() { req.destroy(); try { res.writeHead(504); res.end('timeout'); } catch(e) {} });
      }
      doFetch(urlObj.href);
      return;
    } catch(e) { return send(res, 502, 'proxy error: ' + e.message); }
  }

  // 电视直播频道API
  if (pathname === '/live-api') {
    try {
      var liveJsonPath = require('path').join(__dirname, 'live_channels.json');
      if (fs.existsSync(liveJsonPath)) {
        var liveData = fs.readFileSync(liveJsonPath, 'utf-8');
        return send(res, 200, liveData, 'application/json; charset=utf-8');
      }
    } catch(e) { log('live-api error: ' + e.message); }
    return send(res, 200, '{"error":"live_channels.json not found"}', 'application/json; charset=utf-8');
  }

  // 首页完整HTML页面
  if (pathname === '/home-page') {
    return send(res, 200, '<!doctype html><html><head><meta charset="utf-8"><style>html,body{background:transparent!important;margin:0;padding:0;opacity:0}</style></head><body></body></html>', 'text/html; charset=utf-8');
  }

  // 代理请求（加 SSRF 防护）
  // 图片代理（解决防盗链）
  if (pathname === '/img') {
    const imgUrl = u.searchParams.get('url') || '';
    if (!imgUrl || !/^https?:/.test(imgUrl)) return send(res, 400, 'bad url');
    // 根据图片域名动态设置 Referer，避免防盗链 403
    var imgReferer = SITE + '/';
    try {
      var imgParsed = new URL(imgUrl);
      var siteHost = new URL(SITE).hostname;
      if (imgParsed.hostname !== siteHost) {
        imgReferer = imgParsed.protocol + '//' + imgParsed.host + '/';
      }
    } catch(e) {}
    const mod = imgUrl.startsWith('https') ? https : http;
    const imgReq = mod.request(imgUrl, { method:'GET', headers:{'User-Agent':'Mozilla/5.0','Referer':imgReferer}, timeout:10000 }, imgRes => {
      if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
        // 跟随重定向
        const redir = imgRes.headers.location.startsWith('http') ? imgRes.headers.location : SITE + imgRes.headers.location;
        imgRes.resume();
        const mod2 = redir.startsWith('https') ? https : http;
        const r2 = mod2.request(redir, {method:'GET',headers:{'User-Agent':'Mozilla/5.0','Referer':imgReferer},timeout:10000}, r2Res => {
          const ct = r2Res.headers['content-type'] || 'image/jpeg';
          res.writeHead(r2Res.statusCode, {'Content-Type':ct,'Access-Control-Allow-Origin':'*','Cache-Control':'public,max-age=86400'});
          r2Res.pipe(res);
        });
        r2.on('error', () => { try{res.writeHead(502);res.end('err')}catch(e){} });
        r2.end();
        return;
      }
      const ct = imgRes.headers['content-type'] || 'image/jpeg';
      res.writeHead(imgRes.statusCode, {'Content-Type':ct,'Access-Control-Allow-Origin':'*','Cache-Control':'public,max-age=86400'});
      imgRes.pipe(res);
    });
    imgReq.on('error', () => { try{res.writeHead(502);res.end('err')}catch(e){} });
    imgReq.end();
    return;
  }

  if (pathname === '/proxy') {
    const target = u.searchParams.get('url');
    if (!target) return send(res, 400, '{"ok":false,"error":"missing url"}');
    if (!isSafeUrl(target)) return send(res, 403, '{"ok":false,"error":"url not allowed"}');
    return fetchPage(target, (err, html) => {
      if (err) return send(res, 502, 'error:' + err.message);
      send(res, 200, html, 'text/html; charset=utf-8');
    });
  }

  // 分类API（取影片库 show，含筛选）
if (pathname === '/api') {
    try {
      const cid = u.searchParams.get('cid') || '';
      const filter = u.searchParams.get('filter') || '';
      const page = parseInt(u.searchParams.get('page') || '1');
      
      // Map cid to category name
      const cidNameMap = { '': '首页', 'dianying': '电影', '2': '剧集', 'zongyi': '综艺', 'dongman': '动漫', '20': '短剧' };
      const typeName = cidNameMap[cid] || cid;
      
      // 各分类的剧情类型筛选列表（TVBox API 用 class 参数筛选）
      var genreFilters = {
        '电影': ['动作','喜剧','爱情','科幻','悬疑','惊悚','恐怖','剧情','犯罪','冒险','奇幻','战争','武侠','动画','历史','传记','灾难','音乐'],
        '剧集': ['古装','都市','喜剧','家庭','警匪','言情','军事','武侠','悬疑','历史','青春','科幻','法律','农村','情感','谍战'],
        '综艺': ['情感','访谈','音乐','选秀','娱乐','脱口秀','真人秀','竞技','美食','游戏','旅游','文化','体育','少儿'],
        '动漫': ['热血','搞笑','日漫','国漫','欧美','治愈','少女','机战','战斗','恋爱','校园','奇幻','冒险','科幻','推理']
      };
      var typeFilters = genreFilters[typeName] || [];
      var filterOpts = [{name: '全部', slug: ''}].concat(typeFilters.map(function(g) { return {name: g, slug: 'class=' + g}; }));

      // Parse filter string
      let filters = {};
      if (filter) {
        filter.split('&').forEach(f => {
          const [k, v] = f.split('=');
          if (k && v) filters[decodeURIComponent(k)] = decodeURIComponent(v);
        });
      }
      
      return getActiveSource().category(typeName, page, filters).then(result => {
        send(res, 200, JSON.stringify({ok:result.ok, items:result.items||[], filters: page===1 ? filterOpts : null}), 'application/json');
      }).catch(e => {
        send(res, 200, JSON.stringify({ok:false,error:e.message}), 'application/json');
      });
    } catch(e) {
      send(res, 500, JSON.stringify({ok:false,error:e.message}), 'application/json');
    }
  }

  // 分类页
  if (pathname === '/category') {
    const cid = u.searchParams.get('cid') || '';
    const name = u.searchParams.get('name') || '电影';
    return send(res, 200, categoryHtml(cid, name), 'text/html; charset=utf-8');
  }

  // 搜索API
if (pathname === '/search-api') {
    const wd = u.searchParams.get('wd') || '';
    const page = parseInt(u.searchParams.get('page') || '1', 10);
    
    return getActiveSource().search(wd, page).then(result => {
      var items = (result.items || []).map(function(it) {
        var metaParts = [];
        if (it.tag) metaParts.push(it.tag);
        if (it.year) metaParts.push(it.year);
        if (it.area) metaParts.push(it.area);
        if (it.type) metaParts.push(it.type);
        if (it.class) metaParts.push(it.class);
        return {
          title: it.title, img: it.img, url: it.url, vodUrl: it.vodUrl,
          tag: it.tag, actors: it.actors, intro: it.desc || '',
          year: it.year, area: it.area, type: it.type, class: it.class,
          meta: metaParts.join(' | ')
        };
      });
      send(res, 200, JSON.stringify({ok:result.ok, items:items, page:result.page||1}), 'application/json');
    }).catch(e => {
      send(res, 200, JSON.stringify({ok:false,error:e.message}), 'application/json');
    });
  }

  // 最新页/API
  if (pathname === '/latest') return send(res, 200, latestHtml(), 'text/html; charset=utf-8');

  if (pathname === '/latest-api') {
    const page = parseInt(u.searchParams.get('page') || '1');
    const tab = parseInt(u.searchParams.get('tab') || '0');
    const url = page <= 1 ? `${SITE}/label/new.html` : `${SITE}/label/new/page/${page}.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const tabs = splitTabs(html);
      let items = [];
      if (tab === 1 && tabs.length > 1) items = parseCardItems(tabs[1]);
      else if (tabs.length > 0) { items = parseCards(tabs[0]); if (!items.length && tabs.length > 1) items = parseCardItems(tabs[1]); }
      send(res, 200, JSON.stringify({ok:true, items, tabCount: tabs.length}), 'application/json');
    });
  }

  // 排行页/API
  if (pathname === '/rank') return send(res, 200, rankHtml(), 'text/html; charset=utf-8');

  if (pathname === '/rank-api') {
    const page = parseInt(u.searchParams.get('page') || '1');
    const tab = parseInt(u.searchParams.get('tab') || '0');
    // 使用 TVBoxAPI 获取排行榜数据（不再依赖网页爬虫）
    return getActiveSource().rank(page).then(result => {
      if (!result.ok) return send(res, 200, JSON.stringify({ok:false, error:result.error}));
      let items = result.items || [];
      // tab 0: 按分类的排行榜（原始数据）；tab 1/2: 同一数据（TVBox API 无独立热门 tab）
      send(res, 200, JSON.stringify({ok:true, items:items, tabCount:3, finished:true}), 'application/json');
    }).catch(e => {
      send(res, 200, JSON.stringify({ok:false, error:e.message}), 'application/json');
    });
  }

  // 排行榜单个影片详情（点击展开时懒加载，不拖慢列表渲染）
  if (pathname === '/rank-detail-api') {
    const vodId = (u.searchParams.get('vod_id') || '').trim();
    if (!vodId) return send(res, 200, JSON.stringify({ok:false, error:'missing vod_id'}), 'application/json');
    return getActiveSource().detail(vodId).then(result => {
      if (!result.ok) return send(res, 200, JSON.stringify({ok:false, error:result.error}), 'application/json');
      var v = result.vod || {};
      send(res, 200, JSON.stringify({
        ok: true,
        actors: v.vod_actor || '',
        director: v.vod_director || '',
        content: v.vod_content || '',
        year: v.vod_year || '',
        area: v.vod_area || '',
        class: v.vod_class || '',
        remarks: v.vod_remarks || '',
        score: v.vod_douban_score || ''
      }), 'application/json');
    }).catch(e => {
      send(res, 200, JSON.stringify({ok:false, error:e.message}), 'application/json');
    });
  }

  // 专题页/API
  if (pathname === '/topic') return send(res, 200, topicHtml(), 'text/html; charset=utf-8');

  if (pathname === '/topic-api') {
    const page = parseInt(u.searchParams.get('page') || '1');
    const url = page <= 1 ? `${SITE}/topic.html` : `${SITE}/topic/page/${page}.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const items = parseTopicItems(html);
      send(res, 200, JSON.stringify({ok:true, items}), 'application/json');
    });
  }

  // 专题详情页/API
  if (pathname === '/topic-detail') {
    const topicUrl = u.searchParams.get('url') || '';
    const topicTitle = u.searchParams.get('title') || '专题';
    return send(res, 200, topicDetailHtml(topicUrl, topicTitle), 'text/html; charset=utf-8');
  }

  if (pathname === '/topic-detail-api') {
    const topicUrl = u.searchParams.get('url') || '';
    const page = parseInt(u.searchParams.get('page') || '1');
    if (!topicUrl) return send(res, 200, JSON.stringify({ok:false,error:'no url'}));
    const fullTopicUrl = /^https?:/.test(topicUrl) ? topicUrl : SITE + topicUrl;
    const fetchUrl = page <= 1 ? fullTopicUrl : fullTopicUrl.replace(/\.html?$/, '/page/' + page + '.html');
    return fetchPage(fetchUrl, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const items = parseCards(html);
      send(res, 200, JSON.stringify({ok:true, items}), 'application/json');
    });
  }

  // 搜索页
  if (pathname === '/search') {
    const wd = u.searchParams.get('wd') || '';
    return send(res, 200, searchHtml(wd), 'text/html; charset=utf-8');
  }


  // 解析播放线路和集数 API
if (pathname === '/api/parse-play') {
    const vodUrl = u.searchParams.get('url') || '';
    if (!vodUrl) return send(res, 200, JSON.stringify({ok:false,error:'missing url'}), 'application/json');
    
    // Extract vod_id from URL
    let vodId = vodUrl;
    const idMatch = vodUrl.match(/vod_id=(\d+)/);
    const idMatch2 = vodUrl.match(/vodId=(\d+)/);
    if (idMatch) vodId = idMatch[1];
    else if (idMatch2) vodId = idMatch2[1];
    else if (/^\d+$/.test(vodUrl)) vodId = vodUrl;
    
    return getActiveSource().detail(vodId).then(result => {
      if (!result.ok) return send(res, 200, JSON.stringify({ok:false,error:result.error}), 'application/json');
      
      // Convert to expected format — 同时返回 par/sid 供C页面lazyRule直接调用decode（参照云朵解析）
      const sources = (result.sources || []).map(src => ({
        name: src.name,
        episodes: src.episodes.map(function(ep) {
          // 从 @@ 格式中提取 par（真实播放地址）和 sid（线路标识）
          var parts = (ep.url || '').split('@@');
          var par = '', sid = src.name;
          if (parts.length >= 5) {
            sid = parts[0];
            par = parts.slice(4).join('@@');
          } else if (parts.length >= 4) {
            sid = parts[0];
            par = parts.slice(3).join('@@');
          } else {
            par = ep.url;
          }
          return { title: ep.name, url: ep.url, par: par, sid: sid };
        })
      }));
      
      // 同时返回vod元数据（海报/主演/简介等），供C页面展示
      var vod = result.vod || {};
      var vodInfo = {
        vod_id: vod.vod_id,
        vod_name: vod.vod_name,
        vod_pic: vod.vod_pic,
        vod_year: vod.vod_year,
        vod_area: vod.vod_area,
        vod_actor: vod.vod_actor,
        vod_director: vod.vod_director,
        vod_content: vod.vod_content,
        vod_class: vod.vod_class,
        vod_remarks: vod.vod_remarks,
        vod_duration: vod.vod_duration,
        vod_lang: vod.vod_lang,
        vod_douban_score: vod.vod_douban_score,
        type_name: vod.type_name
      };
      
      send(res, 200, JSON.stringify({ok:true, vod: vodInfo, sources, site: SITE}), 'application/json');
    }).catch(e => {
      send(res, 200, JSON.stringify({ok:false,error:e.message}), 'application/json');
    });
  }
  // 视频流代理（解决 ixigua Referer 403）
  if (pathname === '/play-stream') {
    const videoUrl = u.searchParams.get('url') || '';
    if (!videoUrl || !/^https?:/.test(videoUrl)) return send(res, 400, 'bad url');
    const mod = videoUrl.startsWith('https') ? https : http;
    const proxyReq = mod.request(videoUrl, { method:'GET', headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}, timeout:120000 }, proxyRes => {
      const h = { 'Content-Type': proxyRes.headers['content-type']||'video/mp4', 'Access-Control-Allow-Origin':'*', 'Cache-Control':'public, max-age=86400' };
      if (proxyRes.headers['content-length']) h['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range']) h['Content-Range'] = proxyRes.headers['content-range'];
      if (proxyRes.headers['accept-ranges']) h['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
      res.writeHead(proxyRes.statusCode, h);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => { try { res.writeHead(502); res.end('proxy error'); } catch(e){} });
    proxyReq.end();
    return;
  }

  // m3u8 代理：抓取 m3u8 并改写 ts 相对路径为代理 URL，解决 CORS 问题
  if (pathname === '/m3u8-proxy') {
    const m3u8Url = u.searchParams.get('url') || '';
    if (!m3u8Url || !/^https?:/.test(m3u8Url)) return send(res, 400, 'bad url');
    const mod = m3u8Url.startsWith('https') ? https : http;
    const m3u8Req = mod.request(m3u8Url, { method:'GET', headers:{'User-Agent':'Mozilla/5.0'}, timeout:15000 }, m3u8Res => {
      let m3u8Body = '';
      m3u8Res.on('data', c => m3u8Body += c);
      m3u8Res.on('end', () => {
        // 计算 m3u8 的 base URL，用于解析 ts 相对路径
        var baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
        // 改写每行：非注释行且看起来像 ts/分片路径的，改成 /play-stream?url=<绝对URL>
        var lines = m3u8Body.split('\n');
        var rewritten = lines.map(function(line) {
          line = line.trim();
          if (!line || line.charAt(0) === '#') return line;
          // 已经是完整 URL
          if (/^https?:\/\//.test(line)) {
            return '/play-stream?url=' + encodeURIComponent(line);
          }
          // 相对路径：拼成完整 URL 再代理
          var absUrl = baseUrl + line;
          return '/play-stream?url=' + encodeURIComponent(absUrl);
        });
        var out = rewritten.join('\n');
        res.writeHead(200, { 'Content-Type':'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin':'*', 'Cache-Control':'no-cache' });
        res.end(out);
      });
    });
    m3u8Req.on('error', () => { try { res.writeHead(502); res.end('m3u8 proxy error'); } catch(e){} });
    m3u8Req.end();
    return;
  }

  // 播放器页面
  if (pathname === '/player') {
    const playUrl = u.searchParams.get('url') || '';
    const title = u.searchParams.get('title') || '';
    const vodUrl = u.searchParams.get('vod') || '';
    const img = u.searchParams.get('img') || '';
    const srcParam = u.searchParams.get('src') || '';
    var parsedSources = null;
    if (srcParam) { try { parsedSources = JSON.parse(srcParam); } catch(e) {} }
    return send(res, 200, playerHtml(playUrl, title, vodUrl, img, parsedSources), 'text/html; charset=utf-8');
  }

  // decode 接口（参照云朵解析：直接传 par + sid，代理用当前源签名调 decode）
  if (pathname === '/api/decode') {
    const par = u.searchParams.get('par') || '';
    const sid = u.searchParams.get('sid') || '';
    if (!par) return send(res, 200, JSON.stringify({ok:false,error:'missing par'}), 'application/json');
    
    // 1) 直链视频直接返回
    if (/^https?:\/\/.+\.(m3u8|mp4|flv|ts|aac)(\?|$)/i.test(par)) {
      return send(res, 200, JSON.stringify({ok:true, data:par}), 'application/json');
    }
    
    // 2) 调用 decode 接口（代理用当前源的签名）
    return getActiveSource().decodeUrl(par, sid).then(function(decodeData) {
      try {
        var dj = JSON.parse(decodeData);
        if (dj && dj.data) {
          var du = String(dj.data).trim();
          if (du) return send(res, 200, JSON.stringify({ok:true, data:du}), 'application/json');
        }
        return send(res, 200, JSON.stringify({ok:false,error:'decode返回空'}), 'application/json');
      } catch(e) {
        return send(res, 200, JSON.stringify({ok:false,error:'decode解析失败:'+e.message}), 'application/json');
      }
    }).catch(function(e) {
      send(res, 200, JSON.stringify({ok:false,error:e.message}), 'application/json');
    });
  }

  // 解析播放页真实地址 API
if (pathname === '/api/play-url') {
    const playUrl = u.searchParams.get('url') || '';
    const direct = u.searchParams.get('direct') || '';
    if (!playUrl) return send(res, 200, JSON.stringify({ok:false,error:'missing url'}), 'application/json');
    
    // Direct video URLs return as-is
    if (direct === '1' || /^https?:\/\//i.test(playUrl) && /(m3u8|mp4|flv|ts|aac)/i.test(playUrl)) {
      return send(res, 200, JSON.stringify({ok:true, data:{url:playUrl, encrypt:0}}), 'application/json');
    }
    
    // Use TVBox API to decode play URL
    return getActiveSource().play(playUrl).then(result => {
      if (!result.ok) return send(res, 200, JSON.stringify({ok:false,error:result.error}), 'application/json');
      var payload = {ok:true, data:{url:result.url, encrypt:0, header:result.header}};
      if (result.parse) payload.data.parse = true; // 需前端用 iframe 解析器播放
      send(res, 200, JSON.stringify(payload), 'application/json');
    }).catch(e => {
      send(res, 200, JSON.stringify({ok:false,error:e.message}), 'application/json');
    });
  }

  // TMDB横图背景+Logo接口（供C页面异步获取高清横图和影片Logo）
  if (pathname === '/api/tmdb-backdrop') {
    const title = (u.searchParams.get('title') || '').trim();
    if (!title) return send(res, 200, JSON.stringify({ok:false, error:'missing title'}), 'application/json');
    if (!TMDB_KEY) return send(res, 200, JSON.stringify({ok:false, error:'no tmdb key'}), 'application/json');
    const clean = title.replace(/\(?\d{4}\)?$/, '').replace(/第\d+集$/, '').trim();
    const searchUrl = `${TMDB_BASE}/search/multi?api_key=${TMDB_KEY}&language=zh-CN&query=${encodeURIComponent(clean)}&include_adult=false&page=1`;
    return fetchPage(searchUrl, function(err, text) {
      try {
        if (err) return send(res, 200, JSON.stringify({ok:false, error:err.message}), 'application/json');
        const data = JSON.parse(text);
        const results = (data.results || []).filter(function(r){return r.media_type==='movie'||r.media_type==='tv'});
        if (!results.length) return send(res, 200, JSON.stringify({ok:false, error:'no results'}), 'application/json');
        const r = results[0];
        const mt = r.media_type;
        // 请求详情获取 backdrop + images.logos（一次性拿全）
        const detailUrl = `${TMDB_BASE}/${mt}/${r.id}?api_key=${TMDB_KEY}&language=zh-CN&append_to_response=images`;
        return fetchPage(detailUrl, function(e2, t2) {
          try {
            const det = JSON.parse(t2);
            var _backdrop = det.backdrop_path ? 'https://image.tmdb.org/t/p/w780' + det.backdrop_path : '';
            var _logos = det.images && det.images.logos ? det.images.logos : [];
            var _zhLogo = _logos.find(function(l){return l.iso_639_1==='zh'}) || _logos.find(function(l){return l.iso_639_1==='en'});
            var _logo = _zhLogo && _zhLogo.file_path ? 'https://image.tmdb.org/t/p/original' + _zhLogo.file_path : '';
            if (_backdrop || _logo) {
              send(res, 200, JSON.stringify({ok:true, backdrop:_backdrop, logo:_logo}), 'application/json');
            } else {
              send(res, 200, JSON.stringify({ok:false, error:'no backdrop or logo'}), 'application/json');
            }
          } catch(e) {
            send(res, 200, JSON.stringify({ok:false, error:'parse error'}), 'application/json');
          }
        });
      } catch(e) {
        send(res, 200, JSON.stringify({ok:false, error:e.message}), 'application/json');
      }
    });
  }

  // TMDB详情页
  if (pathname === '/tmdb-page') {
    const title = u.searchParams.get('title') || '';
    const vodUrl = u.searchParams.get('vodUrl') || u.searchParams.get('url') || '';
    let img = u.searchParams.get('img') || '';
    if(!img&&vodUrl){img=_imgCache.get(vodUrl)||''}
    if(img&&vodUrl){_imgCache.set(vodUrl,img)}

    // 如果有完整的页面缓存，直接返回（返回时秒开，不重新搜索 TMDB）
    var _cachedPage=_pageCache.get(vodUrl);
    if(_cachedPage){return send(res,200,_cachedPage,'text/html; charset=utf-8')}
    var cachedSources=null;var _pc=_playDataCache.get(vodUrl);if(_pc)cachedSources=_pc;
    const fullVodUrl = vodUrl && /^https?:/.test(vodUrl) ? vodUrl : vodUrl && /^[a-z]+:\/\//.test(vodUrl) ? vodUrl : vodUrl ? 'https://ds3xy2yunsa.xyz' + vodUrl : vodUrl;
    const clean = title.replace(/\(?\d{4}\)?$/,'').replace(/第\d+集$/,'').trim();
    if (!TMDB_KEY) {
      // No TMDB key — still render page with sources
      let d = {title:clean,originalTitle:'',overview:'',rating:0,year:'',runtime:0,genres:[],cast:[],backdrop:'',seasons:0,eps:0};
      const html = tmdbPageHtml(d, vodUrl, img, cachedSources);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    const searchUrl = `${TMDB_BASE}/search/multi?api_key=${TMDB_KEY}&language=zh-CN&query=${encodeURIComponent(clean)}&include_adult=false&page=1`;
    return fetchPage(searchUrl, (err, text) => {
      let d = {title:clean,originalTitle:'',overview:'',rating:0,year:'',runtime:0,genres:[],cast:[],backdrop:'',seasons:0,eps:0};
      try {
        const data = JSON.parse(text);
        const results = (data.results||[]).filter(r=>r.media_type==='movie'||r.media_type==='tv');
        if (results.length) {
          const r = results[0];
          const mt = r.media_type;
          const detailUrl = `${TMDB_BASE}/${mt}/${r.id}?api_key=${TMDB_KEY}&language=zh-CN&append_to_response=credits,images`;
          return fetchPage(detailUrl, (e2, t2) => {
            try {
              const det = JSON.parse(t2);
              d.title = det.title||det.name||clean;
              d.originalTitle = det.original_title||det.original_name||'';
              d.overview = det.overview||'';
              d.rating = det.vote_average||0;
              d.year = (det.release_date||det.first_air_date||'').substring(0,4);
              d.runtime = det.runtime||(det.episode_run_time&&det.episode_run_time[0])||0;
              d.genres = (det.genres||[]).map(g=>g.name);
              d.cast = (det.credits?.cast||[]).slice(0,30).map(c=>({id:c.id,name:c.name,pic:c.profile_path?`https://image.tmdb.org/t/p/w185${c.profile_path}`:''}));
              d.backdrop = det.backdrop_path?`https://image.tmdb.org/t/p/w780${det.backdrop_path}`:'';
              var _logos=det.images&&det.images.logos?det.images.logos:[];
              var _zhLogo=_logos.find(function(l){return l.iso_639_1==='zh'})||_logos.find(function(l){return l.iso_639_1==='en'});
              d.logo=_zhLogo?_zhLogo.file_path?'https://image.tmdb.org/t/p/original'+_zhLogo.file_path:'':'';
              if(mt==='tv'){d.seasons=det.number_of_seasons||0;d.eps=det.number_of_episodes||0;}
            } catch(e){}
            var _html=tmdbPageHtml(d, vodUrl, img, cachedSources);_pageCache.set(vodUrl,_html);send(res,200,_html,'text/html; charset=utf-8');
          });
        }
      } catch(e){}
      if (!d.overview && !d.cast.length) d.overview = '未在 TMDB 匹配到该影片信息。';
      var _html2=tmdbPageHtml(d, vodUrl, img, cachedSources);_pageCache.set(vodUrl,_html2);send(res,200,_html2,'text/html; charset=utf-8');
    });
  }

  // TMDB演员详情页
  if (pathname === '/tmdb/person-page') {
    if (!TMDB_KEY) return send(res, 500, 'TMDB API Key not configured');
    const id = u.searchParams.get('id') || '';
    const name = u.searchParams.get('name') || '';
    if (!id) return send(res, 400, 'missing id');
    const PROF = 'https://image.tmdb.org/t/p/w185';
    const IMG = 'https://images.tmdb.org/t/p/w500';
    const pUrl = `${TMDB_BASE}/person/${id}?api_key=${TMDB_KEY}&language=zh-CN&append_to_response=combined_credits`;
    return fetchPage(pUrl, (e, json) => {
      if (e) return send(res, 500, 'fetch error');
      try {
        const data = JSON.parse(json);
        const bio = data.biography || '暂无简介';
        const photo = data.profile_path ? PROF + data.profile_path : '';
        const birthday = data.birthday || '';
        const deathday = data.deathday || '';
        const place = data.place_of_birth || '';
        const knownFor = data.known_for_department || '';
        const genderMap = {0:'',1:'女',2:'男'};
        const gender = genderMap[data.gender] || '';
        const aka = (data.also_known_as || []).slice(0, 5);
        const allWorks = ((data.combined_credits && data.combined_credits.cast) || [])
          .filter(w => (w.media_type === 'movie' || w.media_type === 'tv') && (w.poster_path || w.vote_average > 0))
          .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
        const infoHtml = [
          birthday ? '<div class=info-row><span class=info-label>生日</span><span class=info-val>' + esc(birthday) + (deathday ? ' - ' + esc(deathday) : '') + '</span></div>' : '',
          place ? '<div class=info-row><span class=info-label>出生地</span><span class=info-val>' + esc(place) + '</span></div>' : '',
          gender ? '<div class=info-row><span class=info-label>性别</span><span class=info-val>' + gender + '</span></div>' : '',
          knownFor ? '<div class=info-row><span class=info-label>职业</span><span class=info-val>' + esc(knownFor) + '</span></div>' : '',
          aka.length ? '<div class=info-row><span class=info-label>别名</span><span class=info-val>' + aka.map(a => esc(a)).join(' / ') + '</span></div>' : ''
        ].filter(Boolean).join('');
        const worksJson = JSON.stringify(allWorks.map(w => ({
          title: w.title || w.name || '',
          poster: w.poster_path ? IMG + w.poster_path : '',
          rating: w.vote_average ? w.vote_average.toFixed(1) : '',
          media_type: w.media_type,
          character: w.character || ''
        })));
        const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{min-height:100vh;overflow-x:hidden;background:rgba(10,14,26,.3);color:#eee;background-image:radial-gradient(ellipse at 30% 20%,rgba(79,195,247,.08) 0%,transparent 50%),radial-gradient(ellipse at 70% 80%,rgba(246,211,101,.06) 0%,transparent 50%)}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.nbtn{background:rgba(255,255,255,.15);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center;margin-left:6px;margin-top:8px;margin-bottom:8px}
.wrap{max-width:600px;margin:0 auto;padding:16px;background:rgba(255,255,255,.04);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.08);border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.3)}
.photo{display:flex;gap:16px;align-items:flex-start;margin-bottom:16px}
.photo img{width:110px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.5)}
.pinfo{flex:1;min-width:0}
.nm{font-size:22px;font-weight:800;line-height:1.3}
.info-row{display:flex;gap:8px;padding:4px 0;font-size:12px;color:rgba(224,224,224,.7)}
.info-label{flex-shrink:0;color:rgba(79,195,247,.8);min-width:42px}
.info-val{color:rgba(224,224,224,.85)}
.bio{font-size:13px;color:rgba(224,224,224,.78);line-height:1.7;margin-bottom:20px}
.stitle{font-size:15px;font-weight:700;color:#fff;margin-bottom:12px}
.pworks{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.pwi{cursor:pointer;background:rgba(255,255,255,.06);border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s,box-shadow .3s}
.pwi:active{transform:scale(.96)}
.pwi img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;background:#161628}
.pwi .pwt{padding:4px 6px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(224,224,224,.9)}
.pwi .pwr{padding:0 6px 6px;font-size:10px;color:#ffc107}
.tip{text-align:center;padding:16px;color:rgba(255,255,255,.5);font-size:13px}
.fbtn{position:fixed;bottom:24px;right:16px;z-index:30;width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.5);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.fbtn:active{transform:scale(.9)}
</style></head><body>${COMMON_ANTI_COPY}
<div style="padding:8px"><button class=nbtn onclick="history.back()">\u2190</button></div>
<div class=wrap>
${photo ? '<div class=photo><img src="'+escAttr(photo)+'"><div class=pinfo><div class=nm>'+esc(name)+'</div>'+infoHtml+'</div></div>' : '<div class=nm>'+esc(name)+'</div>'+infoHtml}
<div class=bio>${esc(bio)}</div>
<div class=stitle>相关作品</div>
<div class=pworks id=works></div>
<div class=tip id=tip>加载中...</div>
</div>
<script>
var allWorks=${worksJson},page=0,per=18,loading=false;
function el(s){return document.querySelector(s)}
function addWork(w){
  var d=document.createElement('div');d.className='pwi';
  var img=w.poster?'<img src="'+w.poster+'" loading=lazy>':'<div style="width:100%;aspect-ratio:2/3;background:#222"></div>';
  var metaHtml='<div style="display:flex;justify-content:space-between;align-items:center;padding:0 6px 4px;font-size:10px;color:rgba(255,255,255,0.7)">';
  if(w.rating)metaHtml+='<span>⭐ '+w.rating+'</span>';
  if(w.character)metaHtml+='<span style="color:rgba(255,255,255,0.5);font-size:9px">饰演：'+w.character+'</span>';
  metaHtml+='</div>';
  d.innerHTML=img+'<div class=pwt>'+w.title+'</div>'+metaHtml;
  d.onclick=function(){if(window.parent!==window){parent.postMessage({type:'dsjSearch',query:w.title},'*')}else{location.href='/search?wd='+encodeURIComponent(w.title)}};
  el('#works').appendChild(d);
}
function loadMore(){
  if(loading)return;loading=true;
  var start=page*per,end=Math.min(start+per,allWorks.length);
  if(start>=allWorks.length){el('#tip').textContent='已显示全部 '+allWorks.length+' 部作品';return}
  for(var i=start;i<end;i++)addWork(allWorks[i]);
  page++;loading=false;
  el('#tip').textContent='已加载 '+Math.min(end,allWorks.length)+' / '+allWorks.length;
}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)loadMore()},{rootMargin:'300px'});
io.observe(el('#tip'));loadMore();
<\/script><button class=fbtn onclick="history.back()">\u2190</button></body></html>`;
        send(res, 200, html, 'text/html; charset=utf-8');
      } catch (err) { send(res, 500, 'parse error'); }
    });
  }

  // ========== 收藏 & 历史 API ==========
  if (pathname === '/fav-add') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { const item = JSON.parse(body); send(res, 200, JSON.stringify(favAdd(item)), 'application/json'); }
      catch(e) { send(res, 400, '{"ok":false}'); }
    });
    return;
  }

  if (pathname === '/fav-remove') {
    const id = u.searchParams.get('id') || '';
    return send(res, 200, JSON.stringify(favRemove(id)), 'application/json');
  }

  if (pathname === '/fav-list') {
    return send(res, 200, JSON.stringify({ ok: true, items: favList() }), 'application/json');
  }

  if (pathname === '/fav-check') {
    const id = u.searchParams.get('id') || '';
    return send(res, 200, JSON.stringify({ faved: favCheck(id) }), 'application/json');
  }

  if (pathname === '/his-add') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const item = JSON.parse(body);
        item.source = _activeSourceKey;
        // 使 ID 源专属，避免不同源相同 vod_id 的历史记录冲突
        if (item.id) item.id = _activeSourceKey + '__' + item.id;
        send(res, 200, JSON.stringify(hisAdd(item)), 'application/json');
      }
      catch(e) { send(res, 400, '{"ok":false}'); }
    });
    return;
  }

  if (pathname === '/his-list') {
    var _hisAll = hisList();
    var _hisFiltered = _hisAll.filter(function(h) {
      return h.source === _activeSourceKey || (!h.source && _activeSourceKey === 'bubu') || (h.source === 'bubutv' && _activeSourceKey === 'bubu');
    });
    var _hisWithNames = _hisFiltered.map(function(h) { h.sourceName = (sourceMeta[h.source] && sourceMeta[h.source].name) || (h.source === 'bubutv' ? '布布影视' : (sourceMeta[_activeSourceKey] && sourceMeta[_activeSourceKey].name) || ''); return h; });
    return send(res, 200, JSON.stringify({ ok: true, items: _hisWithNames, sourceName: (sourceMeta[_activeSourceKey] && sourceMeta[_activeSourceKey].name) || '' }), 'application/json');
  }

  if (pathname === '/his-clear') {
    // 只清空当前源的历史，保留其他源
    var _hisAll2 = hisList();
    var _hisKeep = _hisAll2.filter(function(h) { return h.source !== _activeSourceKey && h.source !== 'bubutv'; });
    if (_activeSourceKey === 'bubu') _hisKeep = _hisAll2.filter(function(h) { return h.source && h.source !== 'bubu' && h.source !== 'bubutv'; });
    writeJSON(HIS_FILE, _hisKeep);
    return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
  }

  if (pathname === '/his-remove') {
    const id = u.searchParams.get('id') || '';
    return send(res, 200, JSON.stringify(hisRemove(id)), 'application/json');
  }

  if (pathname === '/fav-clear') {
    writeJSON(FAV_FILE, []);
    return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
  }

  if (pathname === '/fav-add-redirect') {
    const title = u.searchParams.get('title') || '';
    const url = u.searchParams.get('url') || '';
    const img = u.searchParams.get('img') || '';
    const id = url.replace(/[^a-zA-Z0-9]/g, '_');
    favAdd({ id, title, url, img, source: 'bubutv' });
    res.writeHead(302, { 'Location': '/favorites' });
    return res.end();
  }

  // 收藏页
  if (pathname === '/favorites') {
    return send(res, 200, favoritesHtml(), 'text/html; charset=utf-8');
  }

  // 历史页
  if (pathname === '/history') {
    return send(res, 200, historyHtml(), 'text/html; charset=utf-8');
  }


  // ========== 文件管理器路由 ==========
  if (pathname === '/files') {
    const dir = u.searchParams.get('path') || '/sdcard/Download/';
    return send(res, 200, fileManagerHtml(dir), 'text/html; charset=utf-8');
  }

  if (pathname === '/files-api') {
    const dir = u.searchParams.get('path') || '/sdcard/Download/';
    try {
      if (!fs.existsSync(dir)) return send(res, 200, JSON.stringify({ok:false,error:'目录不存在: '+dir}), 'application/json');
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) return send(res, 200, JSON.stringify({ok:false,error:'不是目录'}), 'application/json');
      const entries = fs.readdirSync(dir);
      const items = [];
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        const fp = path.join(dir, name);
        try {
          const s = fs.statSync(fp);
          var thumb = '';
          if (s.isDirectory()) {
            try {
              var subFiles = fs.readdirSync(fp);
              for (const cn of ['cover.jpg','cover.png','folder.jpg','folder.png','poster.jpg','poster.png']) {
                if (subFiles.includes(cn)) { thumb = path.join(fp, cn); break; }
              }
            } catch(e2) {}
          }
          items.push({
            name: name,
            path: fp,
            isDir: s.isDirectory(),
            size: s.isDirectory() ? 0 : s.size,
            mtime: s.mtimeMs,
            thumb: thumb
          });
        } catch(e) {}
      }
      // Sort: directories first, then by name
      items.sort(function(a,b) {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
      send(res, 200, JSON.stringify({ok:true, items:items}), 'application/json');
    } catch(e) {
      send(res, 200, JSON.stringify({ok:false,error:e.message}), 'application/json');
    }
    return;
  }

  if (pathname === '/files-stream') {
    const fp = u.searchParams.get('path') || '';
    if (!fp || !fs.existsSync(fp)) return send(res, 404, 'not found');
    try {
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) return send(res, 400, 'is directory');
      const ext = path.extname(fp).toLowerCase();
      const mimeMap = {
        '.mp4':'video/mp4','.mkv':'video/x-matroska','.avi':'video/x-msvideo',
        '.mov':'video/quicktime','.flv':'video/x-flv','.ts':'video/mp2t',
        '.webm':'video/webm','.m4v':'video/mp4',
        '.mp3':'audio/mpeg','.wav':'audio/wav','.flac':'audio/flac',
        '.aac':'audio/aac','.ogg':'audio/ogg','.m4a':'audio/mp4','.opus':'audio/opus',
        '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
        '.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.svg':'image/svg+xml',
        '.srt':'text/plain','.ass':'text/plain','.vtt':'text/vtt',
        '.txt':'text/plain','.json':'application/json','.xml':'application/xml',
        '.pdf':'application/pdf'
      };
      const ct = mimeMap[ext] || 'application/octet-stream';
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': ct,
          'Access-Control-Allow-Origin': '*',
          'Content-Disposition': ext === '.pdf' ? 'inline' : 'inline'
        });
        fs.createReadStream(fp, {start, end}).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': ct,
          'Access-Control-Allow-Origin': '*',
          'Content-Disposition': 'inline'
        });
        fs.createReadStream(fp).pipe(res);
      }
    } catch(e) {
      send(res, 500, 'error: ' + e.message);
    }
    return;
  }

  if (pathname === '/files-epub-view' || pathname === '/files-epub-text') { return handleFilesEpub(req, res, u, pathname); }

  if (pathname === '/files-thumb') {
    const fp = u.searchParams.get('path') || '';
    if (!fp || !fs.existsSync(fp)) return send(res, 404, 'not found');
    try {
      const stat = fs.statSync(fp);
      if (stat.size > 10 * 1024 * 1024) return send(res, 413, 'too large');
      const ext = path.extname(fp).toLowerCase();
      const ct = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp'}[ext] || 'application/octet-stream';
      res.writeHead(200, {'Content-Type':ct,'Content-Length':stat.size,'Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=86400'});
      fs.createReadStream(fp).pipe(res);
    } catch(e) {
      send(res, 500, 'error');
    }
    return;
  }

  if (pathname === '/files-lyrics') { return handleFilesLyrics(req, res, u); }

  if (pathname === '/files-cover') {
    const fp = u.searchParams.get('path') || '';
    const name = u.searchParams.get('name') || '';
    if (!fp) return send(res, 200, JSON.stringify({ok:false}), 'application/json');
    try {
      var dirName = path.dirname(fp);
      var baseName = path.basename(fp, path.extname(fp));
      // 1. 同目录下同名图片（cover.jpg/png、folder.jpg、同名.jpg/png）
      var coverExts = ['.jpg','.jpeg','.png','.webp'];
      var candidates = [];
      for (var ei = 0; ei < coverExts.length; ei++) {
        candidates.push(path.join(dirName, baseName + coverExts[ei]));
        candidates.push(path.join(dirName, 'cover' + coverExts[ei]));
        candidates.push(path.join(dirName, 'folder' + coverExts[ei]));
        candidates.push(path.join(dirName, 'album' + coverExts[ei]));
      }
      // 2. 歌词文件夹下同名图片
      var lrcDir = path.join(dirName, '\u6b4c\u8bcd');
      for (var ei2 = 0; ei2 < coverExts.length; ei2++) {
        candidates.push(path.join(lrcDir, baseName + coverExts[ei2]));
        candidates.push(path.join(lrcDir, 'cover' + coverExts[ei2]));
      }
      for (var ci = 0; ci < candidates.length; ci++) {
        if (fs.existsSync(candidates[ci])) {
          return send(res, 200, JSON.stringify({ok:true, cover:'/files-stream?path=' + encodeURIComponent(candidates[ci]), source:'local'}), 'application/json');
        }
      }
      // 无本地封面时返回false，前端回退到随机图片
      send(res, 200, JSON.stringify({ok:false}), 'application/json');
    } catch(e) {
      send(res, 200, JSON.stringify({ok:false}), 'application/json');
    }
    return;
  }

  if (pathname === '/files-save-lyrics' && req.method === 'POST') {
    var body = '';
    req.on('data', function(c) { body += c; if (body.length > 500000) req.destroy(); });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        var songPath = data.path || '';
        var lyrics = data.lyrics || '';
        if (!songPath || !lyrics) return send(res, 200, JSON.stringify({ok:false, error:'missing params'}), 'application/json');
        var dirName = path.dirname(songPath);
        var baseName = path.basename(songPath, path.extname(songPath));
        var lrcDir = path.join(dirName, '\u6b4c\u8bcd');
        try { if (!fs.existsSync(lrcDir)) fs.mkdirSync(lrcDir, {recursive:true}); } catch(e) {}
        var lrcPath = path.join(lrcDir, baseName + '.lrc');
        fs.writeFileSync(lrcPath, lyrics, 'utf8');
        send(res, 200, JSON.stringify({ok:true, path:lrcPath}), 'application/json');
      } catch(e) {
        send(res, 200, JSON.stringify({ok:false, error:e.message}), 'application/json');
      }
    });
    return;
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[bubutv-proxy] http://0.0.0.0:${PORT}`);
  const keySource = process.env.TMDB_KEY ? 'env' : (fs.existsSync(_TMDB_CONFIG_FILE) ? 'config' : 'default');
  console.log(`[bubutv-proxy] http://0.0.0.0:${PORT} | TMDB key: ${keySource}`);});



// ========== 本地影片库 API（从 createServer 回调拆出，隔离 V8 TurboFan 对 map 回调的优化）==========
function handleLocalApi(req, res, u, pathname) {
// 本地JSON文件列表
if (pathname === '/local-list-api') {
  try {
    ensureDataDir();
    var files = fs.readdirSync(DATA_DIR).filter(function(f) { return f.endsWith('.json'); }).map(function(f) {
      var fp = path.join(DATA_DIR, f);
      var stat = fs.statSync(fp);
      var count = 0;
      try {
        var list = getLocalList(fp);
        count = list.length;
      } catch(e) {}
      return { name: f, size: stat.size, count: count };
    });
    send(res, 200, JSON.stringify({ok:true, files: files}), 'application/json');
  } catch(e) { send(res, 200, JSON.stringify({ok:false, error: e.message}), 'application/json'); }
  return;
}

// 本地JSON文件内容API
if (pathname === '/local-api') {
  const filePath = u.searchParams.get('file') || '';
  const page = parseInt(u.searchParams.get('page') || '1');
  const category = u.searchParams.get('category') || '';
  if (!filePath) return send(res, 200, JSON.stringify({ok:false,error:'no file param'}));
  const absPath = filePath.charAt(0) === '/' ? filePath : path.join(DATA_DIR, filePath);
  try {
    var list = getLocalList(absPath);
    // 按分类过滤
    if (category) {
      list = list.filter(function(v) {
        var vid = (v.vod_id || '').toLowerCase();
        var tn = (v.type_name || '').toLowerCase();
        if (category === 'movie') return vid.indexOf('/movie/') > -1;
        if (category === 'tv') return vid.indexOf('/tv/') > -1;
        if (category === 'other') return vid.indexOf('/movie/') === -1 && vid.indexOf('/tv/') === -1;
        return true;
      });
    }
    var pageSize = 20;
    var start = (page - 1) * pageSize;
    var pageList = list.slice(start, start + pageSize);
    var items = pageList.map(function(v) {
      var playFrom = (v.vod_play_from || '').split('$$$');
      var playUrl = (v.vod_play_url || '').split('$$$');
      var sources = [];
      for (var i = 0; i < playFrom.length; i++) {
        var eps = (playUrl[i] || '').split('#');
        var epList = [];
        for (var j = 0; j < eps.length; j++) {
          var parts = eps[j].split('$');
          if (parts.length >= 2) epList.push({title: parts[0], url: parts[1]});
          else if (parts.length === 1 && parts[0]) epList.push({title: '第' + (j + 1) + '集', url: parts[0]});
        }
        if (epList.length) sources.push({name: playFrom[i] || ('线路' + (i + 1)), episodes: epList});
      }
      var img = v.vod_pic || '';
      var proxyImg = img ? '/img?url=' + encodeURIComponent(img) : '';
      return {
        title: v.vod_name || '', url: v.vod_id || '', img: proxyImg, directImg: img,
        tag: v.vod_remarks || '', desc: v.vod_actor || '',
        meta: (v.vod_year || '') + ' ' + (v.vod_area || ''),
        actors: v.vod_actor || '', intro: v.vod_content ? strip(v.vod_content) : '',
        sources: sources,
        playUrl: (function() {
          for (var i = 0; i < playUrl.length; i++) {
            var eps = (playUrl[i] || '').split('#');
            for (var j = 0; j < eps.length; j++) {
              var parts = eps[j].split('$');
              var u2 = parts.length >= 2 ? parts[1] : parts[0];
              if (u2 && /\.m3u8/i.test(u2)) return u2;
            }
          }
          return playUrl[0] ? (playUrl[0].split('#')[0].split('$')[1] || '') : '';
        })(),
        vodUrl: v.vod_id || ''
      };
    });
    send(res, 200, JSON.stringify({ok:true, items: items, total: list.length, page: page}), 'application/json');
  } catch(e) { send(res, 200, JSON.stringify({ok:false, error: e.message}), 'application/json'); }
  return;
}

// 本地搜索页面
if (pathname === '/local-search') {
  const wd = u.searchParams.get('wd') || '';
  return send(res, 200, localSearchHtml(wd), 'text/html; charset=utf-8');
}

// 本地搜索API（去重）
if (pathname === '/local-search-api') {
  const wd = (u.searchParams.get('wd') || '').trim().toLowerCase();
  if (!wd) return send(res, 200, JSON.stringify({ok:true, items:[], total:0}), 'application/json');
  try {
    ensureDataDir();
    var allFiles = fs.readdirSync(DATA_DIR).filter(function(f) { return f.endsWith('.json'); });
    var allItems = [];
    for (var fi = 0; fi < allFiles.length; fi++) {
      try {
        var listF = getLocalList(path.join(DATA_DIR, allFiles[fi]));
        for (var vi = 0; vi < listF.length; vi++) {
          var v = listF[vi];
          var name = (v.vod_name || '').toLowerCase();
          var actor = (v.vod_actor || '').toLowerCase();
          var area = (v.vod_area || '').toLowerCase();
          var year = (v.vod_year || '').toLowerCase();
          var typeName = (v.type_name || '').toLowerCase();
          if (name.indexOf(wd) > -1 || actor.indexOf(wd) > -1 || area.indexOf(wd) > -1 || year.indexOf(wd) > -1 || typeName.indexOf(wd) > -1) {
            var playFrom = (v.vod_play_from || '').split('$$$');
            var playUrl2 = (v.vod_play_url || '').split('$$$');
            var sources = [];
            for (var i = 0; i < playFrom.length; i++) {
              var eps = (playUrl2[i] || '').split('#');
              var epList = [];
              for (var j = 0; j < eps.length; j++) {
                var parts = eps[j].split('$');
                if (parts.length >= 2) epList.push({title: parts[0], url: parts[1]});
                else if (parts.length === 1 && parts[0]) epList.push({title: '第' + (j + 1) + '集', url: parts[0]});
              }
              if (epList.length) sources.push({name: playFrom[i] || ('线路' + (i + 1)), episodes: epList});
            }
            var img = v.vod_pic || '';
            var proxyImg = img ? '/img?url=' + encodeURIComponent(img) : '';
            allItems.push({
              title: v.vod_name || '', url: v.vod_id || '', img: proxyImg, directImg: img,
              tag: v.vod_remarks || '', desc: v.vod_actor || '',
              meta: (v.vod_year || '') + ' ' + (v.vod_area || ''),
              actors: v.vod_actor || '', intro: v.vod_content ? strip(v.vod_content) : '',
              sources: sources,
              playUrl: (function() {
                for (var i = 0; i < playUrl2.length; i++) {
                  var eps = (playUrl2[i] || '').split('#');
                  for (var j = 0; j < eps.length; j++) {
                    var parts = eps[j].split('$');
                    var u2 = parts.length >= 2 ? parts[1] : parts[0];
                    if (u2 && /\.m3u8/i.test(u2)) return u2;
                  }
                }
                return playUrl2[0] ? (playUrl2[0].split('#')[0].split('$')[1] || '') : '';
              })(),
              vodUrl: v.vod_id || '', fromFile: allFiles[fi]
            });
          }
        }
      } catch(e) {}
    }
    // 去重
    var seen = new Map();
    var uniqueItems = [];
    for (var di = 0; di < allItems.length; di++) {
      var item = allItems[di];
      var key = item.vodUrl || item.title || ('item_' + di);
      if (!seen.has(key)) { seen.set(key, true); uniqueItems.push(item); }
    }
    send(res, 200, JSON.stringify({ok:true, items: uniqueItems, total: uniqueItems.length}), 'application/json');
  } catch(e) { send(res, 200, JSON.stringify({ok:false, error: e.message}), 'application/json'); }
  return;
}

}

// ========== EPUB/ZIP 解析（从 createServer 回调拆出，隔离 V8 TurboFan 对二进制操作的优化）==========
function handleFilesEpub(req, res, u, pathname) {

  const fp = u.searchParams.get('path') || '';
  if (!fp || !fs.existsSync(fp)) return send(res, 200, JSON.stringify({ok:false,error:'文件不存在'}), 'application/json');
  try {
    const zlib = require('zlib');
    const stat = fs.statSync(fp);
    if (stat.size > 100*1024*1024) return send(res, 200, JSON.stringify({ok:false,error:'EPUB文件过大（超过100MB）'}), 'application/json');
    const data = fs.readFileSync(fp);
    const texts = [];
    const errors = [];
    let htmlCount = 0;
    const imgMap = {};
    const imgExts = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.svg':'image/svg+xml'};

    function findEocd(data) {
      for (let ei = data.length - 22; ei >= Math.max(0, data.length - 65557); ei--) {
        if (data.readUInt32LE(ei) === 0x06054b50) return ei;
      }
      return -1;
    }
    function readUInt64LE(buf, off) { return Number(buf.readBigUInt64LE(off)); }

    // 提取文件数据的通用函数
    function extractFile(data, localOff, cdCSize, cdMethod) {
      const lhNLen = data.readUInt16LE(localOff + 26);
      const lhELen = data.readUInt16LE(localOff + 28);
      const dStart = localOff + 30 + lhNLen + lhELen;
      if (cdMethod === 8) {
        return zlib.inflateRawSync(data.slice(dStart, dStart + cdCSize));
      } else if (cdMethod === 0) {
        return data.slice(dStart, dStart + cdCSize);
      }
      return null;
    }

    // 处理HTML内容：保留img标签，替换src为base64
    function processHtml(raw) {
      // 去掉style和script
      let html = raw.replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<script[\s\S]*?<\/script>/gi,'');
      // 替换img的src
      html = html.replace(/(<img\s[^>]*?src\s*=\s*)(["'])([^"']+)\2/gi, function(m, pre, q, src) {
        var resolved = resolveEpubPath(src);
        if (imgMap[resolved]) return pre + q + imgMap[resolved] + q;
        // 也尝试不带路径的匹配
        var baseName = resolved.split('/').pop();
        for (var k in imgMap) { if (k.endsWith(baseName)) return pre + q + imgMap[k] + q; }
        return m;
      });
      // 去掉其他标签但保留内容，保留img
      html = html.replace(/<(?!\/?img\b)[^>]+>/g, function(tag) {
        // 保留br、p、div、h1-h6的换行效果
        if (/^<br/i.test(tag)) return '\n';
        if (/^<(\/?)(p|div|h[1-6]|li|tr|blockquote)/i.test(tag)) return '\n';
        return '';
      });
      html = html.replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\n{3,}/g,'\n\n').trim();
      return html;
    }

    // 解析EPUB内部路径（相对路径解析）
    var htmlBasePath = '';
    function resolveEpubPath(src) {
      src = src.replace(/^\.\//,'').replace(/^\.\.\//,'');
      // 去除fragment
      src = src.split('#')[0];
      // 相对路径解析
      if (src.startsWith('/')) return src.replace(/^\//,'');
      if (htmlBasePath) {
        var parts = htmlBasePath.split('/');
        parts.pop();
        var srcParts = src.split('/');
        for (var p of srcParts) {
          if (p === '..') parts.pop();
          else if (p !== '.') parts.push(p);
        }
        return parts.join('/');
      }
      return src;
    }

    const eocdOff = findEocd(data);
    let cdCount, cdOff, isZip64 = false;

    if (eocdOff >= 0) {
      cdCount = data.readUInt16LE(eocdOff + 10);
      cdOff = data.readUInt32LE(eocdOff + 16);
      if (cdOff === 0xFFFFFFFF || cdCount === 0xFFFF) {
        if (eocdOff >= 20) {
          const z64LocOff = data.readUInt32LE(eocdOff - 20);
          if (z64LocOff + 56 <= data.length && data.readUInt32LE(z64LocOff) === 0x07064b50) {
            const z64EocdOff = readUInt64LE(data, z64LocOff + 8);
            if (z64EocdOff + 56 <= data.length && data.readUInt32LE(z64EocdOff) === 0x06064b50) {
              isZip64 = true;
              cdCount = readUInt64LE(data, z64EocdOff + 24);
              cdOff = readUInt64LE(data, z64EocdOff + 40);
            }
          }
        }
      }
    }

    if (eocdOff >= 0) {
      let cp = cdOff;
      // 第一遍：提取所有图片到imgMap
      for (let ci = 0; ci < cdCount && cp + 46 <= data.length; ci++) {
        if (data.readUInt32LE(cp) !== 0x02014b50) break;
        let cdMethod = data.readUInt16LE(cp + 10);
        let cdCSize = data.readUInt32LE(cp + 20);
        let cdNLen = data.readUInt16LE(cp + 28);
        let cdELen = data.readUInt16LE(cp + 30);
        let cdCLen = data.readUInt16LE(cp + 32);
        let localOff = data.readUInt32LE(cp + 42);
        let cdName = data.slice(cp + 46, cp + 46 + cdNLen).toString('utf8');
        if (isZip64 && (cdCSize === 0xFFFFFFFF || localOff === 0xFFFFFFFF)) {
          let ep = cp + 46 + cdNLen;
          if (cdCSize === 0xFFFFFFFF) { cdCSize = readUInt64LE(data, ep); ep += 8; }
          if (localOff === 0xFFFFFFFF) { localOff = readUInt64LE(data, ep); ep += 8; }
        }
        var ext = path.extname(cdName).toLowerCase();
        if (imgExts[ext] && cdCSize > 0 && localOff + 30 <= data.length) {
          try {
            var imgData = extractFile(data, localOff, cdCSize, cdMethod);
            if (imgData && imgData.length < 500000) {
              imgMap[cdName] = 'data:' + imgExts[ext] + ';base64,' + imgData.toString('base64');
            }
          } catch(e4) {}
        }
        cp += 46 + cdNLen + cdELen + cdCLen;
      }
      // 第二遍：提取HTML
      cp = cdOff;
      for (let ci = 0; ci < cdCount && cp + 46 <= data.length; ci++) {
        if (data.readUInt32LE(cp) !== 0x02014b50) break;
        let cdMethod = data.readUInt16LE(cp + 10);
        let cdCSize = data.readUInt32LE(cp + 20);
        let cdNLen = data.readUInt16LE(cp + 28);
        let cdELen = data.readUInt16LE(cp + 30);
        let cdCLen = data.readUInt16LE(cp + 32);
        let localOff = data.readUInt32LE(cp + 42);
        let cdName = data.slice(cp + 46, cp + 46 + cdNLen).toString('utf8');
        if (isZip64 && (cdCSize === 0xFFFFFFFF || localOff === 0xFFFFFFFF)) {
          let ep = cp + 46 + cdNLen;
          if (cdCSize === 0xFFFFFFFF) { cdCSize = readUInt64LE(data, ep); ep += 8; }
          if (localOff === 0xFFFFFFFF) { localOff = readUInt64LE(data, ep); ep += 8; }
        }
        if (/\.x?html?$/i.test(cdName)) {
          htmlCount++;
          if (cdCSize > 0 && localOff + 30 <= data.length) {
            try {
              htmlBasePath = cdName;
              let raw = extractFile(data, localOff, cdCSize, cdMethod).toString('utf8');
              let txt = processHtml(raw);
              if (txt.length > 5) texts.push(txt);
            } catch(e2) {
              errors.push(cdName + ': ' + e2.message);
            }
          }
        }
        cp += 46 + cdNLen + cdELen + cdCLen;
      }
    } else {
      // 第一遍：收集所有条目信息并提取图片
      let pos = 0;
      const entries = [];
      while (pos < data.length - 4) {
        if (data.readUInt32LE(pos) !== 0x04034b50) break;
        const nLen = data.readUInt16LE(pos + 26);
        const eLen = data.readUInt16LE(pos + 28);
        const method = data.readUInt16LE(pos + 8);
        const flags = data.readUInt16LE(pos + 6);
        let cSize = data.readUInt32LE(pos + 18);
        const name = data.slice(pos + 30, pos + 30 + nLen).toString('utf8');
        const dStart = pos + 30 + nLen + eLen;
        if (cSize === 0 && (flags & 0x08)) {
          for (let si = dStart; si < data.length - 4; si++) {
            const sig = data.readUInt32LE(si);
            if (sig === 0x04034b50 || sig === 0x02014b50) { cSize = si - dStart; break; }
          }
        }
        entries.push({name, method, cSize, dStart});
        // 提取图片
        var ext2 = path.extname(name).toLowerCase();
        if (imgExts[ext2] && cSize > 0) {
          try {
            var imgData2 = method === 8 ? zlib.inflateRawSync(data.slice(dStart, dStart + cSize)) : data.slice(dStart, dStart + cSize);
            if (imgData2 && imgData2.length < 500000) {
              imgMap[name] = 'data:' + imgExts[ext2] + ';base64,' + imgData2.toString('base64');
            }
          } catch(e5) {}
        }
        pos = dStart + (cSize > 0 ? cSize : 0);
      }
      // 第二遍：处理HTML
      for (const ent of entries) {
        if (/\.x?html?$/i.test(ent.name) && ent.cSize > 0) {
          htmlCount++;
          try {
            htmlBasePath = ent.name;
            let raw = ent.method === 8 ? zlib.inflateRawSync(data.slice(ent.dStart, ent.dStart + ent.cSize)).toString('utf8') : data.slice(ent.dStart, ent.dStart + ent.cSize).toString('utf8');
            let txt = processHtml(raw);
            if (txt.length > 5) texts.push(txt);
          } catch(e3) {
            errors.push(ent.name + ': ' + e3.message);
          }
        }
      }
    }

    var full = texts.length > 0 ? texts.join('\n\n') : '';
    if (full.length > 2000000) full = full.substring(0, 2000000) + '\n\n... (内容过长已截断)';

    var result = {
      ok: texts.length > 0,
      text: full,
      htmlCount: htmlCount,
      zipType: eocdOff >= 0 ? (isZip64 ? 'ZIP64' : '标准ZIP') : '本地文件头模式',
      errorCount: errors.length,
      errors: errors.slice(0, 5)
    };
    if (texts.length === 0) {
      result.error = '无法解析此EPUB文件（扫描到' + htmlCount + '个HTML文件，' + errors.length + '个错误）';
    }
    return send(res, 200, JSON.stringify(result), 'application/json');
  } catch(e) {
    return send(res, 200, JSON.stringify({ok:false,error:'解析失败: '+e.message}), 'application/json');
  }
  
}

// ========== 歌词解析（从 createServer 回调拆出，隔离 V8 TurboFan 对二进制操作的优化）==========
function handleFilesLyrics(req, res, u) {

  const fp = u.searchParams.get('path') || '';
  const name = u.searchParams.get('name') || '';
  if (!fp) return send(res, 200, JSON.stringify({ok:false}), 'application/json');
  var https = require('https'); var http = require('http');
  function tryResult(lyrics, source) {
    if (lyrics && lyrics.trim()) return send(res, 200, JSON.stringify({ok:true, lyrics:lyrics, source:source}), 'application/json');
    sendOnline();
  }
  function sendOnline() {
    var rawName = (name || path.basename(fp, path.extname(fp))).replace(/\.[^.]+$/,'').trim();
    var parts = rawName.split(/\s*-\s*/);
    var artist = parts.length > 1 ? parts[0].trim() : '';
    var title = parts.length > 1 ? parts.slice(1).join('-').trim() : rawName;
    title = title.replace(/\[.*?\]|\(.*?\)/g,'').trim();
    artist = artist.replace(/\[.*?\]|\(.*?\)/g,'').trim();
    if (!title) { send(res, 200, JSON.stringify({ok:false}), 'application/json'); return; }
    var keyword = encodeURIComponent((artist ? artist+' ' : '') + title);
    var surl = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + keyword + '&format=json&p=1&n=1';
    var sreq = https.get(surl, {headers:{'User-Agent':'Mozilla/5.0'}, timeout:5000}, function(sres) {
      var sbody = '';
      sres.on('data', function(c) { sbody += c; });
      sres.on('end', function() {
        try {
          var sj = JSON.parse(sbody);
          var songs = (sj.data && sj.data.song && sj.data.song.list) || [];
          if (!songs.length) { send(res, 200, JSON.stringify({ok:false}), 'application/json'); return; }
          var songmid = songs[0].songmid;
          var lurl = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + songmid + '&format=json&nobase64=1';
          var lreq = https.get(lurl, {headers:{'User-Agent':'Mozilla/5.0','Referer':'https://y.qq.com/'}, timeout:5000}, function(lres) {
            var lbody = '';
            lres.on('data', function(c) { lbody += c; });
            lres.on('end', function() {
              try {
                var lj = JSON.parse(lbody);
                if (lj.lyric) return send(res, 200, JSON.stringify({ok:true, lyrics:lj.lyric, source:'online'}), 'application/json');
                send(res, 200, JSON.stringify({ok:false}), 'application/json');
              } catch(e3) { send(res, 200, JSON.stringify({ok:false}), 'application/json'); }
            });
          });
          lreq.on('error', function() { send(res, 200, JSON.stringify({ok:false}), 'application/json'); });
          lreq.setTimeout(5000, function() { lreq.destroy(); send(res, 200, JSON.stringify({ok:false}), 'application/json'); });
        } catch(e2) { send(res, 200, JSON.stringify({ok:false}), 'application/json'); }
      });
    });
    sreq.on('error', function() { send(res, 200, JSON.stringify({ok:false}), 'application/json'); });
    sreq.setTimeout(5000, function() { sreq.destroy(); send(res, 200, JSON.stringify({ok:false}), 'application/json'); });
  }
  // 1. 同名.lrc文件
  try {
    var baseName = path.basename(fp, path.extname(fp));
    var dirName = path.dirname(fp);
    var lrcPath = path.join(dirName, '\u6b4c\u8bcd', baseName + '.lrc');
    if (!fs.existsSync(lrcPath)) lrcPath = fp.replace(/\.[^.]+$/, '.lrc');
    if (fs.existsSync(lrcPath)) {
      var lrcContent = fs.readFileSync(lrcPath, 'utf8');
      if (lrcContent && lrcContent.trim()) return send(res, 200, JSON.stringify({ok:true, lyrics:lrcContent, source:'lrc'}), 'application/json');
    }
  } catch(e) {}
  // 2. 内嵌歌词(ID3)
  try {
    var buf = fs.readFileSync(fp);
    if (buf.length > 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
      var pos = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
      var endPos = Math.min(pos + 1024 * 1024, buf.length);
      var p = 10;
      while (p + 10 < endPos) {
        var fid = buf.toString('latin1', p, p + 4);
        if (fid === '\x00\x00\x00\x00' || fid.charCodeAt(0) === 0) break;
        var fSize = buf.readUInt32BE(p + 4);
        if (fSize <= 0 || p + 10 + fSize > endPos) break;
        var fFlag = buf.readUInt16BE(p + 8);
        var fData = buf.slice(p + 10, p + 10 + fSize);
        if (fid === 'USLT' || fid === 'SYLT') {
          try {
            var enc = fData[0];
            var lang = fData.toString('latin1', 1, 4);
            var descEnd = fData.indexOf(0x00, 4);
            var textStart = descEnd >= 0 ? descEnd + 1 : 4;
            if (textStart >= fData.length) textStart = 4;
            var lyricText = '';
            if (enc === 0) {
              lyricText = fData.toString('latin1', textStart);
            } else if (enc === 1) {
              var bom = fData.readUInt16BE(textStart);
              if (bom === 0xFEFF || bom === 0xFFFE) {
                lyricText = fData.toString('utf16le', textStart + 2);
              } else {
                lyricText = fData.toString('utf16le', textStart);
              }
            } else if (enc === 2 || enc === 3) {
              lyricText = fData.toString('utf8', textStart);
            } else {
              lyricText = fData.toString('latin1', textStart);
            }
            if (lyricText && lyricText.trim()) return send(res, 200, JSON.stringify({ok:true, lyrics:lyricText, source:'embedded'}), 'application/json');
          } catch(e2) {}
        }
        p += 10 + fSize;
      }
    }
  } catch(e) {}
  // 3. 在线API
  sendOnline();
  return;
  
}

// ========== 文件管理器 ==========
function fileManagerHtml(startPath) {
  var safePath = startPath || '/sdcard/Download/';
  var html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">';
  html += '<title>文件管理</title><style>';
  html += 'html,body{background:#0a0e1a!important;min-height:100vh;margin:0;padding:0;color:#fff;font-family:-apple-system,sans-serif}';
  html += '*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}';
  html += '.topbar{display:flex;align-items:center;gap:10px;padding:10px 12px;position:sticky;top:0;z-index:20;background:#0a0e1a}';
  html += '.nbtn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0}';
  html += '.nbtn:active{background:rgba(255,255,255,.25)}';
  html += '.path-bar{flex:1;min-width:0;font-size:13px;color:rgba(255,255,255,.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px 12px}';
  html += '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:8px 12px}';
  html += '.item{background:rgba(255,255,255,.06);border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.1);cursor:pointer;transition:transform .15s}';
  html += '.item:active{transform:scale(.96)}';
  html += '.item-icon{width:100%;aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:48px;background:rgba(255,255,255,.03)}';
  html += '.item-icon img{width:100%;height:100%;object-fit:cover}';
  html += '.item-name{padding:6px 8px;font-size:11px;color:rgba(255,255,255,.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}';
  html += '.item-meta{padding:0 8px 6px;font-size:9px;color:rgba(255,255,255,.4);text-align:center}';
  html += '.tip{text-align:center;padding:40px;color:rgba(255,255,255,.5);font-size:14px}';
  html += '.player-overlay{position:fixed;inset:0;z-index:100;background:#000;display:none;flex-direction:column}';
  html += '.player-overlay.show{display:flex}';
  html += '.player-topbar{height:44px;display:flex;align-items:center;padding:0 10px;background:rgba(0,0,0,.8);flex-shrink:0;transition:opacity .3s,height .3s,padding .3s;opacity:1;overflow:hidden}';
  html += '.player-topbar.hide{opacity:0;height:0;padding:0;pointer-events:none}';
  html += '.player-topbar button{background:rgba(255,255,255,.15);border:0;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:18px}';
  html += '.player-topbar .ptitle{flex:1;text-align:center;color:#fff;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 10px}';
  html += '.player-wrap{flex:1;display:block;background:#000;position:relative;overflow:hidden}';
  html += '.player-wrap video,.player-wrap img,.player-wrap embed,.player-wrap iframe{max-width:100%;max-height:100%;object-fit:contain}';
  html += '.info-panel{position:fixed;bottom:0;left:0;right:0;z-index:100;background:rgba(18,18,28,.97);border-radius:16px 16px 0 0;padding:20px 16px;transform:translateY(100%);transition:transform .3s;max-height:60vh;overflow-y:auto}';
  html += '.info-panel.show{transform:translateY(0)}';
  html += '.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:90;display:none}';
  html += '.backdrop.show{display:block}';
  html += '.info-title{font-size:16px;font-weight:700;color:#fff;margin-bottom:12px}';
  html += '.info-row{display:flex;padding:6px 0;font-size:13px;border-bottom:1px solid rgba(255,255,255,.05)}';
  html += '.info-label{color:rgba(255,255,255,.5);width:70px;flex-shrink:0}';
  html += '.info-val{color:rgba(255,255,255,.85);flex:1;word-break:break-all}';
  html += '.info-actions{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}';
  html += '.info-btn{padding:10px 20px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font-size:14px;cursor:pointer;flex:1;text-align:center}';
  html += '.info-btn:active{background:rgba(255,255,255,.15)}';
  html += '.info-btn.play{background:rgba(79,195,247,.25);border-color:rgba(79,195,247,.5);color:#4fc3f7}';
  html += '.reader-settings{position:absolute;top:44px;right:0;background:rgba(20,20,30,.98);border-radius:0 0 12px 12px;padding:14px;min-width:220px;max-height:70vh;overflow-y:auto;z-index:101;display:none;box-shadow:0 4px 20px rgba(0,0,0,.5)}';
  html += '.reader-settings.show{display:block}';
  html += '.reader-settings .rs-title{color:rgba(255,255,255,.5);font-size:11px;margin:8px 0 4px;text-transform:uppercase}';
  html += '.reader-settings .rs-row{display:flex;gap:8px;align-items:center;margin-bottom:8px}';
  html += '.reader-settings .rs-btn{flex:1;padding:8px 0;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font-size:13px;cursor:pointer;text-align:center}';
  html += '.reader-settings .rs-btn:active{background:rgba(255,255,255,.18)}';
  html += '.reader-settings .rs-btn.active{background:rgba(79,195,247,.3);border-color:rgba(79,195,247,.6)}';
  html += '.reader-settings input[type=number]{width:100%;padding:7px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font-size:13px;margin-bottom:8px}';
  html += '.reader-settings input[type=text]{width:100%;padding:7px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font-size:13px;margin-bottom:8px}';
  html += '.reader-settings .rs-label{color:rgba(255,255,255,.6);font-size:12px;margin-bottom:4px;display:block}';
  html += '.hl{background:#ffeb3b;color:#000;padding:1px 2px;border-radius:3px}';
  html += '.reader-bar{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:#12121e;border-top:1px solid rgba(255,255,255,.1);flex-shrink:0;transition:opacity .3s,height .3s,padding .3s;opacity:1;overflow:hidden;height:auto}';
  html += '.reader-bar.hide{opacity:0;height:0;padding:0;pointer-events:none}';
  html += '.fm-vinyl{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1a1a1a;overflow:hidden}';
  html += '.fm-vinyl-player{position:relative;width:300px;height:300px;border-radius:50%;box-shadow:0 20px 60px rgba(0,0,0,0.8);background:#0a0a0a;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;transition:box-shadow .3s}';
  html += '.fm-vinyl-player::before{content:\'\';position:absolute;top:0;left:0;width:100%;height:100%;border-radius:50%;border:2px solid #000;pointer-events:none;z-index:5;box-sizing:border-box}';
  html += '.fm-vinyl-disc{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:50%;will-change:transform;z-index:1}';
  html += '.fm-vinyl-base{width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 50% 50%,#2b2b2b 0%,#1f1f1f 22%,#111 24%,#222 26%,#1a1a1a 30%,#0e0e0e 100%),repeating-radial-gradient(circle at 50% 50%,rgba(255,255,255,0.02) 0px,rgba(255,255,255,0.02) 2px,rgba(0,0,0,0.05) 2px,rgba(0,0,0,0.05) 4px);background-blend-mode:overlay,normal;position:relative}';
  html += '.fm-vinyl-cover{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:62%;height:62%;border-radius:50%;box-shadow:0 0 0 3px #333,0 0 0 6px #111,0 8px 25px rgba(0,0,0,0.8);overflow:hidden;background:#222;z-index:2;display:flex;align-items:center;justify-content:center}';
  html += '.fm-vinyl-cover svg{display:block;width:100%;height:100%}';
  html += '.fm-vinyl-hole{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:6%;height:6%;border-radius:50%;background:radial-gradient(circle at 40% 35%,#555,#111);box-shadow:inset 0 2px 4px rgba(255,255,255,0.2),0 0 6px rgba(0,0,0,0.9);z-index:3}';
  html += '.fm-vinyl-shine{position:absolute;top:-5%;left:-5%;width:110%;height:110%;border-radius:50%;background:radial-gradient(circle at 30% 30%,rgba(255,255,255,0.35),transparent 90%);pointer-events:none;mix-blend-mode:overlay;z-index:1}';
  html += '.fm-vinyl-tonearm{position:absolute;top:-20px;right:-20px;width:160px;height:160px;z-index:20;pointer-events:none;transform:rotate(25deg);transform-origin:85% 15%;transition:transform .6s cubic-bezier(0.34,1.56,0.64,1)}';
  html += '.fm-vinyl-tonearm img{display:block;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.3))}';
  html += '.fm-vinyl-player.playing .fm-vinyl-tonearm{transform:rotate(16deg)}';
  html += '.fm-vinyl-player.paused .fm-vinyl-tonearm{transform:rotate(32deg)}';
  html += '.fm-vinyl-spin{animation:fmVinylSpin 18s linear infinite}';
  html += '@keyframes fmVinylSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
  html += '.fm-vinyl-playmask{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:50%;z-index:30;display:flex;justify-content:center;align-items:center;background:transparent}';
  html += '.fm-vinyl-playbtn{width:64px;height:64px;border-radius:50%;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);display:flex;justify-content:center;align-items:center;box-shadow:0 0 0 2px rgba(255,255,255,0.15),0 8px 25px rgba(0,0,0,0.6);transition:transform .2s,background .2s;pointer-events:auto;border:none;outline:none;cursor:pointer}';
  html += '.fm-vinyl-playbtn:active{transform:scale(.92)}';
  html += '.fm-vinyl-playbtn svg{width:32px;height:32px;fill:white;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.4))}';
  html += '.fm-vinyl-info{margin-top:28px;text-align:center;color:#898a87;z-index:10}';
  html += '.fm-vinyl-info .title{font-size:17px;font-weight:600;letter-spacing:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}';
  html += '.fm-vinyl-info .artist{font-size:13px;color:#999;margin-top:4px}';
  html += '.fm-audio-bar{position:absolute;bottom:0;left:0;right:0;padding:12px 16px 16px;background:linear-gradient(0deg,rgba(0,0,0,.9) 0%,rgba(0,0,0,.5) 70%,transparent 100%);z-index:50;transition:opacity .3s,transform .3s}';
  html += '.fm-audio-bar.hide{opacity:0;transform:translateY(100%);pointer-events:none}';
  html += '.fm-audio-times{display:flex;justify-content:space-between;color:rgba(255,255,255,.6);font-size:11px;margin-bottom:6px;font-variant-numeric:tabular-nums}';
  html += '.fm-audio-progress{height:24px;display:flex;align-items:center;cursor:pointer;position:relative;touch-action:none}';
  html += '.fm-audio-track{width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,.15);position:relative;overflow:hidden}';
  html += '.fm-audio-buffer{position:absolute;left:0;top:0;height:100%;background:rgba(255,255,255,.2);border-radius:2px;transition:width .3s}';
  html += '.fm-audio-fill{position:absolute;left:0;top:0;height:100%;background:#4fc3f7;border-radius:2px;transition:width .1s linear}';
  html += '.fm-audio-thumb{position:absolute;top:50%;width:12px;height:12px;border-radius:50%;background:#4fc3f7;transform:translate(-50%,-50%);box-shadow:0 0 6px rgba(79,195,247,.5);opacity:0;transition:opacity .15s}';
  html += '.fm-audio-progress:active .fm-audio-thumb{opacity:1}';
  html += '.fm-ctrls{display:flex;align-items:center;justify-content:center;gap:28px;margin-top:10px}';
  html += '.fm-ctrl{background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;padding:6px;display:flex;align-items:center;justify-content:center;transition:color .2s,transform .15s;-webkit-tap-highlight-color:transparent}';
  html += '.fm-ctrl:active{transform:scale(.88)}';
  html += '.fm-ctrl svg{width:24px;height:24px;fill:currentColor}';
  html += '.fm-ctrl.on{color:#4fc3f7}';
  html += '.fm-ctrl-play svg{width:32px;height:32px}';
  html += '.fm-playlist{position:absolute;bottom:0;left:0;right:0;max-height:50vh;overflow-y:auto;background:rgba(20,20,28,.97);backdrop-filter:blur(20px);z-index:60;border-radius:16px 16px 0 0;transform:translateY(100%);transition:transform .3s ease;padding:8px 0 20px}';
  html += '.fm-playlist.show{transform:translateY(0)}';
  html += '.fm-pl-header{display:flex;align-items:center;justify-content:space-between;padding:12px 20px 8px;border-bottom:1px solid rgba(255,255,255,.08)}';
  html += '.fm-pl-title{font-size:15px;font-weight:700;color:#fff}';
  html += '.fm-pl-close{background:none;border:none;color:rgba(255,255,255,.6);font-size:20px;cursor:pointer;padding:4px 8px}';
  html += '.fm-pl-item{display:flex;align-items:center;gap:10px;padding:10px 20px;cursor:pointer;transition:background .15s}';
  html += '.fm-pl-item:active{background:rgba(255,255,255,.08)}';
  html += '.fm-pl-item.active{background:rgba(79,195,247,.12)}';
  html += '.fm-pl-item.active .fm-pl-name{color:#4fc3f7}';
  html += '.fm-pl-idx{width:24px;text-align:center;font-size:12px;color:rgba(255,255,255,.4);flex-shrink:0}';
  html += '.fm-pl-item.active .fm-pl-idx{color:#4fc3f7}';
  html += '.fm-pl-name{font-size:13px;color:rgba(255,255,255,.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}';
  html += '.fm-pl-mask{position:absolute;inset:0;background:rgba(0,0,0,.5);z-index:55;display:none}';
  html += '.fm-pl-mask.show{display:block}';
  html += '.fm-vinyl-stage{display:flex;flex-direction:column;align-items:center;flex-shrink:0}';
  html += '.fm-lyrics{display:none;flex-direction:column;align-items:center;gap:6px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:10px 16px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}';
  html += '.fm-lyrics::-webkit-scrollbar{width:3px}';
  html += '.fm-lyrics::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:2px}';
  html += '.fm-lyrics::-webkit-scrollbar-track{background:transparent}';
  html += '.fm-lyric-line{color:rgba(255,255,255,.3);font-size:13px;line-height:2;text-align:center;transition:color .3s ease,font-size .3s ease,transform .3s ease;cursor:pointer;padding:2px 12px;max-width:100%;word-break:break-word}';
  html += '.fm-lyric-line.active{color:#4fc3f7;font-size:15px;font-weight:600;transform:scale(1.06);text-shadow:0 0 10px rgba(79,195,247,.3)}';
  html += '.fm-lyric-line:active{color:rgba(255,255,255,.6)}.fm-lrc-offset{display:flex;align-items:center;gap:4px;margin-left:auto}.fm-offset-btn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.7);padding:2px 8px;border-radius:10px;font-size:10px;cursor:pointer}.fm-offset-btn:active{background:rgba(79,195,247,.3);color:#4fc3f7}.fm-offset-val{color:#4fc3f7;font-size:10px;min-width:28px;text-align:center}';
  html += '.fm-vinyl.has-lyrics{overflow:hidden;justify-content:flex-start;padding-top:50px;padding-bottom:10px}';
  html += '.fm-vinyl.has-lyrics .fm-vinyl-stage{position:static;transform:none;flex-shrink:0}';
  html += '.fm-vinyl.has-lyrics .fm-vinyl-player{width:200px;height:200px}';
  html += '.fm-vinyl.has-lyrics .fm-vinyl-tonearm{width:95px;height:95px;top:-10px;right:-10px}';
  html += '.fm-vinyl.has-lyrics .fm-vinyl-playbtn{width:48px;height:48px}';
  html += '.fm-vinyl.has-lyrics .fm-vinyl-playbtn svg{width:24px;height:24px}';
  html += '.fm-vinyl.has-lyrics .fm-vinyl-info{position:static;transform:none;margin-top:16px}';
  html += '.fm-vinyl.has-lyrics .fm-vinyl-info .title{font-size:14px;max-width:220px}';
  html += '.fm-vinyl.has-lyrics .fm-lyrics{display:flex;flex:1;width:100%;max-width:460px;margin:16px auto 10px;position:relative;min-height:0}';
  html += '@media(orientation:landscape){.fm-vinyl.has-lyrics{flex-direction:row;justify-content:center;align-items:center;gap:24px;padding:40px 24px 80px 60px}.fm-vinyl.has-lyrics .fm-vinyl-stage{margin-bottom:0}.fm-vinyl.has-lyrics .fm-vinyl-info{margin-top:39px}.fm-vinyl.has-lyrics .fm-vinyl-player{width:220px;height:220px}.fm-vinyl.has-lyrics .fm-vinyl-tonearm{width:115px;height:115px;top:-12px;right:-12px}.fm-vinyl.has-lyrics .fm-lyrics{flex:1;max-width:50%;max-height:75vh;align-self:stretch;justify-content:flex-start;margin:0;position:relative;min-height:0}}';
  html += '@media(orientation:landscape) and (max-height:400px){.fm-vinyl.has-lyrics .fm-vinyl-player{width:200px;height:200px}.fm-vinyl.has-lyrics .fm-vinyl-tonearm{width:85px;height:85px;top:-8px;right:-8px}}';
  html += '@media(max-width:440px){.fm-vinyl-player{width:250px;height:250px}.fm-vinyl-tonearm{width:130px;height:130px;top:-15px;right:-15px}.fm-vinyl-playbtn{width:54px;height:54px}.fm-vinyl-playbtn svg{width:26px;height:26px}}';
  html += '</style></head><body>';
  html += '<div class="topbar"><button class="nbtn" id="backBtn">\u2190</button><div class="path-bar" id="pathBar">' + safePath + '</div></div>';
  html += '<div id="content"><div class="tip">加载中...</div></div>';
  html += '<div class="backdrop" id="backdrop"></div><div class="info-panel" id="infoPanel"></div>';
  html += '<div class="player-overlay" id="playerOverlay"><div class="player-topbar"><button onclick="closePlayer()">\u2190</button><div class="ptitle" id="playerTitle"></div><button onclick="toggleSettings()" style="background:rgba(255,255,255,.15);border:0;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:16px">\u2699</button><button onclick="toggleFs()" style="background:rgba(255,255,255,.15);border:0;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:14px;margin-left:4px">\u26F6</button><button onclick="toggleRotate()" style="background:rgba(255,255,255,.15);border:0;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:14px;margin-left:4px">\u21BB</button></div><div class="reader-settings" id="readerSettings"><div class="rs-title">字体大小</div><div class="rs-row"><button class="rs-btn" onclick="adjustFontSize(-2)">A- \u7F29\u5C0F</button><span id="fontSizeVal" style="color:#fff;font-size:13px;width:40px;text-align:center">16</span><button class="rs-btn" onclick="adjustFontSize(2)">A+ \u653E\u5927</button></div><div class="rs-title">主题</div><div class="rs-row"><button class="rs-btn" id="themeDark" onclick="setTheme(0)">\u9ED1\u8272</button><button class="rs-btn" id="themeLight" onclick="setTheme(1)">\u4EAE\u8272</button><button class="rs-btn" id="themeNight" onclick="setTheme(2)">\u591C\u95F4</button></div><div class="rs-title">进度跳转</div><input type="number" id="progressInput" min="0" max="100" placeholder="0-100%" onchange="jumpToProgress(this.value)"><div class="rs-title">网络文件</div><input type="text" id="webFileUrl" placeholder="输入文本/JSON/MD等URL" style="width:100%;padding:7px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font-size:13px;margin-bottom:8px"><button class="rs-btn" onclick="loadWebFile()" style="width:100%;margin-bottom:8px">\u52A0\u8F7D\u7F51\u7EDC\u6587\u672C</button><div class="rs-title">搜索</div><div style="display:flex;gap:6px"><input type="text" id="searchInput" placeholder="输入关键词" style="flex:1;padding:8px 12px 8px 32px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font-size:13px;outline:none;background-image:url(data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20fill%3D%22rgba(255%2C255%255%2C0.4)%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22M11.742%2010.344a6.5%206.5%200%201%200-1.397%201.398h-.001l3.85%203.85a1%201%200%200%200%201.415-1.414l-3.85-3.85zm-5.242.156a5%205%200%201%201%200-10%205%205%200%200%201%200%2010z%22%2F%3E%3C%2Fsvg%3E);background-repeat:no-repeat;background-position:10px center" oninput="searchInContent(this.value)" onkeydown="if(event.key===\x27Enter\x27)searchInContent(this.value)"></div><div class="rs-title">背景图片</div><div class="rs-row"><button class="rs-btn" onclick="setBgImage(\x27\x27)">默认</button><button class="rs-btn" onclick="setBgImage(\x27local\x27)">本地图片</button><button class="rs-btn" onclick="setBgImage(\x27url\x27)">网络图片</button></div><div class="rs-title">背景透明度</div><div class="rs-row" style="align-items:center;gap:8px"><input type="range" id="bgOpacity" min="0" max="100" value="30" style="flex:1;accent-color:#4fc3f7" oninput="setBgOpacity(this.value)"><span id="bgOpacityVal" style="color:#fff;font-size:12px;min-width:35px;text-align:right">30%</span></div><div class="rs-title">明暗度</div><div class="rs-row" style="align-items:center;gap:8px"><input type="range" id="bgBrightness" min="20" max="150" value="100" style="flex:1;accent-color:#4fc3f7" oninput="setBrightness(this.value)"><span id="brightnessVal" style="color:#fff;font-size:12px;min-width:35px;text-align:right">100%</span></div></div><div class="player-wrap" id="playerWrap"></div></div>';
  html += '<script>';
  html += 'var curPath="' + safePath + '";';
  html += 'var _isHiker=window.parent!==window;';
  html += 'function el(s){return document.querySelector(s)}';
  html += 'function fmtSize(b){if(!b)return"";if(b<1024)return b+"B";if(b<1048576)return(b/1024).toFixed(1)+"KB";if(b<1073741824)return(b/1048576).toFixed(1)+"MB";return(b/1073741824).toFixed(2)+"GB"}';
  html += 'function getIcon(it){if(it.isDir)return"\uD83D\uDCC1";var n=it.name.toLowerCase();';
  html += 'if(/\\.(mp4|mkv|avi|mov|flv|ts|webm|m4v)$/.test(n))return"\uD83C\uDFAC";';
  html += 'if(/\\.(mp3|wav|flac|aac|ogg|m4a)$/.test(n))return"\uD83C\uDFB5";';
  html += 'if(/\\.(jpg|jpeg|png|gif|webp|bmp)$/.test(n))return"\uD83D\uDDBC\uFE0F";';
  html += 'if(/\\.(zip|rar|7z|tar|gz)$/.test(n))return"\uD83D\uDCE6";';
  html += 'if(/\\.pdf$/i.test(n))return"\uD83D\uDCD5";';
  html += 'if(/\\.(epub|mobi)$/i.test(n))return"\uD83D\uDCD6";';
  html += 'if(/\\.(txt|md|json|xml|csv|log|srt|ass)$/i.test(n))return"\uD83D\uDCD6";';
  html += 'return"\uD83D\uDCCE"}';
  html += 'function isMedia(n){return /\\.(mp4|mkv|avi|mov|flv|ts|webm|m4v|mp3|wav|flac|aac|ogg|m4a)$/i.test(n)}';
  html += 'function isImage(n){return /\\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(n)}';
  html += 'function isPdf(n){return /\\.pdf$/i.test(n)}';
  html += 'function isText(n){return /\\.(txt|md|json|xml|csv|log|srt|ass|vtt|html|htm)$/i.test(n)};function isEpub(n){return /\\.epub$/i.test(n)}';
  html += 'function render(items){';
  html += 'var c=el("#content");var h="<div class=\\"grid\\">";';
  html += 'items.forEach(function(it,i){var icon=getIcon(it);';
  html += 'var thumb=it.thumb?"<img src=\\""+it.thumb+"\\" loading=\\"lazy\\" onerror=\\"this.style.display=\\x27none\\x27\\">":icon;';
  html += 'h+="<div class=\\"item\\" onclick=\\"onItem("+i+")\\"><div class=\\"item-icon\\">"+thumb+"</div><div class=\\"item-name\\">"+it.name+"</div><div class=\\"item-meta\\">"+(it.isDir?"\u6587\u4EF6\u5939":fmtSize(it.size))+"</div></div>";});';
  html += 'h+="</div>";c.innerHTML=h;window._items=items;}';
  html += 'function onItem(i){var it=window._items[i];if(!it)return;if(it.isDir){loadDir(it.path);window.scrollTo(0,0);return}showInfo(it)}';
  html += 'function showInfo(it){var p=el("#infoPanel");var h="<div class=\\"info-title\\">"+it.name+"</div>";';
  html += 'h+="<div class=\\"info-row\\"><div class=\\"info-label\\\">\u8DEF\u5F84</div><div class=\\"info-val\\">"+it.path+"</div></div>";';
  html += 'h+="<div class=\\"info-row\\"><div class=\\"info-label\\\">\u5927\u5C0F</div><div class=\\"info-val\\">"+fmtSize(it.size)+"</div></div>";';
  html += 'h+="<div class=\\"info-actions\\">";';
  html += 'if(isMedia(it.name))h+="<div class=\\"info-btn play\\" onclick=\\"playMedia("+window._items.indexOf(it)+")\\\">\u25B6 \u64AD\u653E</div>";';
  html += 'if(isImage(it.name))h+="<div class=\\"info-btn play\\" onclick=\\"viewImage("+window._items.indexOf(it)+")\\\">\uD83D\uDDBC\uFE0F \u67E5\u770B</div>";';
  html += 'if(isPdf(it.name))h+="<div class=\\"info-btn play\\" onclick=\\"viewPdf("+window._items.indexOf(it)+")\\\">\uD83D\uDCC4 PDF</div>";';
  html += 'if(isText(it.name))h+="<div class=\\"info-btn play\\" onclick=\\"readText("+window._items.indexOf(it)+")\\\">\uD83D\uDCD6 \u9605\u8BFB</div>";if(isEpub(it.name))h+="<div class=\\"info-btn play\\" onclick=\\"openEpub("+window._items.indexOf(it)+")\\\">\uD83D\uDCD6 EPUB</div>";';
  html += 'h+="<div class=\\"info-btn\\" onclick=\\"closeInfo()\\\">\u5173\u95ED</div></div>";';
  html += 'p.innerHTML=h;el("#backdrop").classList.add("show");p.classList.add("show")}';
  html += 'function closeInfo(){el("#infoPanel").classList.remove("show");el("#backdrop").classList.remove("show")}';
  html += 'el("#backdrop").onclick=closeInfo;';
  html += 'var _poClickHandler=null;var _readerBarsHidden=true;var _vinylRaf=null;var _vinylSpinning=false;function _cleanupPlayerListeners(){if(_vinylSpinning){_vinylSpinning=false;if(_vinylRaf){cancelAnimationFrame(_vinylRaf);_vinylRaf=null}}var po=el("#playerOverlay");if(_poClickHandler&&po){po.removeEventListener("touchend",_poClickHandler);_poClickHandler=null}var wrap=el("#playerWrap");if(wrap){var nw=wrap.cloneNode(false);wrap.parentNode.replaceChild(nw,wrap);return nw}return wrap}';
  html += 'function _clearReaderGlobals(){window.textPrev=null;window.textNext=null;window.renderPage=null;window._textTotalPages=0;window._textCurPage=0;window.epubPrev=null;window.epubNext=null;window.renderEpubPage=null;window._epubTotalPages=0;window._epubCurPage=0;_lastSearchKw=""}';
  html += 'function _toggleReaderBars(){var _tb=el("#playerOverlay").querySelector(".player-topbar");var _bb=el("#textReaderBar")||el("#epubReaderBar");if(_tb){_tb.classList.toggle("hide")}if(_bb){_bb.classList.toggle("hide")}_readerBarsHidden=_tb?_tb.classList.contains("hide"):_readerBarsHidden}';
  html += 'function _hideReaderBars(){var _tb=el("#playerOverlay").querySelector(".player-topbar");var _bb=el("#textReaderBar")||el("#epubReaderBar");if(_tb)_tb.classList.add("hide");if(_bb)_bb.classList.add("hide");_readerBarsHidden=true}';
  html += 'function _showReaderBars(){var _tb=el("#playerOverlay").querySelector(".player-topbar");var _bb=el("#textReaderBar")||el("#epubReaderBar");if(_tb)_tb.classList.remove("hide");if(_bb)_bb.classList.remove("hide");_readerBarsHidden=false}';
  html += 'function _initLyrics(_audio,_lyricsEl,_vinylEl,_path,_name,_lrcOffObj){';
  html += '_audio._lrcGen=(_audio._lrcGen||0)+1;var _myGen=_audio._lrcGen;var _lrcLines=[];var _lrcActiveIdx=-1;';
  html += 'var _lxhr=new XMLHttpRequest();';
  html += '_lxhr.open("GET","/files-lyrics?path="+encodeURIComponent(_path)+"&name="+encodeURIComponent(_name),true);';
  html += '_lxhr.onreadystatechange=function(){if(_myGen!==_audio._lrcGen)return;if(_lxhr.readyState===4&&_lxhr.status===200){try{var _lj=JSON.parse(_lxhr.responseText);if(_lj.ok&&_lj.lyrics){var _lrcText=_lj.lyrics;_audio._rawLrc=_lrcText;_audio._songPath=_path;var _rawLines=_lrcText.replace(/\\r/g,"").split("\\n");_lrcLines=[];for(var i=0;i<_rawLines.length;i++){var _line=_rawLines[i].trim();if(!_line)continue;var _matches=_line.match(/\\[(\\d+):(\\d+)(?:\\.(\\d+))?\\]/g);if(_matches&&_matches.length>0){var _text=_line.replace(/\\[\\d+:\\d+(?:\\.\\d+)?\\]/g,"").trim();for(var j=0;j<_matches.length;j++){var _tm=_matches[j].match(/(\\d+):(\\d+)(?:\\.(\\d+))?/);if(_tm){var _time=parseInt(_tm[1])*60+parseInt(_tm[2])+(_tm[3]?parseInt(_tm[3].substring(0,3).padEnd(3,"0"))/1000:0);_lrcLines.push({time:_time,text:_text})}}}}_lrcLines.sort(function(a,b){return a.time-b.time});if(_lrcLines.length>0){var _lh="";for(var i=0;i<_lrcLines.length;i++){_lh+="<div class=\\"fm-lyric-line\\" data-idx=\\""+i+"\\">"+(_lrcLines[i].text||"\\u266A")+"</div>"}_lyricsEl.innerHTML=_lh;_lyricsEl.style.display=\x27flex\x27;_vinylEl.classList.add(\x27has-lyrics\x27);_lyricsEl.addEventListener("click",function(e){var _ln=e.target.closest(".fm-lyric-line");if(_ln&&_audio&&_audio.duration){var _di=parseInt(_ln.dataset.idx);if(_lrcLines[_di]){_audio.currentTime=_lrcLines[_di].time}}})}else if(_lrcText.trim()){var _plain=_lrcText.replace(/\\r/g,"").split("\\n").map(function(l){return"<div class=\\"fm-lyric-line\\" style=\\"color:rgba(255,255,255,.5)\\">"+(l.trim()||"\\u266A")+"</div>"}).join("");_lyricsEl.innerHTML=_plain;_lyricsEl.style.display=\x27flex\x27;_vinylEl.classList.add(\x27has-lyrics\x27)}}}catch(e){}}};';
  html += '_lxhr.send();';
  html += '_audio.addEventListener("timeupdate",function(){if(_myGen!==_audio._lrcGen)return;if(_lrcLines.length===0||!_lyricsEl)return;var _ct=_audio.currentTime+_lrcOffObj.v;var _ai=-1;for(var i=0;i<_lrcLines.length;i++){if(_lrcLines[i].time<=_ct)_ai=i;else break}if(_ai===_lrcActiveIdx)return;_lrcActiveIdx=_ai;var _ls=_lyricsEl.querySelectorAll(".fm-lyric-line");for(var k=0;k<_ls.length;k++){if(k===_ai)_ls[k].classList.add("active");else _ls[k].classList.remove("active")}if(_ai>=0&&_ls[_ai]){var _target=_ls[_ai];var _offset=_target.offsetTop-_lyricsEl.clientHeight/2+_target.offsetHeight/2;_lyricsEl.scrollTo({top:Math.max(0,_offset),behavior:"smooth"})}});';
  html += '}';
  html += 'function playMedia(idx){var it=window._items[idx];var url="/files-stream?path="+encodeURIComponent(it.path);el("#playerTitle").textContent=it.name;';
  html += 'var _fmTonearmUrl="data:image/svg+xml,%3Csvg%20xmlns%3D%27http://www.w3.org/2000/svg%27%20viewBox%3D%270%200%20160%20160%27%3E%3Cdefs%3E%3ClinearGradient%20id%3D%27a%27%20x1%3D%270%25%27%20y1%3D%270%25%27%20x2%3D%27100%25%27%20y2%3D%27100%25%27%3E%3Cstop%20offset%3D%270%25%27%20stop-color%3D%27%23d4d4d4%27/%3E%3Cstop%20offset%3D%2750%25%27%20stop-color%3D%27%23a0a0a0%27/%3E%3Cstop%20offset%3D%27100%25%27%20stop-color%3D%27%23707070%27/%3E%3C/linearGradient%3E%3CradialGradient%20id%3D%27b%27%20cx%3D%2740%25%27%20cy%3D%2730%25%27%20r%3D%2760%25%27%3E%3Cstop%20offset%3D%270%25%27%20stop-color%3D%27%23e8e8e8%27/%3E%3Cstop%20offset%3D%27100%25%27%20stop-color%3D%27%23888888%27/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle%20cx%3D%27135%27%20cy%3D%2720%27%20r%3D%2714%27%20fill%3D%27url(%23b)%27%20stroke%3D%27%23999%27%20stroke-width%3D%271%27/%3E%3Ccircle%20cx%3D%27135%27%20cy%3D%2720%27%20r%3D%276%27%20fill%3D%27%23fff%27%20opacity%3D%270.3%27/%3E%3Cpath%20d%3D%27M%20128%2028%20C%20110%2025,%2090%2045,%2075%2070%27%20stroke%3D%27url(%23a)%27%20stroke-width%3D%276%27%20fill%3D%27none%27%20stroke-linecap%3D%27round%27/%3E%3Cpath%20d%3D%27M%2070%2072%20L%2060%2082%20L%2070%2092%20L%2080%2082%20Z%27%20fill%3D%27url(%23b)%27%20stroke%3D%27%23777%27%20stroke-width%3D%271%27/%3E%3Cpolygon%20points%3D%2765,88%2070,98%2075,88%27%20fill%3D%27%23555%27/%3E%3Ccircle%20cx%3D%2770%27%20cy%3D%2798%27%20r%3D%272%27%20fill%3D%27%23333%27/%3E%3C/svg%3E";';
  html += 'var wrap=_cleanupPlayerListeners();_clearReaderGlobals();';
  html += 'var _isAudio=/\\.(mp3|wav|flac|aac|ogg|m4a)$/i.test(it.name);';
  html += 'if(_isAudio){';
  html += 'wrap.innerHTML="<div class=\\"fm-vinyl\\"><div class=\\"fm-vinyl-stage\\"><div class=\\"fm-vinyl-player playing\\" id=\\"fmVinylPlayer\\"><div class=\\"fm-vinyl-disc\\" id=\\"fmVinylDisc\\"><div class=\\"fm-vinyl-base\\"><div class=\\"fm-vinyl-shine\\"></div><div class=\\"fm-vinyl-cover\\" id=\\"fmVinylCover\\"><img id=\\"fmVinylCoverImg\\" src=\\"\\" style=\\"display:none;width:100%;height:100%;object-fit:cover;border-radius:50%\\" onerror=\\"this.style.display=\\x27none\\x27;document.getElementById(\\x27fmVinylSvg\\x27).style.display=\\x27block\\x27\\"><svg viewBox=\\"0 0 300 300\\" id=\\"fmVinylSvg\\" style=\\"display:block\\"><circle cx=\\"150\\" cy=\\"150\\" r=\\"150\\" fill=\\"#ff7e5f\\"/><text x=\\"150\\" y=\\"170\\" text-anchor=\\"middle\\" font-size=\\"60\\" fill=\\"rgba(255,255,255,.5)\\">🎵</text></svg></div><div class=\\"fm-vinyl-hole\\"></div></div></div><div class=\\"fm-vinyl-tonearm\\"><img src=\\""+_fmTonearmUrl+"\\"></div><div class=\\"fm-vinyl-playmask\\"><button class=\\"fm-vinyl-playbtn\\" id=\\"fmVinylPlayBtn\\"><svg viewBox=\\"0 0 24 24\\" id=\\"fmVinylIcon\\"><rect x=\\"6\\" y=\\"4\\" width=\\"4\\" height=\\"16\\"/><rect x=\\"14\\" y=\\"4\\" width=\\"4\\" height=\\"16\\"/></svg></button></div></div><div class=\\"fm-vinyl-info\\"><div class=\\"title\\">"+it.name+"</div></div></div><div class=\\"fm-lyrics\\" id=\\"fmLyrics\\"></div><audio src=\\""+url+"\\" autoplay playsinline webkit-playsinline style=\\"display:none\\"></audio><div class=\\"fm-audio-bar\\" id=\\"fmAudioBar\\"><div class=\\"fm-audio-times\\"><span id=\\"fmCurTime\\">00:00</span><div class=\\"fm-lrc-offset\\" id=\\"fmLrcOffset\\"><button class=\\"fm-offset-btn\\" id=\\"fmOffM\\">-0.5s</button><span class=\\"fm-offset-val\\" id=\\"fmOffV\\">0.0s</span><button class=\\"fm-offset-btn\\" id=\\"fmOffP\\">+0.5s</button><button class=\\"fm-offset-btn\\" id=\\"fmOffR\\">↺</button><button class=\\"fm-offset-btn\\" id=\\"fmDlLrc\\">⬇</button></div><span id=\\"fmTotalTime\\">00:00</span></div><div class=\\"fm-audio-progress\\" id=\\"fmProgress\\"><div class=\\"fm-audio-track\\"><div class=\\"fm-audio-buffer\\" id=\\"fmBuffer\\"></div><div class=\\"fm-audio-fill\\" id=\\"fmFill\\"></div></div><div class=\\"fm-audio-thumb\\" id=\\"fmThumb\\"></div></div><div class=\\"fm-ctrls\\"><button class=\\"fm-ctrl\\" id=\\"fmPrev\\"><svg viewBox=\\"0 0 24 24\\"><path d=\\"M6 6h2v12H6zm3.5 6l8.5 6V6z\\"/></svg></button><button class=\\"fm-ctrl fm-ctrl-play\\" id=\\"fmPlayBtn2\\"><svg viewBox=\\"0 0 24 24\\" id=\\"fmPlayIcon2\\"><rect x=\\"6\\" y=\\"4\\" width=\\"4\\" height=\\"16\\"/><rect x=\\"14\\" y=\\"4\\" width=\\"4\\" height=\\"16\\"/></svg></button><button class=\\"fm-ctrl\\" id=\\"fmNext\\"><svg viewBox=\\"0 0 24 24\\"><path d=\\"M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z\\"/></svg></button><button class=\\"fm-ctrl\\" id=\\"fmLoop\\"><svg viewBox=\\"0 0 24 24\\"><path d=\\"M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z\\"/></svg></button><button class=\\"fm-ctrl\\" id=\\"fmList\\"><svg viewBox=\\"0 0 24 24\\"><path d=\\"M3 5h18v2H3zm0 6h18v2H3zm0 6h18v2H3z\\"/></svg></button></div></div><div class=\\"fm-pl-mask\\" id=\\"fmPlMask\\"></div><div class=\\"fm-playlist\\" id=\\"fmPlaylist\\"><div class=\\"fm-pl-header\\"><span class=\\"fm-pl-title\\">歌单</span><button class=\\"fm-pl-close\\" id=\\"fmPlClose\\">✕</button></div><div id=\\"fmPlList\\"></div></div></div>";';
  html += 'var _lrcOffObj={v:parseFloat(localStorage.getItem("lrc_offset")||"0")||0};var _audio=wrap.querySelector("audio");var _vp=wrap.querySelector("#fmVinylPlayer");var _vd=wrap.querySelector("#fmVinylDisc");var _vi=wrap.querySelector("#fmVinylIcon");var _vb=wrap.querySelector("#fmVinylPlayBtn");var _vc=wrap.querySelector("#fmVinylCover");var _ab=wrap.querySelector("#fmAudioBar");var _fp=wrap.querySelector("#fmProgress");var _ff=wrap.querySelector("#fmFill");var _fb=wrap.querySelector("#fmBuffer");var _ft=wrap.querySelector("#fmThumb");var _fc=wrap.querySelector("#fmCurTime");var _ftt=wrap.querySelector("#fmTotalTime");var _offV=wrap.querySelector("#fmOffV");var _offM=wrap.querySelector("#fmOffM");var _offP=wrap.querySelector("#fmOffP");var _offR=wrap.querySelector("#fmOffR");var _dlLrc=wrap.querySelector("#fmDlLrc");if(_offV)_offV.textContent=_lrcOffObj.v.toFixed(1)+"s";if(_offM)_offM.onclick=function(){_lrcOffObj.v-=0.5;localStorage.setItem("lrc_offset",_lrcOffObj.v);if(_offV)_offV.textContent=_lrcOffObj.v.toFixed(1)+"s"};if(_offP)_offP.onclick=function(){_lrcOffObj.v+=0.5;localStorage.setItem("lrc_offset",_lrcOffObj.v);if(_offV)_offV.textContent=_lrcOffObj.v.toFixed(1)+"s"};if(_offR)_offR.onclick=function(){_lrcOffObj.v=0;localStorage.setItem("lrc_offset","0");if(_offV)_offV.textContent="0.0s"};if(_dlLrc)_dlLrc.onclick=function(){if(!_audio||!_audio._rawLrc||!_audio._songPath){alert("暂无歌词可下载");return}_dlLrc.textContent="...";fetch("/files-save-lyrics",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:_audio._songPath,lyrics:_audio._rawLrc})}).then(function(r){return r.json()}).then(function(j){_dlLrc.textContent="⬇";if(j.ok){alert("歌词已保存到歌曲同目录的歌词文件夹")}else{alert("保存失败："+(j.error||"未知错误"))}}).catch(function(e){_dlLrc.textContent="⬇";alert("保存失败："+e.message)})};';
  html += 'var _coverImg0=wrap.querySelector("#fmVinylCoverImg");var _coverSvg0=wrap.querySelector("#fmVinylSvg");fetch("/files-cover?path="+encodeURIComponent(it.path)+"&name="+encodeURIComponent(it.name)).then(function(r){return r.json()}).then(function(j){if(j.ok&&j.cover&&_coverImg0){_coverImg0.src=j.cover;_coverImg0.style.display="block";if(_coverSvg0)_coverSvg0.style.display="none"}else if(_coverImg0){_coverImg0.src="https://picsum.photos/seed/"+Math.floor(Math.random()*99999)+"/300/300";_coverImg0.style.display="block";if(_coverSvg0)_coverSvg0.style.display="none"}}).catch(function(){});';
  html += 'var _vinylRot=0;function _vinylSpin(){if(!_vinylSpinning)return;_vinylRot=(_vinylRot+0.5)%360;if(_vd)_vd.style.transform="rotate("+_vinylRot+"deg)";_vinylRaf=requestAnimationFrame(_vinylSpin)}';
  html += 'function _vinylStartSpin(){if(_vinylSpinning)return;_vinylSpinning=true;if(_vinylRaf)cancelAnimationFrame(_vinylRaf);_vinylRaf=requestAnimationFrame(_vinylSpin)}';
  html += 'function _vinylStopSpin(){_vinylSpinning=false;if(_vinylRaf){cancelAnimationFrame(_vinylRaf);_vinylRaf=null}}';
  html += 'if(_audio){_audio.addEventListener("canplay",function(){if(_audio.paused){_audio.play().catch(function(){})}});';
  html += '_audio.addEventListener("playing",function(){if(_vp){_vp.classList.add("playing");_vp.classList.remove("paused")}_vinylStartSpin();if(_vi)_vi.innerHTML="<rect x=\\"6\\" y=\\"4\\" width=\\"4\\" height=\\"16\\"/><rect x=\\"14\\" y=\\"4\\" width=\\"4\\" height=\\"16\\"/>"});';
  html += '_audio.addEventListener("pause",function(){if(_vp){_vp.classList.add("paused");_vp.classList.remove("playing")}_vinylStopSpin();if(_vi)_vi.innerHTML="<path d=\\"M8 5v14l11-7z\\"/>"});';
  html += '_audio.addEventListener("ended",function(){if(_vp){_vp.classList.add("paused");_vp.classList.remove("playing")}_vinylStopSpin();if(_vi)_vi.innerHTML="<path d=\\"M8 5v14l11-7z\\"/>";if(typeof _audioOnEnd==="function")_audioOnEnd()});}';
  html += 'function _fmtT(s){if(!s||!isFinite(s))return"00:00";var m=Math.floor(s/60),sec=Math.floor(s%60);return(m<10?"0":"")+m+":"+(sec<10?"0":"")+sec}';
  html += 'if(_audio){_audio.addEventListener("timeupdate",function(){var d=_audio.duration;if(d&&isFinite(d)){var pct=_audio.currentTime/d*100;if(_ff)_ff.style.width=pct+"%";if(_ft)_ft.style.left=pct+"%";if(_fc)_fc.textContent=_fmtT(_audio.currentTime);if(_ftt)_ftt.textContent=_fmtT(d)}if(_audio.buffered&&_audio.buffered.length>0&&d){var bf=_audio.buffered.end(_audio.buffered.length-1)/d*100;if(_fb)_fb.style.width=bf+"%"}});';
  html += '_audio.addEventListener("loadedmetadata",function(){if(_ftt&&_audio.duration&&isFinite(_audio.duration))_ftt.textContent=_fmtT(_audio.duration)});}';
  html += 'var _pDrag=false;function _seekP(e){if(!_audio||!_audio.duration||!isFinite(_audio.duration))return;var r=_fp.getBoundingClientRect();var pct=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));_audio.currentTime=pct*_audio.duration;if(_ff)_ff.style.width=pct*100+"%";if(_ft)_ft.style.left=pct*100+"%";if(_fc)_fc.textContent=_fmtT(pct*_audio.duration)}';
  html += 'if(_fp){_fp.addEventListener("mousedown",function(e){_pDrag=true;_seekP(e)});document.addEventListener("mousemove",function(e){if(_pDrag)_seekP(e)});document.addEventListener("mouseup",function(){_pDrag=false});_fp.addEventListener("touchstart",function(e){_pDrag=true;_seekP(e.touches[0])},{passive:true});document.addEventListener("touchmove",function(e){if(_pDrag)_seekP(e.touches[0])},{passive:true});document.addEventListener("touchend",function(){_pDrag=false})}';
  html += '_vinylStartSpin();';
  html += 'if(_vb)_vb.addEventListener("click",function(e){e.stopPropagation();if(_audio){if(_audio.paused)_audio.play();else _audio.pause()}});';
  html += 'var _vplayer=wrap.querySelector("#fmVinylPlayer");if(_vplayer)_vplayer.addEventListener("click",function(e){if(e.target.closest(".fm-vinyl-playbtn"))return;e.stopPropagation();if(_audio){if(_audio.paused)_audio.play();else _audio.pause()}});';
  html += 'var _fmLyricsEl=wrap.querySelector("#fmLyrics");var _fmVinylEl=wrap.querySelector(".fm-vinyl");if(_fmLyricsEl&&_fmVinylEl&&_audio){_initLyrics(_audio,_fmLyricsEl,_fmVinylEl,it.path,it.name,_lrcOffObj)}';
  html += 'var _audioPlaylist=[];var _audioCurIdx=0;var _loopMode=parseInt(localStorage.getItem("fm_loop_mode")||"0");var _audioRegex=/\\.(mp3|wav|flac|aac|ogg|m4a)$/i;for(var _ai=0;_ai<window._items.length;_ai++){if(_audioRegex.test(window._items[_ai].name)){_audioPlaylist.push(_ai)}}_audioCurIdx=_audioPlaylist.indexOf(idx);if(_audioCurIdx<0)_audioCurIdx=0;';
  html += 'function _updateLoopIcon(){var _lb=wrap.querySelector("#fmLoop");if(!_lb)return;var _li=_lb.querySelector("svg");if(_loopMode===0){_lb.classList.remove("on");_li.innerHTML="<path d=\\"M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z\\"/>"}else if(_loopMode===1){_lb.classList.add("on");_li.innerHTML="<path d=\\"M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z\\"/>"}else{_lb.classList.add("on");_li.innerHTML="<path d=\\"M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z\\"/><text x=\\"12\\" y=\\"15\\" text-anchor=\\"middle\\" font-size=\\"10\\" fill=\\"currentColor\\" font-weight=\\"bold\\">1</text>"}};';
  html += 'function _audioOnEnd(){if(_loopMode===2){if(_audio){_audio.currentTime=0;_audio.play()}}else{_audioNext()}}';
  html += 'function _audioSwitchTrack(_idx){var _nit=window._items[_idx];var _nurl="/files-stream?path="+encodeURIComponent(_nit.path);el("#playerTitle").textContent=_nit.name;var _vinf=wrap.querySelector(".fm-vinyl-info .title");if(_vinf)_vinf.textContent=_nit.name;var _coverImg=wrap.querySelector("#fmVinylCoverImg");var _coverSvg=wrap.querySelector("#fmVinylSvg");if(_coverImg){_coverImg.style.display="none";_coverImg.src=""}if(_coverSvg)_coverSvg.style.display="block";fetch("/files-cover?path="+encodeURIComponent(_nit.path)+"&name="+encodeURIComponent(_nit.name)).then(function(r){return r.json()}).then(function(j){if(j.ok&&j.cover&&_coverImg){_coverImg.src=j.cover;_coverImg.style.display="block";if(_coverSvg)_coverSvg.style.display="none"}else if(_coverImg){_coverImg.src="https://picsum.photos/seed/"+Math.floor(Math.random()*99999)+"/300/300";_coverImg.style.display="block";if(_coverSvg)_coverSvg.style.display="none"}}).catch(function(){});if(_audio){_audio.src=_nurl;_audio.load();_audio.play().catch(function(){});var _lrcEl=wrap.querySelector("#fmLyrics");var _vEl=wrap.querySelector(".fm-vinyl");if(_lrcEl&&_vEl){_lrcEl.innerHTML="";_lrcEl.style.display="none";_vEl.classList.remove("has-lyrics");_initLyrics(_audio,_lrcEl,_vEl,_nit.path,_nit.name,_lrcOffObj)}if(typeof _renderPlaylist==="function")_renderPlaylist()}else{playMedia(_idx)}}';
  html += 'function _audioNext(){if(_audioPlaylist.length<=1)return;if(_loopMode===0&&_audioCurIdx>=_audioPlaylist.length-1){return}_audioCurIdx=(_audioCurIdx+1)%_audioPlaylist.length;_audioSwitchTrack(_audioPlaylist[_audioCurIdx])}';
  html += 'function _audioPrev(){if(_audioPlaylist.length<=1)return;_audioCurIdx=(_audioCurIdx-1+_audioPlaylist.length)%_audioPlaylist.length;_audioSwitchTrack(_audioPlaylist[_audioCurIdx])}';
  html += 'function _renderPlaylist(){var _pl=wrap.querySelector("#fmPlList");if(!_pl)return;var _h="";for(var _i=0;_i<_audioPlaylist.length;_i++){var _it=window._items[_audioPlaylist[_i]];var _cls=_i===_audioCurIdx?"fm-pl-item active":"fm-pl-item";_h+="<div class=\\\""+_cls+"\\\" data-idx=\\\""+_i+"\\\"><span class=\\\"fm-pl-idx\\\">"+(_i+1)+"</span><span class=\\\"fm-pl-name\\\">"+_it.name+"</span></div>"}_pl.innerHTML=_h;var _items=_pl.querySelectorAll(".fm-pl-item");for(var _j=0;_j<_items.length;_j++){_items[_j].onclick=function(){var _di=parseInt(this.dataset.idx);_audioCurIdx=_di;_audioSwitchTrack(_audioPlaylist[_di]);_closePlaylist()}}}';
  html += 'function _closePlaylist(){var _pm=wrap.querySelector("#fmPlMask");var _pp=wrap.querySelector("#fmPlaylist");if(_pm)_pm.classList.remove("show");if(_pp)_pp.classList.remove("show")}';
  html += 'function _openPlaylist(){_renderPlaylist();var _pm=wrap.querySelector("#fmPlMask");var _pp=wrap.querySelector("#fmPlaylist");if(_pm)_pm.classList.add("show");if(_pp)_pp.classList.add("show")}';
  html += '_updateLoopIcon();';
  html += 'var _prevBtn=wrap.querySelector("#fmPrev");if(_prevBtn)_prevBtn.addEventListener("click",function(e){e.stopPropagation();_audioPrev()});';
  html += 'var _nextBtn=wrap.querySelector("#fmNext");if(_nextBtn)_nextBtn.addEventListener("click",function(e){e.stopPropagation();_audioNext()});';
  html += 'var _playBtn2=wrap.querySelector("#fmPlayBtn2");if(_playBtn2)_playBtn2.addEventListener("click",function(e){e.stopPropagation();if(_audio){if(_audio.paused)_audio.play();else _audio.pause()}});';
  html += 'var _loopBtn=wrap.querySelector("#fmLoop");if(_loopBtn)_loopBtn.addEventListener("click",function(e){e.stopPropagation();_loopMode=(_loopMode+1)%3;localStorage.setItem("fm_loop_mode",_loopMode);_updateLoopIcon()});';
  html += 'var _listBtn=wrap.querySelector("#fmList");if(_listBtn)_listBtn.addEventListener("click",function(e){e.stopPropagation();_openPlaylist()});';
  html += 'var _plMask=wrap.querySelector("#fmPlMask");if(_plMask)_plMask.addEventListener("click",function(){_closePlaylist()});';
  html += 'var _plClose=wrap.querySelector("#fmPlClose");if(_plClose)_plClose.addEventListener("click",function(){_closePlaylist()});';
  html += '}else{';
  html += 'wrap.innerHTML="<video src=\\""+url+"\\" controls autoplay playsinline webkit-playsinline style=\\"width:100%;height:100%\\"></video>"}';
  html += 'el("#playerOverlay").classList.add("show");_rotDeg=0;';
  html += 'var topbar=el("#playerOverlay").querySelector(".player-topbar");';
  html += 'var media=wrap.querySelector("video")||wrap.querySelector("audio");';
  html += 'var hideTimer=null;';
  html += 'function hideBar(){topbar.classList.add("hide");if(_isAudio&&_ab)_ab.classList.add("hide")}';
  html += 'function showBar(){topbar.classList.remove("hide");if(_isAudio&&_ab)_ab.classList.remove("hide");if(hideTimer)clearTimeout(hideTimer);hideTimer=setTimeout(hideBar,3000)}';
  html += 'if(media&& !_isAudio){media.muted=true;media.play().then(function(){media.muted=false}).catch(function(){media.muted=false});';
  html += 'media.addEventListener("playing",function(){media.muted=false;hideTimer=setTimeout(hideBar,2000)});';
  html += 'media.addEventListener("pause",function(){if(hideTimer)clearTimeout(hideTimer);topbar.classList.remove("hide")})}';
  html += 'if(_isAudio){topbar.classList.add("hide");if(_ab)_ab.classList.add("hide")}';
  html += 'var po=el("#playerOverlay");var tapTime=0;';
  html += '_poClickHandler=function(e){if(e.target.closest(".player-topbar"))return;if(_isAudio&&(e.target.closest(".fm-vinyl-player")||e.target.closest(".fm-audio-bar")||e.target.closest(".fm-lyrics")||e.target.closest(".fm-playlist")||e.target.closest(".fm-pl-mask")))return;var now=Date.now();if(now-tapTime<300)return;tapTime=now;if(topbar.classList.contains("hide"))showBar();else hideBar()};';
  html += 'po.addEventListener("touchend",_poClickHandler);';
  html += 'closeInfo()}';
  html += 'function viewImage(idx){var it=window._items[idx];var url="/files-stream?path="+encodeURIComponent(it.path);el("#playerTitle").textContent=it.name;';
  html += 'var wrap=_cleanupPlayerListeners();_clearReaderGlobals();wrap.innerHTML="<img src=\\""+url+"\\" style=\\"max-width:100%;max-height:100%;object-fit:contain\\">";el("#playerOverlay").classList.add("show");var _itb=el("#playerOverlay").querySelector(".player-topbar");if(_itb)_itb.classList.add("hide");wrap.addEventListener("click",function(){if(_itb)_itb.classList.toggle("hide")});closeInfo()}';
  html += 'function viewPdf(idx){var it=window._items[idx];var url="/files-stream?path="+encodeURIComponent(it.path);el("#playerTitle").textContent=it.name;';
  html += 'var wrap=_cleanupPlayerListeners();_clearReaderGlobals();wrap.innerHTML="<div id=\\"pdfContainer\\" style=\\"position:absolute;inset:0;overflow-y:auto;background:#222;-webkit-overflow-scrolling:touch\\"></div>";';
  html += 'var script=document.createElement("script");script.src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";';
  html += 'script.onload=function(){';
  html += 'pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";';
  html += 'pdfjsLib.getDocument(url).promise.then(function(pdf){';
  html += 'var container=document.getElementById("pdfContainer");';
  html += 'function renderPage(num){';
  html += 'pdf.getPage(num).then(function(page){';
  html += 'var scale=Math.min(2,window.devicePixelRatio||1.5);';
  html += 'var vp=page.getViewport({scale:scale});';
  html += 'var canvas=document.createElement("canvas");';
  html += 'canvas.style.width="100%";canvas.style.height="auto";canvas.style.display="block";';
  html += 'canvas.width=vp.width;canvas.height=vp.height;';
  html += 'var ctx=canvas.getContext("2d");';
  html += 'page.render({canvasContext:ctx,viewport:vp}).promise.then(function(){';
  html += 'if(num<pdf.numPages)renderPage(num+1)});';
  html += 'container.appendChild(canvas)})}';
  html += 'renderPage(1)}).catch(function(e){wrap.innerHTML="<div style=\\"text-align:center;padding:40px;color:#ff6b6b\\">PDF加载失败: "+e.message+"</div>"})};';
  html += 'document.head.appendChild(script);';
  html += 'el("#playerOverlay").classList.add("show");var _ptb=el("#playerOverlay").querySelector(".player-topbar");if(_ptb)_ptb.classList.add("hide");_readerBarsHidden=true;wrap.addEventListener("click",function(e){if(e.target.closest("button"))return;var _tb=el("#playerOverlay").querySelector(".player-topbar");if(_tb)_tb.classList.toggle("hide");_readerBarsHidden=_tb?_tb.classList.contains("hide"):_readerBarsHidden});closeInfo()}';
  html += 'function readText(idx){var it=window._items[idx];';
  html += 'var wrap=_cleanupPlayerListeners();_clearReaderGlobals();';
  html += 'var fetchUrl=it.path;';
  html += 'if(/^https?:\\/\\//.test(fetchUrl)){fetchUrl="/live-proxy?url="+encodeURIComponent(fetchUrl)}else{fetchUrl="/files-stream?path="+encodeURIComponent(it.path)}';
  html += 'fetch(fetchUrl).then(function(r){return r.text()}).then(function(text){';
  html += 'el("#playerTitle").textContent=it.name;';
  html += 'var safeText=text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");';
  html += 'var lines=safeText.split("\\n");';
  html += 'var linesPerPage=Math.floor((window.innerHeight-100)/28);if(linesPerPage<5)linesPerPage=10;';
  html += 'var totalPages=Math.ceil(lines.length/linesPerPage);var curPage=0;window._textTotalPages=totalPages;window._textCurPage=0;';
  html += 'function renderPage(){curPage=window._textCurPage||0;var start=curPage*linesPerPage;var end=Math.min(start+linesPerPage,lines.length);';
  html += 'var pageLines=lines.slice(start,end).join("<br>");';
  html += 'wrap.innerHTML="<div style=\\"display:flex;flex-direction:column;height:100%\\">"+';
  html += '"<div style=\\"flex:1;overflow-y:auto;padding:16px 20px;font-size:'+ "'+ _readerFontSize +'"+ 'px;line-height:1.8\\" id=\\"textContent\\">"+pageLines+"</div>"+';
  html += '"<div class=\\"reader-bar\\" id=\\"textReaderBar\\">"+';
  html += '"<button onclick=\\"textPrev()\\" style=\\"background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:8px 20px;border-radius:8px;font-size:14px;cursor:pointer\\">\u25C0 \u4E0A\u4E00\u9875</button>"+';
  html += '"<span style=\\"color:rgba(255,255,255,.6);font-size:13px\\">"+(curPage+1)+" / "+totalPages+"</span>"+';
  html += '"<button onclick=\\"textNext()\\" style=\\"background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:8px 20px;border-radius:8px;font-size:14px;cursor:pointer\\">\u4E0B\u4E00\u9875 \u25B6</button>"+';
  html += '"</div></div>";if(_readerBarsHidden){var _tb=el("#playerOverlay").querySelector(".player-topbar");var _bb=el("#textReaderBar");if(_tb)_tb.classList.add("hide");if(_bb)_bb.classList.add("hide")}}';
  html += 'window.textPrev=function(){if(curPage>0){curPage--;window._textCurPage=curPage;renderPage();applyTheme();applyFontSize();applyBgImg();if(_lastSearchKw)searchInContent(_lastSearchKw)}};';
  html += 'window.textNext=function(){if(curPage<totalPages-1){curPage++;window._textCurPage=curPage;renderPage();applyTheme();applyFontSize();applyBgImg();if(_lastSearchKw)searchInContent(_lastSearchKw)}};';
  html += 'window.renderPage=function(){renderPage();applyTheme();applyFontSize();applyBgImg();if(_lastSearchKw)searchInContent(_lastSearchKw)};';
  html += 'renderPage();applyTheme();applyFontSize();applyBgImg();';
  html += 'wrap.addEventListener("click",function(e){if(e.target.closest("button"))return;var x=e.clientX;var w=window.innerWidth;if(x<w*0.35){window.textPrev()}else if(x>w*0.65){window.textNext()}else{_toggleReaderBars()}});';
  html += 'el("#playerOverlay").classList.add("show");_hideReaderBars();closeInfo()}).catch(function(e){alert("\u8BFB\u53D6\u5931\u8D25: "+e.message)})}';
  html += 'var _lastSearchKw="";';
  html += 'var _readerBgImg=localStorage.getItem("readerBgImg")||"";';
html += 'function setBgImage(v){';
html += 'if(v==="local"){var inp=document.createElement("input");inp.type="file";inp.accept="image/*";inp.onchange=function(e){var f=e.target.files[0];if(!f)return;var r=new FileReader();r.onload=function(ev){_readerBgImg=ev.target.result;localStorage.setItem("readerBgImg",_readerBgImg);applyBgImg()};r.readAsDataURL(f)};inp.click();return}';
html += 'if(v==="url"){var u=prompt("\u8F93\u5165\u56FE\u7247URL","https://");if(u&&u.indexOf("http")===0){_readerBgImg=u;localStorage.setItem("readerBgImg",_readerBgImg);applyBgImg()}return}';
html += '_readerBgImg="";localStorage.removeItem("readerBgImg");applyBgImg()}';
html += 'function applyBgImg(){var c=el("#epubContent")||el("#textContent");if(!c)return;var themes=[{bg:"#1a1a2e"},{bg:"#f5f5f5"},{bg:"#2b1d0e"}];var tbg=(themes[_readerTheme]||themes[0]).bg;if(_readerBgImg){c.style.backgroundImage="url("+_readerBgImg+")";c.style.backgroundSize="cover";c.style.backgroundPosition="center";c.style.backgroundRepeat="no-repeat";var a=Math.round(_bgOpacity/100*255);c.style.backgroundColor="rgba(0,0,0,"+(_bgOpacity/100)+")";c.style.backgroundBlendMode="multiply"}else{c.style.backgroundImage="none";c.style.backgroundColor=tbg;c.style.backgroundBlendMode=""}c.style.filter="brightness("+_brightness/100+")"}';
html += 'var _bgOpacity=parseInt(localStorage.getItem(\x27bgOpacity\x27))||30;var _brightness=parseInt(localStorage.getItem(\x27brightness\x27))||100;function setBgOpacity(v){_bgOpacity=parseInt(v);localStorage.setItem(\x27bgOpacity\x27,_bgOpacity);el(\x27#bgOpacityVal\x27).textContent=_bgOpacity+\x27%\x27;applyBgImg()}function setBrightness(v){_brightness=parseInt(v);localStorage.setItem(\x27brightness\x27,_brightness);el(\x27#brightnessVal\x27).textContent=_brightness+\x27%\x27;applyBgImg()}function closePlayer(){el("#playerOverlay").classList.remove("show");el("#playerWrap").innerHTML="";el("#readerSettings").classList.remove("show");_clearReaderGlobals()}';
  html += 'function toggleSettings(){el("#readerSettings").classList.toggle("show")}';
  html += 'var _readerFontSize=parseInt(localStorage.getItem("readerFontSize"))||16;';
  html += 'function applyFontSize(){var c=el("#epubContent")||el("#textContent");if(c){c.style.fontSize=_readerFontSize+"px"}el("#fontSizeVal").textContent=_readerFontSize}';
  html += 'function adjustFontSize(d){_readerFontSize=Math.min(28,Math.max(12,_readerFontSize+d));localStorage.setItem("readerFontSize",_readerFontSize);applyFontSize()}';
  html += 'var _readerTheme=parseInt(localStorage.getItem("readerTheme"))||0;';
  html += 'function applyTheme(){var themes=[{bg:"#1a1a2e",fg:"#d4d4d4"},{bg:"#f5f5f5",fg:"#333"},{bg:"#2b1d0e",fg:"#c4a882"}];var t=themes[_readerTheme]||themes[0];var c=el("#epubContent")||el("#textContent");if(c){c.style.background=t.bg;c.style.color=t.fg}["themeDark","themeLight","themeNight"].forEach(function(id,n){var b=el("#"+id);if(b)b.classList.toggle("active",n===_readerTheme)})}';
  html += 'function setTheme(n){_readerTheme=n;localStorage.setItem("readerTheme",n);applyTheme()}';
  html += 'function jumpToProgress(v){v=parseInt(v)||0;if(window._epubTotalPages){window._epubCurPage=Math.floor(v/100*window._epubTotalPages);if(window.renderEpubPage){window.renderEpubPage();applyBgImg()}}if(window._textTotalPages){window._textCurPage=Math.floor(v/100*window._textTotalPages);if(window.renderPage){window.renderPage();applyBgImg()}}}';
  html += 'function searchInContent(kw){_lastSearchKw=kw;var c=el("#epubContent")||el("#textContent");if(!c)return;if(!kw){c.querySelectorAll("span.hl").forEach(function(s){var p=s.parentNode;p.replaceChild(document.createTextNode(s.textContent),s);p.normalize()});return}c.querySelectorAll("span.hl").forEach(function(s){var p=s.parentNode;p.replaceChild(document.createTextNode(s.textContent),s)});c.normalize();var re=new RegExp("("+kw.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&")+")","gi");function highlight(node){if(node.nodeType!==3){if(node.childNodes&&node.tagName!=="SCRIPT"&&node.tagName!=="STYLE"){var children=Array.prototype.slice.call(node.childNodes);children.forEach(highlight)}return}var txt=node.textContent;if(!re.test(txt))return;re.lastIndex=0;var frag=document.createDocumentFragment();var m;var last=0;while(m=re.exec(txt)){if(m.index>last)frag.appendChild(document.createTextNode(txt.slice(last,m.index)));var span=document.createElement("span");span.className="hl";span.textContent=m[0];frag.appendChild(span);last=m.index+m[0].length}if(last<txt.length)frag.appendChild(document.createTextNode(txt.slice(last)));node.parentNode.replaceChild(frag,node)}highlight(c)}';
  html += 'function toggleFs(){var po=el("#playerOverlay");var v=po.querySelector("video")||po.querySelector("audio")||po.querySelector("#playerWrap")||po;';
  html += 'if(document.fullscreenElement||document.webkitFullscreenElement){if(document.exitFullscreen)document.exitFullscreen();else if(document.webkitExitFullscreen)document.webkitExitFullscreen()}';
  html += 'else{if(po.requestFullscreen)po.requestFullscreen();else if(po.webkitRequestFullscreen)po.webkitRequestFullscreen()}}';
  html += 'var _rotDeg=0;function toggleRotate(){_rotDeg=(_rotDeg+90)%360;var po=el("#playerWrap");if(!po)return;var c=po.firstChild;if(!c)return;c.style.transform="rotate("+_rotDeg+"deg)";c.style.transformOrigin="center center";';
  html += 'if(_rotDeg===90||_rotDeg===270){c.style.maxWidth=po.clientHeight+"px";c.style.maxHeight=po.clientWidth+"px"}';
  html += 'else{c.style.maxWidth="";c.style.maxHeight=""}}';
  html += 'document.addEventListener("fullscreenchange",function(){var v=document.querySelector("#playerOverlay video");if(v)applyRotation(v)});';
  html += 'document.addEventListener("webkitfullscreenchange",function(){var v=document.querySelector("#playerOverlay video");if(v)applyRotation(v)});';
  html += 'el("#backBtn").onclick=function(){';
  html += 'if(curPath==="/sdcard/Download/"||curPath==="/"){if(_isHiker){try{';
  html += 'var p=parent,d=p.document;';
  html += 'var f=d.getElementById("catFrame");if(f){f.style.display="none";f.src="about:blank"}';
  html += '["main","car","cbar","cbarMore"].forEach(function(id){var e=d.getElementById(id);if(e)e.style.display=""});';
  html += 'var cw=d.querySelector(".cbar-wrap");if(cw)cw.style.display="";';
  html += 'var hd=d.querySelector(".header");if(hd)hd.style.display=""';
  html += '}catch(e){try{parent.postMessage({type:"closeCatFrame"},"*")}catch(e2){history.back()}}}else{history.back()}return}';
  html += 'var parts=curPath.replace(/\\/$/,"").split("/");parts.pop();loadDir(parts.join("/")||"/sdcard/Download")};';
  html += 'function loadDir(p){curPath=p;el("#pathBar").textContent=p;el("#content").innerHTML="<div class=\\"tip\\\">\u52A0\u8F7D\u4E2D...</div>";';
  html += 'fetch("/files-api?path="+encodeURIComponent(p)).then(function(r){return r.json()}).then(function(j){';
  html += 'if(!j.ok){el("#content").innerHTML="<div class=\\"tip\\\">\u274C "+j.error+"</div>";return}';
  html += 'if(!j.items.length){el("#content").innerHTML="<div class=\\"tip\\\">\u7A7A\u6587\u4EF6\u5939</div>";return}';
  html += 'render(j.items)}).catch(function(e){el("#content").innerHTML="<div class=\\"tip\\\">\u52A0\u8F7D\u5931\u8D25: "+e.message+"</div>"})}';
  html += 'loadDir(curPath);';
  html += 'function openEpub(idx){var it=window._items[idx];el("#playerTitle").textContent=it.name;var wrap=_cleanupPlayerListeners();_clearReaderGlobals();wrap.innerHTML="<div style=\\"position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.5);font-size:14px\\" id=\\"epubLoading\\">\\u52A0\\u8F7D\\u4E2D...</div>";el("#playerOverlay").classList.add("show");closeInfo();';
  html += 'fetch("/files-epub-view?path="+encodeURIComponent(it.path)).then(function(r){return r.json()}).then(function(j){';
  html += 'if(!j.ok||!j.text){wrap.innerHTML="<div style=\\"position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;color:#ff6b6b;font-size:13px;text-align:center\\">"+(j.error||"\\u65E0\\u6CD5\\u89E3\\u6790")+"<br><br>\\u626B\\u63CF\\u5230"+(j.htmlCount||0)+"\\u4E2AHTML\\u6587\\u4EF6<br>"+(j.errors&&j.errors.length?"\\u9519\\u8BEF: "+j.errors.join("; "):"")+"</div>";return}';
  html += 'var epubText=j.text;';
  html += 'var lines=epubText.split("\\n");';
  html += 'var linesPerPage=Math.floor((window.innerHeight-100)/28);if(linesPerPage<5)linesPerPage=10;';
  html += 'var totalPages=Math.ceil(lines.length/linesPerPage);var curPage=0;window._epubTotalPages=totalPages;window._epubCurPage=0;';
  html += 'function renderEpubPage(){curPage=window._epubCurPage||0;var start=curPage*linesPerPage;var end=Math.min(start+linesPerPage,lines.length);';
  html += 'var pageLines=lines.slice(start,end).join("<br>");';
  html += 'wrap.innerHTML="<div style=\\"display:flex;flex-direction:column;height:100%\\">"+';
  html += '"<div id=\\"epubContent\\" style=\\"flex:1;overflow-y:auto;padding:16px 20px;font-size:'+ "'+ _readerFontSize +'"+ 'px;line-height:1.8;word-break:break-word\\">"+pageLines+"</div>"+';
  html += '"<div class=\\"reader-bar\\" id=\\"epubReaderBar\\">"+';
  html += '"<button onclick=\\"epubPrev()\\" style=\\"background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:8px 20px;border-radius:8px;font-size:14px;cursor:pointer\\">\\u25C0 \\u4E0A\\u4E00\\u9875</button>"+';
  html += '"<span style=\\"color:rgba(255,255,255,.6);font-size:13px\\">"+(curPage+1)+" / "+totalPages+"</span>"+';
  html += '"<button onclick=\\"epubNext()\\" style=\\"background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:8px 20px;border-radius:8px;font-size:14px;cursor:pointer\\">\\u4E0B\\u4E00\\u9875 \\u25B6</button>"+';
  html += '"</div></div>";if(_readerBarsHidden){var _tb=el("#playerOverlay").querySelector(".player-topbar");var _bb=el("#epubReaderBar");if(_tb)_tb.classList.add("hide");if(_bb)_bb.classList.add("hide")}}';
  html += 'window.epubPrev=function(){if(curPage>0){curPage--;window._epubCurPage=curPage;renderEpubPage();applyTheme();applyFontSize();applyBgImg();if(_lastSearchKw)searchInContent(_lastSearchKw)}};';
  html += 'window.epubNext=function(){if(curPage<totalPages-1){curPage++;window._epubCurPage=curPage;renderEpubPage();applyTheme();applyFontSize();applyBgImg();if(_lastSearchKw)searchInContent(_lastSearchKw)}};';
  html += 'window.renderEpubPage=function(){renderEpubPage();applyTheme();applyFontSize();applyBgImg();if(_lastSearchKw)searchInContent(_lastSearchKw)};';
  html += 'renderEpubPage();applyTheme();applyFontSize();applyBgImg();';
  html += 'wrap.addEventListener("click",function(e){if(e.target.closest("button")||e.target.closest("img"))return;var x=e.clientX;var w=window.innerWidth;if(x<w*0.35){window.epubPrev()}else if(x>w*0.65){window.epubNext()}else{_toggleReaderBars()}});';
  html += '_hideReaderBars()}).catch(function(e){wrap.innerHTML="<div style=\\"position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#ff6b6b;font-size:14px\\">\\u52A0\\u8F7D\\u5931\\u8D25: "+e.message+"</div>"})}';
  html += 'function loadWebFile(){';
  html += 'var url=el("#webFileUrl").value.trim();';
  html += 'if(!url)return;';
  html += 'if(!/^https?:\\/\\//.test(url))url="http://"+url;';
  html += 'fetch("/live-proxy?url="+encodeURIComponent(url)).then(function(r){return r.text()}).then(function(text){';
  html += 'var it={name:url.split("/").pop().split("?")[0]||"网络文件",path:url,size:text.length,isDir:false};';
  html += 'if(!window._items)window._items=[];';
  html += 'window._items.push(it);';
  html += 'readText(window._items.length-1);';
  html += 'el("#readerSettings").classList.remove("show");';
  html += '}).catch(function(e){alert("加载失败: "+e.message)})}';
  html += '<\/script></body></html>';
  return html;
}