const http = require('http');  
const https = require('https'); 
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 9976;
const SITE = 'https://zzoc.cc';
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
const ALLOWED_HOSTS = ['zzoc.cc', 'www.zzoc.cc', 'api.tmdb.org', 'image.tmdb.org', 'images.tmdb.org', 'mov.cenguigui.cn'];
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
const DATA_DIR = path.join(__dirname, 'data');
const FAV_FILE = path.join(DATA_DIR, 'favorites.json');
const HIS_FILE = path.join(DATA_DIR, 'history.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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
  list.unshift({ id, title: item.title||'', img: item.img||'', url: item.url||'', source: item.source||'zzoc.cc', addedAt: Date.now() });
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
    // 移到最前（最近观看）
    const entry = list.splice(exist, 1)[0];
    if (!entry.lastWatch) entry.lastWatch = Date.now();
    list.unshift(entry);
    if (list.length > 200) list.length = 200;
    writeJSON(HIS_FILE, list);
    return { ok: true };
  }
  // 新记录：使用全部字段创建
  const entry = { id, title: item.title||'', img: item.img||'', url: item.url||'', source: item.source||'zzoc.cc', lastWatch: Date.now(), episode: item.episode||'', progress: item.progress || 0, duration: item.duration || 0, playUrl: item.playUrl||'' };
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
    const proxyImg = img ? 'http://localhost:9976/img?url=' + encodeURIComponent(urlFix(img)) : '';
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
      const proxyImg = img ? 'http://localhost:9976/img?url=' + encodeURIComponent(urlFix(img)) : '';
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
    const proxyImg2 = img ? 'http://localhost:9976/img?url=' + encodeURIComponent(urlFix(img)) : '';
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
  fetchPage(SITE + '/', (err, html) => {
    if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
    try {
      let lunbos = [];
      const sections = [];
      const blocks = html.split('<div class="myui-vodbox">');
      for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i];
        const headingMatch = block.match(/<div class="title[^"]*">([^<]+)<\/div>/);
        if (!headingMatch) continue;
        const sectionName = strip(headingMatch[1]);
        const cards = parseCards(block);
        if (cards.length) sections.push({ title: sectionName, items: cards.slice(0, 18) });
      }
      if (!sections.length) {
        const allCards = parseCards(html);
        if (allCards.length) sections.push({ title: '热门推荐', items: allCards.slice(0, 18) });
      }
      const lunboItems = sections.length && sections[0].items ? sections[0].items.slice(0, 7) : [];
      lunbos = lunboItems.map(it => ({ title: it.title, img: it.img, url: it.url, desc: '' }));
      // 生成前端用的HTML片段
      const sectionsHtml = sections.map(sec => {
        const cardsHtml = sec.items.map(it => {
          const imgSrc = esc(it.img);
          const title = esc(it.title);
          const desc = it.desc ? '<div class=\'crdr\'>' + esc(it.desc) + '</div>' : '';
          const tag = it.tag ? '<div class=\'crd-tag\'>' + esc(it.tag) + '</div>' : '';
          return '<div class=\'crd\' data-url=\'' + esc(it.url) + '\' data-title=\'' + title + '\' data-img=\'' + imgSrc + '\'>' +
            '<div style=\'position:relative\'><img src=\'' + imgSrc + '\' style=\'display:block;width:100%;height:160px;object-fit:cover\' onerror=\'this.src=\"https://picsum.photos/seed/\"+Math.floor(Math.random()*1000)+"/300/400"\'>' + tag + '</div>' +
            '<div class=\'crdi\'><div class=\'crdn\'>' + title + '</div>' + desc + '</div></div>';
        }).join('');
        return { title: sec.title, html: cardsHtml };
      });
      send(res, 200, JSON.stringify({ok:true, lunbos, sectionsHtml}), 'application/json');
    } catch(e) {
      send(res, 200, JSON.stringify({ok:false,error:e.message}));
    }
  });
}



// ========== 分类页HTML ==========
function categoryHtml(cid, name) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title>
<style>
${COMMON_STYLE}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.gr{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{background:rgba(255,255,255,.06);border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 32px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .15s,box-shadow .3s}.card:active{transform:scale(.97)}.poster{position:relative;overflow:hidden}.poster img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;min-height:120px;transition:transform .4s}.card:active .poster img{transform:scale(1.05)}.poster::after{content:'';position:absolute;bottom:0;left:0;right:0;height:40%;background:linear-gradient(transparent,rgba(0,0,0,.6));pointer-events:none}.badge{position:absolute;right:4px;top:4px;z-index:2;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);font-size:9px;color:#fff;border:1px solid rgba(255,255,255,.2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.info{padding:6px 4px;text-align:center;background:rgba(255,255,255,.06)}
.name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.desc{font-size:10px;color:#ffd966;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
.btt{position:fixed;bottom:24px;right:16px;width:44px;height:44px;border-radius:50%;background:rgba(79,195,247,.45);color:#fff;font-size:22px;display:none;align-items:center;justify-content:center;cursor:pointer;z-index:200;border:1px solid rgba(79,195,247,.3);backdrop-filter:blur(6px)}
.btt:active{background:rgba(79,195,247,.7)}
.ftabs{display:flex;gap:8px;padding:0 0 12px 0;overflow-x:auto;-webkit-overflow-scrolling:touch;position:relative;z-index:10;will-change:transform}.ftabs::-webkit-scrollbar{display:none}
.ftab{flex-shrink:0;padding:5px 10px;border-radius:16px;font-size:13px;font-weight:600;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.15);cursor:pointer;transition:all .2s;white-space:nowrap;height:30px;line-height:20px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;position:relative;z-index:10}
.ftab.on{background:rgba(79,195,247,.25);border-color:rgba(79,195,247,.5);color:#4fc3f7}
@media(min-width:600px){.gr{grid-template-columns:repeat(4,1fr)}}
@media(min-width:900px){.gr{grid-template-columns:repeat(5,1fr)}}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap"><div class="ftabs" id="ftabs"></div><div class="gr" id="grid"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var baseCid=${JSON.stringify(cid)},cid=${JSON.stringify(cid)},curFilter='',page=0,loading=false,finished=false,count=0,filters=null;
function el(s){return document.querySelector(s)}
function openVod(it){
  var item=Object.assign({},it);
  if(!/^https?:/.test(item.url))item.url='https://www.zzoc.cc'+item.url;
  try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}
}
function card(it){
  var d=document.createElement('div');d.className='card';
  var poster=document.createElement('div');poster.className='poster';
  var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';
  poster.appendChild(img);
  if(it.tag){var badge=document.createElement('span');badge.className='badge';badge.textContent=it.tag;poster.appendChild(badge)}
  d.appendChild(poster);
  var info=document.createElement('div');info.className='info';
  var name=document.createElement('div');name.className='name';name.textContent=it.title;
  info.appendChild(name);
  if(it.desc){var descEl=document.createElement('div');descEl.className='desc';descEl.textContent=it.desc;info.appendChild(descEl)}
  d.appendChild(info);
  d.onclick=function(){openVod(it)};
  return d;
}
function load(){
  if(loading||finished)return;loading=true;
  var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';
  fetch('/api?cid='+cid+'&filter='+encodeURIComponent(curFilter)+'&page='+next).then(r=>r.json()).then(j=>{
    if(!j.ok)throw new Error(j.error||'load failed');
    if(next===1&&j.filters&&j.filters.length){filters=j.filters;renderFilters();}
    if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'— 暂无内容 —';return}
    page=next;
    j.items.forEach(function(it){el('#grid').appendChild(card(it));count++});
    el('#tip').textContent='已加载 '+count+' 部。';
  }).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)}).finally(()=>loading=false);
}
function renderFilters(){
  var c=el('#ftabs');
  if(!filters||!filters.length){c.style.display='none';return;}
  c.style.display='flex';
  while(c.firstChild)c.removeChild(c.firstChild);
  var all=document.createElement('div');all.className='ftab'+(curFilter===''?' on':'');all.textContent='全部';
  all.onclick=function(){selectFilter('')};c.appendChild(all);
  filters.forEach(function(f){
    var b=document.createElement('div');b.className='ftab'+(curFilter===f.slug?' on':'');b.textContent=f.name;
    b.onclick=function(){selectFilter(f.slug)};c.appendChild(b);
  });
}
function selectFilter(slug){
  if(curFilter===slug)return;
  curFilter=slug;page=0;finished=false;count=0;loading=false;
  el('#grid').innerHTML='';el('#tip').textContent='正在加载...';
  renderFilters();
  load();
  window.scrollTo(0,0);
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
.sbottom{display:flex;align-items:center;gap:8px;margin-top:6px;flex-shrink:0;flex-wrap:wrap}.sbottom-tag{font-size:10px;padding:2px 8px;border-radius:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sbottom-update{background:rgba(79,195,247,.15);color:#4fc3f7;border:1px solid rgba(79,195,247,.25)}.sbottom-rating{background:rgba(255,193,7,.15);color:#ffc107;border:1px solid rgba(255,193,7,.25)}.sbottom-hot{background:rgba(255,71,87,.15);color:#ff6b6b;border:1px solid rgba(255,71,87,.25)}
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
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url))item.url='https://www.zzoc.cc'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
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
${COMMON_STYLE}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
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
.row{display:flex;gap:12px;background:rgba(255,255,255,.06);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;margin-bottom:10px;cursor:pointer}
.row:active{transform:scale(.98)}
.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}
.sposter img{width:100%;height:100%;object-fit:cover;display:block}
.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;padding:0}
.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;line-height:1.3}
.sintro{font-size:12px;color:rgba(255,255,255,.7);line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin:auto 0;min-height:0}
.smeta{font-size:11px;color:rgba(255,255,255,.55);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;margin-top:auto;padding-top:2px}
.sactors{font-size:12px;color:rgba(255,193,112,.85);line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px;flex-shrink:0}
.sbottom{display:flex;align-items:center;gap:8px;margin-top:6px;flex-shrink:0;flex-wrap:wrap}.sbottom-tag{font-size:10px;padding:2px 8px;border-radius:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sbottom-update{background:rgba(79,195,247,.15);color:#4fc3f7;border:1px solid rgba(79,195,247,.25)}.sbottom-rating{background:rgba(255,193,7,.15);color:#ffc107;border:1px solid rgba(255,193,7,.25)}.sbottom-hot{background:rgba(255,71,87,.15);color:#ff6b6b;border:1px solid rgba(255,71,87,.25)}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.7);font-size:13px}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap"><div class="tabs" id="tabs"></div><div id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var tabs=[{name:'排行榜',tab:0},{name:'最近热门',tab:1},{name:'近期热门',tab:2}];
var curTab=0,page=0,loading=false,finished=false,count=0,reqId=0;
function el(s){return document.querySelector(s)}
function initTabs(){var c=document.getElementById('tabs');tabs.forEach(function(t,i){var b=document.createElement('div');b.className='tab'+(i===0?' on':'');b.textContent=t.name;b.onclick=function(){document.querySelectorAll('.tab').forEach(function(x){x.className='tab'});b.className='tab on';curTab=t.tab;page=0;finished=false;count=0;loading=false;reqId++;el('#list').innerHTML='';load()};c.appendChild(b)})}
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url))item.url='https://www.zzoc.cc'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function cRow(it){var d=document.createElement('div');d.className='row';var topColors={'1':'rgba(255,71,87,.9)','2':'rgba(255,107,129,.9)','3':'rgba(255,165,2,.9)'};var topN=parseInt(it.top);var topBg=topColors[it.top]||(topN>=4?'rgba(255,255,255,.18)':'rgba(255,71,87,.9)');var sposter=document.createElement('div');sposter.className='sposter';var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';sposter.appendChild(img);if(it.top){var topEl=document.createElement('span');topEl.style.cssText='position:absolute;top:4px;left:4px;z-index:2;background:'+topBg+';color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px';topEl.textContent=it.top;sposter.appendChild(topEl)}if(it.note){var noteEl=document.createElement('span');noteEl.style.cssText='position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)';noteEl.textContent=it.note;sposter.appendChild(noteEl)}d.appendChild(sposter);var sinfo=document.createElement('div');sinfo.className='sinfo';var sname=document.createElement('div');sname.className='sname';sname.textContent=it.title;sinfo.appendChild(sname);if(it.actors){var sactors=document.createElement('div');sactors.className='sactors';sactors.textContent='\u{1F916} '+it.actors;sinfo.appendChild(sactors)}if(it.intro){var sintro=document.createElement('div');sintro.className='sintro';sintro.textContent=it.intro;sinfo.appendChild(sintro)}var parts=[];if(it.infoTime)parts.push(it.infoTime);if(it.score)parts.push('\u2B50 '+it.score);if(it.hits)parts.push('\uD83D\uDD25 '+it.hits);if(it.meta)parts.push(it.meta);if(parts.length){var sbottom=document.createElement('div');sbottom.className='sbottom';sbottom.innerHTML=parts.map(function(p){return'<span class="sbottom-item">'+p+'</span>'}).join('<span class="sbottom-sep"> | </span>');sinfo.appendChild(sbottom)}d.appendChild(sinfo);img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'};d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished)return;loading=true;var rid=reqId,next=page+1;el('#tip').textContent='加载中...';fetch('/rank-api?page='+next+'&tab='+curTab).then(r=>r.json()).then(function(j){if(!j.ok)throw new Error(j.error||'fail');if(!j.items.length){finished=true;el('#tip').textContent=count?'已全部加载':'暂无数据';return}if(rid!==reqId)return;page=next;var list=el('#list');if(curTab===0){var grid=list.querySelector('.grid2');if(!count){grid=document.createElement('div');grid.className='grid2';list.appendChild(grid)}var cats={};j.items.forEach(function(it){var cat=it.catTitle||'';if(!cats[cat])cats[cat]=[];cats[cat].push(it)});Object.keys(cats).forEach(function(cat){var card=document.createElement('div');card.className='cat-card';var catNameEl=document.createElement('div');catNameEl.className='cat-name';catNameEl.textContent=cat;card.appendChild(catNameEl);cats[cat].slice(0,5).forEach(function(it){var r=document.createElement('div');r.className='rit';var n=it.tag;var rn=document.createElement('div');rn.className='rn '+(n<=3?'t'+n:'');rn.textContent=n;r.appendChild(rn);var rt=document.createElement('div');rt.className='rt';rt.textContent=it.title;r.appendChild(rt);if(it.desc){var rs=document.createElement('div');rs.className='rs';rs.textContent=it.desc;r.appendChild(rs)}r.onclick=function(){openVod(it)};card.appendChild(r)});grid.appendChild(card)})}else{j.items.forEach(function(it){list.appendChild(cRow(it));count++})}count+=j.items.length;el('#tip').textContent='已加载 '+count+' 部';}).catch(function(e){if(rid!==reqId)return;loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败</span>'})}
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
.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px;background:rgba(255,255,255,.06);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sactors{font-size:12px;color:rgba(255,193,112,.85);line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px;flex-shrink:0}.smeta{font-size:12px;color:rgba(255,255,255,.7);margin-top:6px;line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}.sbottom{display:flex;align-items:center;gap:8px;margin-top:6px;flex-shrink:0;flex-wrap:wrap}.sbottom-tag{font-size:10px;padding:2px 8px;border-radius:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sbottom-update{background:rgba(79,195,247,.15);color:#4fc3f7;border:1px solid rgba(79,195,247,.25)}.sbottom-rating{background:rgba(255,193,7,.15);color:#ffc107;border:1px solid rgba(255,193,7,.25)}.sbottom-hot{background:rgba(255,71,87,.15);color:#ff6b6b;border:1px solid rgba(255,71,87,.25)}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap"><div class="topbar"><button class="back" onclick="history.back()">←</button><div class="toptitle">${esc(topicTitle)}</div></div><div class="title" id="title">${esc(topicTitle)}（0部）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var page=0,loading=false,finished=false,count=0;
var topicUrl=${safeUrl};
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url))item.url='https://www.zzoc.cc'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
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
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url))item.url='https://www.zzoc.cc'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
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
.sepi{font-size:12px;color:#4fc3f7;margin-top:4px}
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
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url))item.url='https://www.zzoc.cc'+item.url;if(item.playUrl){var _pu=item.playUrl;if(_pu.charAt(0)==='/')_pu='https://www.zzoc.cc'+_pu;try{parent.postMessage({type:'dsjHideChrome'},'*')}catch(e){}location.href='/player?url='+encodeURIComponent(_pu)+'&title='+encodeURIComponent(item.title||'')+'&vod='+encodeURIComponent(item.url);return}if(item.url){fetch('/api/parse-play?url='+encodeURIComponent(item.url)).then(function(r){return r.json()}).then(function(j){if(j.ok&&j.sources&&j.sources[0]&&j.sources[0].episodes&&j.sources[0].episodes.length){var ep=j.sources[0].episodes[0];var u=ep.url.charAt(0)==='/'?'https://www.zzoc.cc'+ep.url:ep.url;try{parent.postMessage({type:'dsjHideChrome'},'*')}catch(e){}location.href='/player?url='+encodeURIComponent(u)+'&title='+encodeURIComponent(ep.title||item.title||'')+'&vod='+encodeURIComponent(item.url)}else{try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}}).catch(function(){try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}});return}try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function timeAgo(ts){var d=Date.now()-ts;if(d<60000)return'刚刚';if(d<3600000)return Math.floor(d/60000)+'分钟前';if(d<86400000)return Math.floor(d/3600000)+'小时前';if(d<604800000)return Math.floor(d/86400000)+'天前';return new Date(ts).toLocaleDateString()}
function load(){
  fetch('/his-list').then(r=>r.json()).then(j=>{
    if(!j.ok||!j.items.length){el('#list').innerHTML='';el('#tip').textContent='暂无观看历史 🎬';return}
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
      if(it.episode){var sepi=document.createElement('div');sepi.className='sepi';sepi.textContent='▶ '+it.episode;sinfo.appendChild(sepi)}
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
.title{display:flex;align-items:center;justify-content:space-between;font-size:18px;font-weight:700;margin:4px 0 14px;min-height:36px}.title-text{flex:1;min-width:0}.title .back{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);box-shadow:0 2px 12px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1);color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0}.title .back:active{background:rgba(255,255,255,.2);transform:scale(.92)}.list{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px;background:rgba(255,255,255,.06);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;padding:0}.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;line-height:1.3}.sactors{font-size:12px;color:rgba(255,193,112,.85);line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px;flex-shrink:0}.sintro{font-size:12px;color:rgba(255,255,255,.7);line-height:1.4;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;margin:auto 0;min-height:0}.smeta{font-size:11px;color:rgba(255,255,255,.55);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;margin-top:auto;padding-top:2px}.sbottom{display:flex;align-items:center;gap:10px;margin-top:6px;flex-shrink:0;font-size:11px;color:rgba(255,255,255,.45);line-height:1.3}.sbottom-item{display:flex;align-items:center;gap:3px}.sbottom-sep{color:rgba(255,255,255,.2)}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>${COMMON_ANTI_COPY}
<div class="wrap"><div class="title"><div class="title-text" id="titleText">搜索「${esc(wd)}」（0个）</div><button class="back" onclick="goBack()">←</button></div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var wd=${JSON.stringify(wd||'')},page=0,loading=false,finished=false,count=0;
function el(s){return document.querySelector(s)}
function goBack(){try{parent.postMessage({type:'searchBack'},'*')}catch(e){history.back()}}
function openVod(it){var item=Object.assign({},it);if(!/^https?:/.test(item.url))item.url='https://www.zzoc.cc'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function row(it){var d=document.createElement('div');d.className='row';var sposter=document.createElement('div');sposter.className='sposter';var img=document.createElement('img');img.loading='lazy';img.src=it.img||'';sposter.appendChild(img);if(it.tag){var tagEl=document.createElement('span');tagEl.className='sptext';tagEl.textContent=it.tag;sposter.appendChild(tagEl)}d.appendChild(sposter);var sinfo=document.createElement('div');sinfo.className='sinfo';var sname=document.createElement('div');sname.className='sname';sname.textContent=it.title;sinfo.appendChild(sname);if(it.actors){var sactors=document.createElement('div');sactors.className='sactors';sactors.textContent='\u{1F916} '+it.actors;sinfo.appendChild(sactors)}if(it.intro){var sintro=document.createElement('div');sintro.className='sintro';sintro.textContent=it.intro;sinfo.appendChild(sintro)}var parts=[];if(it.infoTime)parts.push(it.infoTime);if(it.score)parts.push('\u2B50 '+it.score);if(it.hits)parts.push('\uD83D\uDD25 '+it.hits);if(it.meta)parts.push(it.meta);if(parts.length){var sbottom=document.createElement('div');sbottom.className='sbottom';sbottom.innerHTML=parts.map(function(p){return'<span class="sbottom-item">'+p+'</span>'}).join('<span class="sbottom-sep"> | </span>');sinfo.appendChild(sbottom)}d.appendChild(sinfo);img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'};d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished||!wd)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/search-api?wd='+encodeURIComponent(wd)+'&page='+next).then(r=>r.json()).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'未找到匹配内容';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#titleText').textContent='搜索「'+wd+'」（'+count+'个）';el('#tip').textContent='已加载 '+count+' 个。'}).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)}).finally(()=>loading=false)}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
<\/script></body></html>`;
}

// ========== TMDB详情页HTML ==========
function tmdbPageHtml(d, vodUrl, fallbackImg, cachedSources) {
  const fullUrl = vodUrl && /^https?:/.test(vodUrl) ? vodUrl : vodUrl && /^[a-z]+:\/\//.test(vodUrl) ? vodUrl : vodUrl ? 'https://www.zzoc.cc' + vodUrl : vodUrl;
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
var VOD_URL='${fullUrl.replace(/'/g, "\\'")}',SITE='https://www.zzoc.cc';
var playSources=${cachedSources?JSON.stringify(cachedSources):'[]'},curSrc=0,showAll=false,curEpUrl='';
try{var _cached=JSON.parse(localStorage.getItem('youzi_tmdb_state')||'null');if(_cached&&_cached.vodUrl===VOD_URL){curEpUrl=_cached.curEpUrl||'';curSrc=typeof _cached.curSrc==='number'?_cached.curSrc:0}}catch(e){}
function playFirst(){
  if(playSources.length){
    var src=playSources[curSrc];
    if(src&&src.episodes&&src.episodes.length){
      var epIdx=0;
      if(curEpUrl){for(var _i=0;_i<src.episodes.length;_i++){if(src.episodes[_i].url===curEpUrl||decodeURIComponent(src.episodes[_i].url)===curEpUrl){epIdx=_i;break}}}
      var ep=src.episodes[epIdx];curEpUrl=ep.url;
      var u=ep.url.charAt(0)==='/'?SITE+ep.url:ep.url;
      try{localStorage.setItem('youzi_tmdb_state',JSON.stringify({vodUrl:VOD_URL,curEpUrl:ep.url,curSrc:curSrc}))}catch(e){}
      try{var _t=document.querySelector('.info .t'),_b=document.querySelector('.bg img'),_hi=document.getElementById('_hi');var _mt=_t&&_t.textContent?_t.textContent:(document.title||ep.title);sessionStorage.setItem('youzi_tmdb_meta_'+VOD_URL,JSON.stringify({title:_mt,backdrop:_b?_b.src:'',img:_hi?_hi.dataset.img:''}))}catch(e){}
      window.location.href='/player?url='+encodeURIComponent(u)+'&title='+encodeURIComponent(ep.title)+'&vod='+encodeURIComponent(VOD_URL);
      return;
    }
  }
  loadPlay()
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
function playerHtml(playUrl, title, vodUrl) {
  const safeTitle = esc(title || '播放');
  const safePlayUrl = esc(playUrl || '');
  const safeVodUrl = esc(vodUrl || '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<title>${safeTitle}</title>
<script src="https://unpkg.com/hls.js@1.5.7/dist/hls.min.js"><\/script>
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
  <div class=title id=vTitle>${safeTitle}</div>
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
    <div class=fs-title id=fsTitle>${safeTitle}</div>
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
var PLAY_URL='${safePlayUrl}',VOD_URL='${safeVodUrl}',SITE='https://www.zzoc.cc';
var video=document.getElementById('video');
var MOVIE_TITLE='${safeTitle}';
var hls=null,curSpeed=1,speeds=[0.5,0.75,1,1.25,1.5,2],speedIdx=2;
var controlsTimer=null;

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
      _doPlay(vurl);
    }else{_hideLoader();showError(j.error||'解析失败')}
  }).catch(function(e){_hideLoader();showError('解析失败: '+e.message)});
}
function _doPlay(url){
  if(hls){hls.destroy();hls=null}
  video.src='';
  if(!url){showError('无播放地址');return}
  // 新站加密地址：使用解析服务 iframe
  if(url.indexOf('/')===-1&&url.indexOf('.')===-1&&url.length>60){
    var parseUrl='https://xn--qvr2v.850088.xyz/player/?url='+encodeURIComponent(url)+'&next=&title='+encodeURIComponent(document.title.split('-')[0]);
    var pw=document.getElementById('playerWrap');
    pw.innerHTML='<iframe src="'+parseUrl+'" width="100%" height="100%" allowfullscreen="true" frameborder="0" scrolling="no" style="border:0;width:100%;height:100%"></iframe>';
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
    return;
  }
  // ixigua CDN 需要通过服务端代理（Referer 403）
  if(url.indexOf('ixigua.com')>-1){
    url='/play-stream?url='+encodeURIComponent(url);
  }
  video.onerror=function(){showError('视频加载失败 code='+video.error.code)};
  // 格式判断：优先用后缀，代理URL(/play-stream?url=xxx.m3u8)从原始参数提取后缀
  var ext='';
  if(url.indexOf('/play-stream?url=')>-1){
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
    video.src=url;video.addEventListener('loadedmetadata',function(){_autoPlay()},{once:true});
  }
  document.getElementById('sourceInfo').textContent='正在加载...';
}
function showError(msg){document.getElementById('sourceInfo').innerHTML='<span style="color:#ff6b6b">'+msg+'</span>'}
function _autoPlay(){video.muted=true;video.play().catch(function(){});_restoreProgress();video.addEventListener('playing',function _unmute(){video.removeEventListener('playing',_unmute);setTimeout(function(){video.muted=false},300)},{once:true})}
function _restoreProgress(){if(!VOD_URL)return;var _hti=VOD_URL.replace(/[^a-zA-Z0-9]/g,'_');var _epIdx=getCurrentEpIdx();fetch('/his-list').then(function(r){return r.json()}).then(function(j){if(!j.ok||!j.items)return;var h=null;for(var i=0;i<j.items.length;i++){if(j.items[i].id===_hti){h=j.items[i];break}}if(!h||!h.progress||!h.duration)return;if(h.episode!==undefined&&h.episode!==''&&String(_epIdx)!==h.episode)return;if(h.progress<h.duration-5&&h.progress>5){video.currentTime=h.progress}}).catch(function(){})}
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
    var _hTitle=_hMovieName||MOVIE_TITLE||'';
    window._hisTitle=_hTitle;window._hisImg=_hImg;
    fetch('/his-add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:_hti,title:_hTitle,url:VOD_URL||'',img:_hImg,source:'zzoc.cc',playUrl:PLAY_URL||'',episode:MOVIE_TITLE||''})}).catch(function(){})
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
    fetch('/his-add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:_hti,progress:Math.floor(video.currentTime),duration:Math.floor(video.duration),lastWatch:Date.now(),episode:_epTitle})}).catch(function(){})
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
  try{var _c=JSON.parse(sessionStorage.getItem('youzi_ep_'+VOD_URL)||'null');if(_c&&_c.sources&&_c.sources.length>1){pSources=_c.sources;pCurSrc=_matchSrcIdx();renderSrcTabs();renderEpList();return}}catch(e){}
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
      initPlayer(vurl);
    }else{
      _hideLoader();showError('[4] 失败: '+(j.error||'无地址'));
    }
  }).catch(function(e){_hideLoader();showError('[4] fetch失败: '+e.message)});
}

// ===== 返回按钮 =====
document.getElementById('backBtn').onclick=function(){try{parent.postMessage({type:'dsjShowChrome'},'*')}catch(e){}history.back()};
// ===== 上集/下集/选集/旋转 =====
function _normUrl(u){try{u=decodeURIComponent(u)}catch(e){}var d=document.createElement('div');d.innerHTML=u;var r=d.textContent;return r||u}function getCurrentEpIdx(){var src=pSources&&pSources[pCurSrc||0];if(!src||!src.episodes)return-1;var _pu=_normUrl(PLAY_URL);for(var i=0;i<src.episodes.length;i++){var eu=src.episodes[i].url.charAt(0)==='/'?SITE+src.episodes[i].url:src.episodes[i].url;if(_normUrl(eu)===_pu||_pu===src.episodes[i].url||_pu.indexOf(src.episodes[i].url)>-1||src.episodes[i].url.indexOf(PLAY_URL)>-1)return i}return-1}
function switchEp(dir){_clearAutoNext();if(!pSources||!pSources.length)return;var src=pSources[pCurSrc||0];if(!src||!src.episodes)return;var idx=getCurrentEpIdx();var next=idx+dir;if(next<0||next>=src.episodes.length)return;var ep=src.episodes[next];var u=ep.url.charAt(0)==='/'?SITE+ep.url:ep.url;try{sessionStorage.setItem('youzi_ep_'+VOD_URL,JSON.stringify({sources:pSources}))}catch(e){}
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
function _renderFsEpisodes(panel){panel.innerHTML='';if(!pSources||!pSources.length){panel.innerHTML='<div style="color:rgba(255,255,255,.5);padding:10px">无集数</div>';return}var src=pSources[pCurSrc||0]||pSources[0];if(!src||!src.episodes)return;src.episodes.forEach(function(ep){var b=document.createElement('span');b.className='ep-item';b.textContent=ep.title;var _pu=_normUrl(PLAY_URL);var _eu=ep.url.charAt(0)==='/'?SITE+ep.url:ep.url;if(_normUrl(_eu)===_pu||_pu===ep.url)b.classList.add('on');b.onclick=function(){panel.classList.remove('show');location.replace('/player?url='+encodeURIComponent(ep.url)+'&title='+encodeURIComponent(ep.title)+'&vod='+encodeURIComponent(VOD_URL))};panel.appendChild(b)})}
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
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://0.0.0.0:${PORT}`);
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (pathname === '/health') return send(res, 200, 'ok');

  if (pathname === '/shutdown') {
    send(res, 200, 'shutting down');
    setTimeout(() => { try { server.close(); } catch(e) {} cache.clear(); }, 200);
    return;
  }

  // 首页数据
  if (pathname === '/home-api') return handleHomeApi(res);

    // 电视直播播放器页面
  if (pathname === '/live-player') {
    var livePage = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;touch-action:none}video{width:100%;height:100%;object-fit:contain;background:#000}.topbar{position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;padding:0 10px;background:linear-gradient(180deg,rgba(0,0,0,.85) 0%,transparent 100%);z-index:100;transition:opacity .3s}.topbar.hide{opacity:0;pointer-events:none}.topbar button{width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}.topbar .t{color:#fff;font-size:14px;font-weight:600;margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}.route-btn{padding:3px 10px;border-radius:12px;background:rgba(79,195,247,.2);border:1px solid rgba(79,195,247,.4);color:#4fc3f7;font-size:11px;cursor:pointer;margin-left:6px;white-space:nowrap;flex-shrink:0;display:flex;align-items:center;gap:3px}.route-btn:active{background:rgba(79,195,247,.35)}.route-overlay{position:fixed;inset:0;z-index:200;animation:fadeIn .15s}.route-bg{position:absolute;inset:0;background:rgba(0,0,0,.4)}.route-panel{position:absolute;top:44px;right:8px;width:180px;max-height:55vh;background:rgba(18,18,28,.96);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:12px;border:1px solid rgba(255,255,255,.1);box-shadow:0 8px 32px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden}.route-header{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between}.route-header .rh-title{color:#fff;font-size:13px;font-weight:700}.route-header .rh-close{width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.08);border:none;color:#aaa;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center}.route-list{overflow-y:auto;padding:4px;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}.route-item{display:flex;align-items:center;padding:8px 10px;border-radius:8px;cursor:pointer;margin-bottom:2px;transition:background .12s;gap:8px}.route-item:active{background:rgba(255,255,255,.06)}.route-item.cur{background:rgba(79,195,247,.15)}.route-item .ri-idx{width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.06);color:rgba(255,255,255,.5);font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;flex-shrink:0}.route-item.cur .ri-idx{background:rgba(79,195,247,.3);color:#4fc3f7}.route-item .ri-name{flex:1;color:#bbb;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.route-item.cur .ri-name{color:#4fc3f7;font-weight:600}.route-item .ri-dot{width:6px;height:6px;border-radius:50%;background:transparent;flex-shrink:0}.route-item.cur .ri-dot{background:#4fc3f7}.ctrlbar{position:fixed;bottom:0;left:0;right:0;height:48px;display:flex;align-items:center;padding:0 10px;gap:8px;background:linear-gradient(0deg,rgba(0,0,0,.85) 0%,transparent 100%);z-index:100;transition:opacity .3s}.ctrlbar.hide{opacity:0;pointer-events:none}.ctrl-btn{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}.progress-wrap{flex:1;height:20px;display:flex;align-items:center;cursor:pointer;position:relative;min-width:0}.progress-bg{width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,.15);position:relative;overflow:hidden}.progress-buffer{position:absolute;left:0;top:0;height:100%;background:rgba(255,255,255,.2);border-radius:2px}.progress-fill{position:absolute;left:0;top:0;height:100%;background:#4fc3f7;border-radius:2px}.progress-dot{position:absolute;top:50%;width:12px;height:12px;border-radius:50%;background:#4fc3f7;transform:translate(-50%,-50%);box-shadow:0 0 4px rgba(79,195,247,.5);opacity:0;transition:opacity .15s}.progress-wrap:hover .progress-dot,.progress-wrap.dragging .progress-dot{opacity:1}.time-label{color:rgba(255,255,255,.7);font-size:11px;white-space:nowrap;flex-shrink:0;min-width:70px;text-align:center}.vol-wrap{display:flex;align-items:center;gap:4px;flex-shrink:0}.vol-icon{color:rgba(255,255,255,.7);font-size:14px;cursor:pointer;width:24px;text-align:center}.vol-bar{width:60px;height:4px;border-radius:2px;background:rgba(255,255,255,.15);cursor:pointer;position:relative}.vol-fill{height:100%;border-radius:2px;background:#4fc3f7;width:100%}.vol-dot{position:absolute;top:50%;width:10px;height:10px;border-radius:50%;background:#4fc3f7;transform:translate(-50%,-50%);right:0;box-shadow:0 0 3px rgba(79,195,247,.4);opacity:0;transition:opacity .15s}.vol-wrap:hover .vol-dot{opacity:1}.loading{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:90;background:rgba(0,0,0,.5);touch-action:none}.spinner{width:36px;height:36px;border:3px solid rgba(255,255,255,.15);border-top-color:#4fc3f7;border-radius:50%;animation:spin .8s linear infinite}.load-text{color:rgba(255,255,255,.7);font-size:13px;margin-top:10px}@keyframes spin{to{transform:rotate(360deg)}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}.channel-toast{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.85);color:#fff;padding:16px 24px;border-radius:12px;font-size:14px;z-index:150;pointer-events:none;opacity:0;transition:opacity .3s;text-align:center;max-width:80vw;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}.channel-toast.show{opacity:1}.swipe-hint{position:fixed;right:16px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;z-index:120;opacity:0;transition:opacity .4s;pointer-events:none}.swipe-hint.show{opacity:.5}.swipe-arrow{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:16px;display:flex;align-items:center;justify-content:center}.swipe-label{color:rgba(255,255,255,.5);font-size:9px;text-align:center}</style></head><body><div class="topbar" id="topbar"><button id="bb">‹</button><div class="t" id="tt"></div><div class="route-btn" id="routeBtn" style="display:none">📡 总线路</div></div><div class="loading" id="loading"><div class="spinner"></div><div class="load-text">正在加载...</div></div><video id="v" autoplay muted playsinline webkit-playsinline></video><div class="channel-toast" id="chToast"></div><div class="swipe-hint" id="swipeHint"><div class="swipe-arrow">▲</div><div class="swipe-label">上一个</div><div class="swipe-arrow" style="margin-top:24px">▼</div><div class="swipe-label">下一个</div></div><div class="ctrlbar" id="ctrlbar"><div class="ctrl-btn" id="playBtn">▶</div><div class="progress-wrap" id="progressWrap"><div class="progress-bg"><div class="progress-buffer" id="pBuffer"></div><div class="progress-fill" id="pFill"></div></div><div class="progress-dot" id="pDot"></div></div><div class="time-label" id="timeLabel">00:00 / 00:00</div><div class="vol-wrap"><div class="vol-icon" id="volIcon">🔊</div><div class="vol-bar" id="volBar"><div class="vol-fill" id="volFill"></div><div class="vol-dot" id="volDot"></div></div></div><div class="ctrl-btn" id="fsBtn" style="font-size:14px">⛶</div></div><script src="https://unpkg.com/hls.js@1.5.7/dist/hls.min.js"><\/script><script>
var v=document.getElementById("v"),tt=document.getElementById("tt"),topbar=document.getElementById("topbar"),ctrlbar=document.getElementById("ctrlbar"),routeBtn=document.getElementById("routeBtn");
var playBtn=document.getElementById("playBtn"),pFill=document.getElementById("pFill"),pDot=document.getElementById("pDot"),pBuffer=document.getElementById("pBuffer"),progressWrap=document.getElementById("progressWrap");
var timeLabel=document.getElementById("timeLabel"),volIcon=document.getElementById("volIcon"),volFill=document.getElementById("volFill"),volBar=document.getElementById("volBar"),volDot=document.getElementById("volDot");
var allUrls=[],curIdx=0,h=null,LP="http://127.0.0.1:9976/live-proxy?url=";
var channelList=[],channelIdx=0;
var loadingEl=document.getElementById("loading");
var chToast=document.getElementById("chToast");
try{var d=parent._livePlayData;if(d){tt.textContent=d.title||"";allUrls=d.urls||[];channelList=d.channels||[];channelIdx=d.channelIdx||0;parent._livePlayData=null}}catch(e){}
try{parent.postMessage({type:'dsjHideChrome'},'*')}catch(e){}
document.getElementById("bb").onclick=function(){try{parent.postMessage({type:'dsjShowChrome'},'*')}catch(e){}try{parent.postMessage({type:'liveClose'},'*')}catch(e){}};
function _liveAutoPlay(){v.muted=true;v.play().catch(function(){});v.addEventListener("playing",function _ulp(){v.removeEventListener("playing",_ulp);if(loadingEl)loadingEl.style.display="none";setTimeout(function(){v.muted=false},300)},{once:true})}
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
function destroyHls(){if(h){try{h.destroy()}catch(e){}h=null}if(_mp4ProgTimer){clearInterval(_mp4ProgTimer);_mp4ProgTimer=null}}
function playUrl(url){destroyHls();if(loadingEl){loadingEl.style.display="flex";loadingEl.style.pointerEvents="none";loadingEl.innerHTML='<div class="spinner"></div><div class="load-text" id="loadText">正在加载...</div>'}v.muted=true;v.removeAttribute("src");v.load();var useProxy=true;var playUrlFinal=useProxy?LP+encodeURIComponent(url):url;var _ltEl=document.getElementById("loadText");var _rawUrl=(url||"").toLowerCase();var _isMp4=_rawUrl.indexOf(".mp4")>-1||_rawUrl.indexOf(".mkv")>-1||_rawUrl.indexOf(".flv")>-1||_rawUrl.indexOf(".avi")>-1;if(_isMp4){v.preload="auto";v.src=playUrlFinal;var _mp4Started=false;var _onCanPlay=function(){if(_mp4Started)return;_mp4Started=true;_liveAutoPlay()};v.addEventListener("canplay",_onCanPlay,{once:true});v.addEventListener("loadedmetadata",function(){if(_ltEl&&v.duration&&isFinite(v.duration)){_ltEl.textContent="准备播放..."}},{once:true});_mp4ProgTimer=setInterval(function(){if(v.buffered&&v.buffered.length>0&&v.duration&&isFinite(v.duration)){var bf=Math.round(v.buffered.end(v.buffered.length-1)/v.duration*100);if(_ltEl)_ltEl.textContent="缓冲中 "+bf+"%";if(bf>=3&&!_mp4Started){_mp4Started=true;_liveAutoPlay()}}},300);setTimeout(function(){if(!_mp4Started){_mp4Started=true;if(v.readyState>=2){_liveAutoPlay()}else{v.play().catch(function(){})}}},8000)}else if(typeof Hls!=="undefined"&&Hls.isSupported()){h=new Hls({liveSyncDurationCount:3,liveMaxLatencyDurationCount:6,maxBufferLength:10,maxMaxBufferLength:20,maxBufferHole:0.5,enableWorker:true,lowLatencyMode:true,backBufferLength:10,startLevel:-1,startFragPrefetch:true,fragLoadingRetry:6,fragLoadingMaxRetryTimeout:64000,manifestLoadingRetry:3,levelLoadingRetry:3,xhrSetup:function(x){x.withCredentials=false}});h.loadSource(playUrlFinal);h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,function(){_liveAutoPlay()});h.on(Hls.Events.FRAG_LOADED,function(e,d){if(!d||!d.frag||!_ltEl)return;var stats=d.frag.stats||{};var loaded=d.frag.loaded||(stats.total?stats.total:0);if(!loaded)return;var t1=stats.loading?stats.loading.start:0;var t2=stats.loading?stats.loading.end:0;if(!t1||!t2)return;var _kb=Math.round(loaded/1024);var _sec=(t2-t1)/1000;if(_sec<=0)return;var _kbs=Math.round(_kb/_sec);if(_kbs>0)_ltEl.textContent=_kbs>=1024?(_kbs/1024).toFixed(1)+" MB/s":_kbs+" KB/s"});h.on(Hls.Events.ERROR,function(e,d){if(d.fatal){if(d.type===Hls.ErrorTypes.NETWORK_ERROR){destroyHls();try{v.src=playUrlFinal;v.addEventListener("loadedmetadata",function(){_liveAutoPlay()},{once:true})}catch(e2){}}else if(d.type===Hls.ErrorTypes.MEDIA_ERROR){h.recoverMediaError()}else{destroyHls();try{v.src=playUrlFinal}catch(e2){}}}})}else{v.src=playUrlFinal;v.addEventListener("loadedmetadata",function(){_liveAutoPlay()},{once:true})}}
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
function _switchChannel(newIdx){if(newIdx<0||newIdx>=channelList.length||newIdx===channelIdx)return;channelIdx=newIdx;var ch=channelList[channelIdx];if(!ch)return;allUrls=ch.urls||[];curIdx=0;tt.textContent=ch.n||"";if(allUrls.length>1){routeBtn.style.display="flex";routeBtn.textContent="\uD83D\uDEE0\uFE0F 1/"+allUrls.length;routeBtn.onclick=function(ev){ev.stopPropagation();showRoutePanel()}}else{routeBtn.style.display="none"}playUrl(allUrls[0]);_showChToast(ch.n||("频道"+(channelIdx+1)))}
function _nextChannel(){if(channelList.length<=1)return;var next=channelIdx+1;if(next>=channelList.length)next=0;_switchChannel(next)}
function _prevChannel(){if(channelList.length<=1)return;var prev=channelIdx-1;if(prev<0)prev=channelList.length-1;_switchChannel(prev)}
/* ========== 触摸/点击事件绑定（绑定到document，确保loading等遮罩层也能响应滑动） ========== */
function _isUIEl(t){return t.closest('#routeOverlay,#ctrlbar,#topbar,.route-btn,.route-overlay')}
document.addEventListener("touchstart",function(e){if(_isUIEl(e.target))return;if(e.touches.length===1){swipeStartY=e.touches[0].clientY;swipeStartX=e.touches[0].clientX;swipeActive=true;swipeTriggered=false}},{passive:true});
document.addEventListener("touchmove",function(e){if(!swipeActive||e.touches.length!==1)return;var dy=e.touches[0].clientY-swipeStartY;var dx=e.touches[0].clientX-swipeStartX;if(!swipeTriggered&&Math.abs(dy)>60&&Math.abs(dy)>Math.abs(dx)*1.5){swipeTriggered=true;swipeActive=false;if(dy<0){_nextChannel()}else{_prevChannel()}}if(!swipeTriggered&&v.duration&&isFinite(v.duration)&&Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5){swipeTriggered=true;swipeActive=false;var sec=Math.min(120,Math.round(Math.abs(dx)/20)*10);if(dx>0){v.currentTime=Math.min(v.duration,v.currentTime+sec);_liveToast('快进'+sec+'秒')}else{v.currentTime=Math.max(0,v.currentTime-sec);_liveToast('快退'+sec+'秒')}showControls()}},{passive:true});
document.addEventListener("touchend",function(e){if(_isUIEl(e.target)){swipeActive=false;return}swipeActive=false;if(swipeTriggered)return;var now=Date.now();if(now-lastTapTime<300){if(singleTapTimer){clearTimeout(singleTapTimer);singleTapTimer=null}lastTapTime=0;_onDoubleTap()}else{lastTapTime=now;singleTapTimer=setTimeout(function(){_onTap();singleTapTimer=null;lastTapTime=0},300)}},{passive:false});
document.addEventListener("mousemove",function(){showControls()});
/* ========== 显示滑动提示（3秒后自动隐藏） ========== */
if(channelList.length>1){var swipeHint=document.getElementById("swipeHint");if(swipeHint){swipeHint.classList.add("show");setTimeout(function(){swipeHint.classList.remove("show")},3000)}}
if(allUrls.length>0)playUrl(allUrls[0]);
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
        var data = JSON.parse(body3);
        if (typeof data !== 'object' || Array.isArray(data)) {
          return send(res, 200, JSON.stringify({ok:false,error:'格式错误'}), 'application/json; charset=utf-8');
        }
        var total = 0;
        var cats = Object.keys(data);
        for (var i = 0; i < cats.length; i++) { if (Array.isArray(data[cats[i]])) total += data[cats[i]].length; }
        var jsonStr = JSON.stringify(data);
        var jsonPath = require('path').join(__dirname, 'live_channels.json');
        fs.writeFileSync(jsonPath, jsonStr, 'utf-8');
        send(res, 200, JSON.stringify({ok:true,total:total,cats:cats.length}), 'application/json; charset=utf-8');
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
          timeout: 15000
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
              'Cache-Control': 'public, max-age=86400'
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
    const mod = imgUrl.startsWith('https') ? https : http;
    const imgReq = mod.request(imgUrl, { method:'GET', headers:{'User-Agent':'Mozilla/5.0','Referer':SITE+'/'}, timeout:10000 }, imgRes => {
      if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
        // 跟随重定向
        const redir = imgRes.headers.location.startsWith('http') ? imgRes.headers.location : SITE + imgRes.headers.location;
        imgRes.resume();
        const mod2 = redir.startsWith('https') ? https : http;
        const r2 = mod2.request(redir, {method:'GET',headers:{'User-Agent':'Mozilla/5.0','Referer':SITE+'/'},timeout:10000}, r2Res => {
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
    const cid = u.searchParams.get('cid') || 'dianying';
    const filter = u.searchParams.get('filter') || '';
    const page = parseInt(u.searchParams.get('page') || '1');
    // zzoc.cc: /vodshow/{cid}---{filter}-----{page}---.html
    const cidMap = { 'dianying': '1', '2': '2', 'zongyi': '3', 'dongman': '4', '20': '20' };
    const typeId = cidMap[cid] || cid;
    const url = `${SITE}/vodshow/${typeId}---${filter}-----${page > 1 ? page : ''}---.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const items = parseCards(html);
      let filters = null;
      if (page <= 1) filters = parseTypeFilters(html);
      send(res, 200, JSON.stringify({ok:true, items, filters}), 'application/json');
    });
  }

  // 分类页
  if (pathname === '/category') {
    const cid = u.searchParams.get('cid') || 'dianying';
    const name = u.searchParams.get('name') || '电影';
    return send(res, 200, categoryHtml(cid, name), 'text/html; charset=utf-8');
  }

  // 搜索API
  if (pathname === '/search-api') {
    const wd = u.searchParams.get('wd') || '';
    const page = parseInt(u.searchParams.get('page') || '1', 10);
    const url = page <= 1
      ? `${SITE}/vodsearch/-------------.html?wd=${encodeURIComponent(wd)}`
      : `${SITE}/vodsearch/${encodeURIComponent(wd)}----------${page}---.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const items = parseCardItems(html);
      send(res, 200, JSON.stringify({ok:true, items}), 'application/json');
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
    const url = page <= 1 ? `${SITE}/label/hot.html` : `${SITE}/label/hot/page/${page}.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const tabs = splitTabs(html);
      let items = [];
      if (tab === 0) items = parseRankItems(tabs[0] || html);
      else if (tab === 1 && tabs.length > 1) items = parseCardItems(tabs[1]);
      else if (tab === 2 && tabs.length > 2) items = parseCardItems(tabs[2]);
      else items = parseRankItems(tabs[0] || html);
      send(res, 200, JSON.stringify({ok:true, items, tabCount: tabs.length}), 'application/json');
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
    // 原有 youzisp 数据源
    const fullUrl = /^https?:/.test(vodUrl) ? vodUrl : SITE + vodUrl;
    if (!isSafeUrl(fullUrl)) return send(res, 403, JSON.stringify({ok:false,error:'url not allowed'}), 'application/json');
    return fetchPage(fullUrl, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}), 'application/json');
      try {
        const sources = parsePlaySources(html);
        if(sources&&vodUrl){_playDataCache.set(vodUrl,sources)}
        send(res, 200, JSON.stringify({ok:true, sources}), 'application/json');
      } catch(e) {
        send(res, 200, JSON.stringify({ok:false,error:e.message}), 'application/json');
      }
    });
  }

  // 视频流代理（解决 ixigua Referer 403）
  if (pathname === '/play-stream') {
    const videoUrl = u.searchParams.get('url') || '';
    if (!videoUrl || !/^https?:/.test(videoUrl)) return send(res, 400, 'bad url');
    const mod = videoUrl.startsWith('https') ? https : http;
    const proxyReq = mod.request(videoUrl, { method:'GET', headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}, timeout:30000 }, proxyRes => {
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

  // 播放器页面
  if (pathname === '/player') {
    const playUrl = u.searchParams.get('url') || '';
    const title = u.searchParams.get('title') || '';
    const vodUrl = u.searchParams.get('vod') || '';
    return send(res, 200, playerHtml(playUrl, title, vodUrl), 'text/html; charset=utf-8');
  }

  // 解析播放页真实地址 API
  if (pathname === '/api/play-url') {
    const playUrl = u.searchParams.get('url') || '';
    const direct = u.searchParams.get('direct') || '';
    if (!playUrl) return send(res, 200, JSON.stringify({ok:false,error:'missing url'}), 'application/json');
    // 直播URL（direct=1 或 .m3u8/.mp4/.flv等）直接返回，不走解析
    if (direct === '1' || /^https?:\/\/.+\.(m3u8|mp4|flv|ts|aac)(\?|$)/i.test(playUrl)) {
      return send(res, 200, JSON.stringify({ok:true, data:{url:playUrl, encrypt:0}}), 'application/json');
    }
    // 原有 youzisp 播放地址解析
    const fullPlayUrl = /^https?:/.test(playUrl) ? playUrl : SITE + playUrl;
    if (!isSafeUrl(fullPlayUrl)) return send(res, 403, JSON.stringify({ok:false,error:'url not allowed'}), 'application/json');
    return fetchPage(fullPlayUrl, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}), 'application/json');
      try {
        // 从播放页提取 player_aaaa 变量中的真实播放地址
        const playerMatch = html.match(/var player_aaaa\s*=\s*([\s\S]+?)<\/script/);
        if (playerMatch) {
          const playerData = JSON.parse(playerMatch[1]);
          // 跟随 m3u8 重定向
          if (playerData.url && /^https?:/.test(playerData.url)) {
            const mod = playerData.url.startsWith('https') ? https : http;
            const headReq = mod.request(playerData.url, {method:'HEAD',headers:{'User-Agent':'Mozilla/5.0'},timeout:8000}, headRes => {
              if (headRes.statusCode >= 300 && headRes.statusCode < 400 && headRes.headers.location) {
                playerData.url = headRes.headers.location.startsWith('http') ? headRes.headers.location : headRes.headers.location;
              }
              headRes.resume();
              send(res, 200, JSON.stringify({ok:true, data:playerData}), 'application/json');
            });
            headReq.on('error', () => send(res, 200, JSON.stringify({ok:true, data:playerData}), 'application/json'));
            headReq.end();
          } else {
            send(res, 200, JSON.stringify({ok:true, data:playerData}), 'application/json');
          }
        } else {
          send(res, 200, JSON.stringify({ok:true, data:{url:'',flag:''}}), 'application/json');
        }
      } catch(e) {
        send(res, 200, JSON.stringify({ok:false,error:e.message}), 'application/json');
      }
    });
  }

  // TMDB详情页
  if (pathname === '/tmdb-page') {
    if (!TMDB_KEY) return send(res, 200, '<h1>TMDB API Key not configured</h1><p>Please set TMDB_KEY environment variable</p>', 'text/html; charset=utf-8');
    const title = u.searchParams.get('title') || '';
    const vodUrl = u.searchParams.get('url') || '';
    let img = u.searchParams.get('img') || '';
    if(!img&&vodUrl){img=_imgCache.get(vodUrl)||''}
    if(img&&vodUrl){_imgCache.set(vodUrl,img)}

    // 如果有完整的页面缓存，直接返回（返回时秒开，不重新搜索 TMDB）
    var _cachedPage=_pageCache.get(vodUrl);
    if(_cachedPage){return send(res,200,_cachedPage,'text/html; charset=utf-8')}
    var cachedSources=null;var _pc=_playDataCache.get(vodUrl);if(_pc)cachedSources=_pc;
    const fullVodUrl = vodUrl && /^https?:/.test(vodUrl) ? vodUrl : vodUrl && /^[a-z]+:\/\//.test(vodUrl) ? vodUrl : vodUrl ? 'https://www.zzoc.cc' + vodUrl : vodUrl;
    const clean = title.replace(/\(?\d{4}\)?$/,'').replace(/第\d+集$/,'').trim();
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
  d.onclick=function(){parent.postMessage({type:'dsjSearch',query:w.title},'*')};
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
      try { const item = JSON.parse(body); send(res, 200, JSON.stringify(hisAdd(item)), 'application/json'); }
      catch(e) { send(res, 400, '{"ok":false}'); }
    });
    return;
  }

  if (pathname === '/his-list') {
    return send(res, 200, JSON.stringify({ ok: true, items: hisList() }), 'application/json');
  }

  if (pathname === '/his-clear') {
    return send(res, 200, JSON.stringify(hisClear()), 'application/json');
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
    favAdd({ id, title, url, img, source: 'zzoc.cc' });
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


  send(res, 404, 'Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[zzoc.cc-proxy] http://0.0.0.0:${PORT}`);
  const keySource = process.env.TMDB_KEY ? 'env' : (fs.existsSync(_TMDB_CONFIG_FILE) ? 'config' : 'default');
  console.log(`[zzoc.cc-proxy] http://0.0.0.0:${PORT} | TMDB key: ${keySource}`);});