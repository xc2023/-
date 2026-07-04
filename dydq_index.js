const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 9977;
const SITE = 'https://www.youzisp.tv';
const TMDB_KEY = '304ca56b1b7b57ca7a47d9b59946be94';
const TMDB_BASE = 'https://api.tmdb.org/3';
const cache = new Map();

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
  list.unshift({ id, title: item.title||'', img: item.img||'', url: item.url||'', source: item.source||'youzisp.tv', addedAt: Date.now() });
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
  const entry = { id, title: item.title||'', img: item.img||'', url: item.url||'', source: item.source||'youzisp.tv', lastWatch: Date.now(), episode: item.episode||'' };
  if (exist >= 0) { list.splice(exist, 1); }
  list.unshift(entry);
  if (list.length > 200) list.length = 200;
  writeJSON(HIS_FILE, list);
  return { ok: true };
}

function hisClear() { writeJSON(HIS_FILE, []); return { ok: true }; }

// ========== 工具函数 ==========
function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function fetchPage(target, cb) {
  const hit = cache.get(target);
  if (hit && Date.now() - hit.t < 10*60*1000) return cb(null, hit.v);
  const u = new URL(target);
  const req = https.request(u, {
    method: 'GET',
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
      cache.set(target, { t: Date.now(), v: text });
      console.log(`[fetch] ${r.statusCode} ${target} len=${text.length}`);
      cb(null, text);
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', e => cb(e));
  req.end();
}

function strip(s) { return String(s||'').replace(/<[^>]+>/g,'').replace(/&nbsp;?/gi,'').replace(/&#?\w+;/g,'').replace(/\s+/g,' ').trim(); }
function urlFix(img) { return img && img.startsWith('http') ? img : (img ? SITE + img : ''); }

// 按tab分割HTML（适配youzisp.tv macCMS多tab页面）
function splitTabs(html) {
  // 分割 module-main tab-list 块
  const parts = html.split(/class="module-main tab-list[^"]*"/);
  const tabs = [];
  for (let i = 1; i < parts.length; i++) {
    // 截取到下一个 module-main tab-list 或 footer（避免误切 tab 内部的 module-card-item 等）
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

// 解析影片列表（适配youzisp.tv macCMS mxpro主题）
function parseCards(html) {
  const cards = [];
  const reg = /<a[^>]*href="(\/voddetail\/[^"]+\.html)"[^>]*title="([^"]*?)"[^>]*class="module-poster-item module-item"[\s\S]*?<\/a>/gi;
  let m;
  while ((m = reg.exec(html))) {
    const block = m[0];
    const url = m[1];
    const title = m[2];
    const img = (block.match(/data-original="([^"]*?)"/) || ['',''])[1];
    const note = (block.match(/class="module-item-note">([^<]*)<\/div>/) || ['',''])[1].trim();
    const douban = (block.match(/class="module-item-douban">([^<]*)<\/div>/) || ['',''])[1].trim();
    cards.push({
      title: title,
      url: url,
      img: urlFix(img),
      tag: note,
      desc: douban ? douban : '',
      meta: douban,
      actors: '',
      intro: ''
    });
  }
  // 备用匹配：不限制class顺序
  if (!cards.length) {
    const reg2 = /<a[^>]*href="(\/voddetail\/[^"]+\.html)"[^>]*title="([^"]*?)"[\s\S]*?<\/a>/gi;
    while ((m = reg2.exec(html))) {
      const block = m[0];
      if (block.indexOf('module-poster-item') === -1) continue;
      const url = m[1];
      const title = m[2];
      const img = (block.match(/data-original="([^"]*?)"/) || ['',''])[1];
      const note = (block.match(/class="module-item-note">([^<]*)<\/div>/) || ['',''])[1].trim();
      const douban = (block.match(/class="module-item-douban">([^<]*)<\/div>/) || ['',''])[1].trim();
      cards.push({ title, url, img: urlFix(img), tag: note, desc: douban, meta: douban, actors: '', intro: '' });
    }
  }
  return cards;
}

// 解析最新页面（适配youzisp.tv /label/new.html）
// 页面有两个tab：今日更新竖卡片(poster) + 新片上线横卡片(card)
function parseMapItems(html) {
  const posterItems = parseCards(html);
  const cardItems = parseCardItems(html);
  // 优先返回 poster items（今日更新tab），card items 作为补充
  if (posterItems.length) return posterItems;
  if (cardItems.length) return cardItems;
  return [];
}

// 解析搜索结果/新片上线（适配youzisp.tv macCMS module-card-item）
// 结构：标题(顶) | 主演(中) | 年份/地区/类型(底)
function parseCardItems(html) {
  const items = [];
  const blocks = html.split(/(?=<div[^>]*class="module-card-item module-item(?:\s+top\s+top\d)?")/);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const href = (block.match(/href="(\/voddetail\/[^"]+\.html)"/) || ['',''])[1];
    const title = (block.match(/<strong>([^<]*)<\/strong>/) || ['',''])[1].trim();
    const img = (block.match(/data-original="([^"]*?)"/) || ['',''])[1];
    const note = (block.match(/class="module-item-note">([^<]*)<\/div>/) || ['',''])[1].trim();
    const top = (block.match(/class="module-item-top[^"]*">([^<]*)/) || ['',''])[1].trim();
    const cls = (block.match(/class="module-card-item-class">([^<]*)<\/div>/) || ['',''])[1].trim();
    // 提取 module-info-items（通常2个：年份/地区/类型 + 演员）
    const infoItems = [];
    const infoReg = /class="module-info-item-content">([\s\S]*?)<\/div>/g;
    let im;
    while ((im = infoReg.exec(block)) !== null) {
      infoItems.push(strip(im[1]));
    }
    const yearRegion = infoItems[0] || '';
    const actors = infoItems[1] || '';
    if (title && href) {
      items.push({
        title: title,
        url: href,
        img: urlFix(img),
        tag: top || note || cls,
        top: top,
        note: note,
        desc: actors,
        meta: yearRegion,
        actors: actors,
        intro: ''
      });
    }
  }
  if (!items.length) return parseCards(html);
  return items;
}

// 解析排行页面（适配youzisp.tv /label/hot.html）
// 页面有三个tab：排行榜(paper-item) + 最近热门/近期热门(card/poster items)
function parseRankItems(html) {
  const items = [];
  // 按 category 分块解析，每个 category 是一个 module-paper-item
  const catBlocks = html.split(/(?=<div[^>]*class="module-paper-item module-item")/);
  let globalIdx = 0;
  for (let ci = 1; ci < catBlocks.length; ci++) {
    const block = catBlocks[ci];
    // 提取分类标题（电影榜/电视剧榜等）
    const catTitle = (block.match(/class="module-paper-item-title">([^<]*)/) || ['',''])[1].trim();
    // 提取该分类下的所有条目
    const itemReg = /<a[^>]*href="([^"]*?)">[\s\S]*?class="module-paper-item-infotitle">([^<]*)<\/span>[\s\S]*?<\/a>/gi;
    let localIdx = 0;
    let m;
    while ((m = itemReg.exec(block))) {
      const href = m[1];
      const title = m[2].trim();
      const status = (m[0].match(/<p>([^<]*)<\/p>/) || ['',''])[1].trim();
      if (title && href) {
        localIdx++;
        items.push({
          title: title,
          url: href,
          img: '',
          tag: localIdx,
          desc: status,
          catTitle: catTitle
        });
      }
    }
  }
  // 如果 paper-item 没有匹配到，尝试 poster/card items
  if (!items.length) {
    const posterItems = parseCards(html);
    if (posterItems.length) return posterItems;
    return parseCardItems(html);
  }
  return items;
}

// 解析专题列表（适配youzisp.tv macCMS）
function parseTopicItems(html) {
  const items = [];
  // 专题页可能用 module-poster-item 或其他结构
  const reg = /<a[^>]*href="([^"]*?)"[^>]*title="([^"]*?)"[\s\S]*?class="module-(?:poster|paper)-item[\s\S]*?<\/a>/gi;
  let m;
  while ((m = reg.exec(html))) {
    const block = m[0];
    const img = (block.match(/data-original="([^"]*?)"/) || ['',''])[1];
    const note = (block.match(/class="module-item-note">([^<]*)<\/div>/) || ['',''])[1].trim();
    items.push({ title: m[2], url: m[1], img: urlFix(img), tag: note, desc: '' });
  }
  if (!items.length) return parseCards(html);
  return items;
}

// ========== 公共样式片段（透明背景 + 毛玻璃内容） ==========
const COMMON_STYLE = `
html,body{background:transparent!important;min-height:100vh}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;margin:0;padding:0}
.wrap{background:rgba(0,0,0,0);backdrop-filter:blur(2px);border-radius:16px;padding:14px;margin:12px;box-shadow:0 8px 30px rgba(0,0,0,0.3)}
`;

// ========== 首页数据API ==========
function handleHomeApi(res) {
  fetchPage(SITE + '/', (err, html) => {
    if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
    
    // 轮播（适配youzisp.tv macCMS swiper-big banner）
    const lunbos = [];
    const lunboIdx = html.indexOf('swiper-big');
    if (lunboIdx >= 0) {
      const lunboBlock = html.substring(lunboIdx, lunboIdx + 10000);
      const slideParts = lunboBlock.split('swiper-slide');
      for (let si = 1; si < slideParts.length && lunbos.length < 4; si++) {
        const s = slideParts[si];
        if (s.indexOf('/voddetail/') === -1) continue;
        const href = (s.match(/href="([^"]*?)"/) || ['',''])[1];
        const bgImg = (s.match(/background:\s*url\(([^)]*)\)/) || ['',''])[1];
        const img = bgImg || '';
        const vtitle = (s.match(/<span>([^<]*)<\/span>/) || ['',''])[1].trim();
        if (!vtitle || vtitle === '推荐') continue;
        const vins = (s.match(/class="v-ins">([\s\S]*?)<\/div>/) || ['',''])[1];
        const desc = strip(vins).substring(0, 80);
        if (href && img) {
          lunbos.push({ title: vtitle, url: href, img: img, desc: desc, type: '' });
        }
      }
    }
    // 首页分类模块（适配youzisp.tv module-heading + module-poster-items）
    const sections = [];
    const sectionNames = ['电影','电视剧','综艺','动漫','纪录片'];
    
    // 提取所有 module 块
    const moduleReg = /<div[^>]*class="module"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div[^>]*class="module"/gi;
    const moduleBlocks = [];
    let mm;
    while ((mm = moduleReg.exec(html))) {
      moduleBlocks.push(mm[1]);
    }
    // 也尝试提取最后一个 module
    const lastModuleReg = /<div[^>]*class="module"[^>]*>([\s\S]*?)<div[^>]*class="footer"/gi;
    const allModules = html.match(/<div[^>]*class="module"[^>]*>[\s\S]*?(?=<div[^>]*class="module"[^>]*>|<div[^>]*class="footer")/gi) || [];
    
    for (const modHtml of allModules) {
      // 检查是否包含 module-heading 和 module-poster-items
      const headingMatch = modHtml.match(/<h2[^>]*class="module-title"[^>]*>([\s\S]*?)<\/h2>/);
      if (!headingMatch) continue;
      const headingText = strip(headingMatch[1]);
      // 检查是否是目标分类
      let matchedName = '';
      for (const name of sectionNames) {
        if (headingText.indexOf(name) >= 0) { matchedName = name; break; }
      }
      // 也匹配 "正在热映" 等
      if (!matchedName && headingText.indexOf('热映') >= 0) matchedName = '正在热映';
      if (!matchedName) continue;
      
      const cards = parseCards(modHtml);
      if (cards.length) sections.push({ title: matchedName, items: cards.slice(0, 12) });
    }
    
    send(res, 200, JSON.stringify({ok:true, lunbos, sections}), 'application/json');
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
.card{background:rgba(255,255,255,.06);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 32px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .15s,box-shadow .3s}.card:active{transform:scale(.97)}.poster{position:relative;overflow:hidden}.poster img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;transition:transform .4s}.card:active .poster img{transform:scale(1.05)}.poster::after{content:'';position:absolute;bottom:0;left:0;right:0;height:40%;background:linear-gradient(transparent,rgba(0,0,0,.6));pointer-events:none}.badge{position:absolute;right:4px;top:4px;z-index:2;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);font-size:9px;color:#fff;border:1px solid rgba(255,255,255,.2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.info{padding:6px 4px;text-align:center}
.name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.desc{font-size:10px;color:#ffd966;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
.btt{position:fixed;bottom:24px;right:16px;width:44px;height:44px;border-radius:50%;background:rgba(79,195,247,.45);color:#fff;font-size:22px;display:none;align-items:center;justify-content:center;cursor:pointer;z-index:200;border:1px solid rgba(79,195,247,.3);backdrop-filter:blur(6px)}
.btt:active{background:rgba(79,195,247,.7)}
@media(min-width:600px){.gr{grid-template-columns:repeat(4,1fr)}}
@media(min-width:900px){.gr{grid-template-columns:repeat(5,1fr)}}
</style></head><body>
<div class="wrap"><div class="gr" id="grid"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var cid=${JSON.stringify(cid)},page=0,loading=false,finished=false,count=0;
function el(s){return document.querySelector(s)}
function openVod(it){
  var item=Object.assign({},it);
  item.url=/^https?:/.test(item.url)?item.url:'https://www.youzisp.tv'+item.url;
  try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}
}
function card(it){
  var d=document.createElement('div');d.className='card';
  d.innerHTML='<div class="poster"><img loading="lazy" src="'+(it.img||'')+'">'+(it.tag?'<span class="badge">'+it.tag+'</span>':'')+'</div><div class="info"><div class="name">'+it.title+'</div>'+(it.desc?'<div class="desc">'+it.desc+'</div>':'')+'</div>';
  d.onclick=function(){openVod(it)};
  return d;
}
function load(){
  if(loading||finished)return;loading=true;
  var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';
  fetch('/api?cid='+cid+'&page='+next).then(r=>r.json()).then(j=>{
    if(!j.ok)throw new Error(j.error||'load failed');
    if(!j.items.length){finished=true;el('#tip').textContent='— 已显示全部 —';return}
    page=next;
    j.items.forEach(function(it){el('#grid').appendChild(card(it));count++});
    el('#tip').textContent='已加载 '+count+' 部。';
  }).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)}).finally(()=>loading=false);
}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
var btt=document.createElement('div');btt.className='btt';btt.innerHTML='↑';
btt.onclick=function(){window.scrollTo({top:0,behavior:'smooth'})};
document.body.appendChild(btt);
window.addEventListener('scroll',function(){btt.style.display=window.scrollY>400?'flex':'none'});
</script></body></html>`;
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
.card{background:rgba(255,255,255,.06);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 32px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .15s,box-shadow .3s}
.card:active{transform:scale(.97)}
.poster{position:relative;overflow:hidden}
.poster img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block}
.poster::after{content:'';position:absolute;bottom:0;left:0;right:0;height:40%;background:linear-gradient(transparent,rgba(0,0,0,.6));pointer-events:none}
.badge{position:absolute;right:4px;top:4px;z-index:2;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);font-size:9px;color:#fff;border:1px solid rgba(255,255,255,.2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.info{padding:6px 4px;text-align:center}
.name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list,#list{display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:12px;background:rgba(255,255,255,.06);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s}
.row:active{transform:scale(.98)}
.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}
.sposter img{width:100%;height:100%;object-fit:cover;display:block}
.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}
.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;padding:0}
.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;line-height:1.3}
.sintro{font-size:12px;color:rgba(255,255,255,.7);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:auto 0;min-height:0}
.smeta{font-size:11px;color:rgba(255,255,255,.55);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;margin-top:auto;padding-top:2px}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
@media(min-width:600px){.gr{grid-template-columns:repeat(4,1fr)}}
@media(min-width:900px){.gr{grid-template-columns:repeat(5,1fr)}}
</style></head><body>
<div class="wrap"><div class="tabs" id="tabs"></div><div id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var tabs=[{name:'今日更新',tab:0},{name:'新片上线',tab:1}];
var curTab=0,page=0,loading=false,finished=false,count=0,reqId=0;
function el(s){return document.querySelector(s)}
function initTabs(){var c=document.getElementById('tabs');tabs.forEach(function(t,i){var b=document.createElement('div');b.className='tab'+(i===0?' on':'');b.textContent=t.name;b.onclick=function(){document.querySelectorAll('.tab').forEach(function(x){x.className='tab'});b.className='tab on';curTab=t.tab;page=0;finished=false;count=0;loading=false;reqId++;el('#list').innerHTML='';load()};c.appendChild(b)})}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.youzisp.tv'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function pCard(it){var d=document.createElement('div');d.className='card';d.innerHTML='<div class="poster"><img loading="lazy" src="'+(it.img||'')+'">'+(it.tag?'<span class="badge">'+it.tag+'</span>':'')+'</div><div class="info"><div class="name">'+it.title+'</div></div>';var img=d.querySelector('img');if(img){img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'}}d.onclick=function(){openVod(it)};return d}
function cRow(it){var d=document.createElement('div');d.className='row';var topHtml=it.top?'<span style="position:absolute;top:4px;left:4px;z-index:2;background:rgba(255,71,87,.85);color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px">'+it.top+'</span>':'';var noteHtml=it.note?'<span class="sptext">'+it.note+'</span>':'';var descHtml=it.desc?'<div class="sintro">'+it.desc+'</div>':'';var metaHtml=it.meta?'<div class="smeta">'+it.meta+'</div>':'';d.innerHTML='<div class="sposter"><img loading="lazy" src="'+(it.img||'')+'">'+topHtml+noteHtml+'</div><div class="sinfo"><div class="sname">'+it.title+'</div>'+descHtml+metaHtml+'</div>';var img=d.querySelector('.sposter img');if(img){img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'}}d.onclick=function(){openVod(it)};return d}
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
.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}
.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;padding:0}
.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;line-height:1.3}
.sintro{font-size:12px;color:rgba(255,255,255,.7);line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin:auto 0;min-height:0}
.smeta{font-size:11px;color:rgba(255,255,255,.55);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;margin-top:auto;padding-top:2px}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.7);font-size:13px}
</style></head><body>
<div class="wrap"><div class="tabs" id="tabs"></div><div id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var tabs=[{name:'排行榜',tab:0},{name:'最近热门',tab:1},{name:'近期热门',tab:2}];
var curTab=0,page=0,loading=false,finished=false,count=0,reqId=0;
function el(s){return document.querySelector(s)}
function initTabs(){var c=document.getElementById('tabs');tabs.forEach(function(t,i){var b=document.createElement('div');b.className='tab'+(i===0?' on':'');b.textContent=t.name;b.onclick=function(){document.querySelectorAll('.tab').forEach(function(x){x.className='tab'});b.className='tab on';curTab=t.tab;page=0;finished=false;count=0;loading=false;reqId++;el('#list').innerHTML='';load()};c.appendChild(b)})}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.youzisp.tv'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function cRow(it){var d=document.createElement('div');d.className='row';var topColors={'1':'rgba(255,71,87,.9)','2':'rgba(255,107,129,.9)','3':'rgba(255,165,2,.9)'};var topN=parseInt(it.top);var topBg=topColors[it.top]||(topN>=4?'rgba(255,255,255,.18)':'rgba(255,71,87,.9)');var topHtml=it.top?'<span style="position:absolute;top:4px;left:4px;z-index:2;background:'+topBg+';color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px">'+it.top+'</span>':'';var noteHtml=it.note?'<span class="sptext">'+it.note+'</span>':'';var descHtml=it.desc?'<div class="sintro">'+it.desc+'</div>':'';var metaHtml=it.meta?'<div class="smeta">'+it.meta+'</div>':'';d.innerHTML='<div class="sposter"><img loading="lazy" src="'+(it.img||'')+'">'+topHtml+noteHtml+'</div><div class="sinfo"><div class="sname">'+it.title+'</div>'+descHtml+metaHtml+'</div>';var img=d.querySelector('.sposter img');if(img){img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'}}d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished)return;loading=true;var rid=reqId,next=page+1;el('#tip').textContent='加载中...';fetch('/rank-api?page='+next+'&tab='+curTab).then(r=>r.json()).then(function(j){if(!j.ok)throw new Error(j.error||'fail');if(!j.items.length){finished=true;el('#tip').textContent=count?'已全部加载':'暂无数据';return}if(rid!==reqId)return;page=next;var list=el('#list');if(curTab===0){var grid=list.querySelector('.grid2');if(!count){grid=document.createElement('div');grid.className='grid2';list.appendChild(grid)}var cats={};j.items.forEach(function(it){var cat=it.catTitle||'';if(!cats[cat])cats[cat]=[];cats[cat].push(it)});Object.keys(cats).forEach(function(cat){var card=document.createElement('div');card.className='cat-card';card.innerHTML='<div class="cat-name">'+cat+'</div>';cats[cat].slice(0,5).forEach(function(it){var n=it.tag;var c=n<=3?'t'+n:'';var r=document.createElement('div');r.className='rit';r.innerHTML='<div class="rn '+c+'">'+n+'</div><div class="rt">'+it.title+'</div>'+(it.desc?'<div class="rs">'+it.desc+'</div>':'');r.onclick=function(){openVod(it)};card.appendChild(r)});grid.appendChild(card)})}else{j.items.forEach(function(it){list.appendChild(cRow(it));count++})}count+=j.items.length;el('#tip').textContent='已加载 '+count+' 部';}).catch(function(e){if(rid!==reqId)return;loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败</span>'})}
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
.card{position:relative;border-radius:14px;overflow:hidden;background:rgba(255,255,255,.06);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 32px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .15s;cursor:pointer}.card:active{transform:scale(.98)}
.card img{width:100%;height:180px;object-fit:cover;display:block}
.card-overlay{position:absolute;bottom:0;left:0;right:0;padding:14px 16px 12px;background:linear-gradient(transparent,rgba(0,0,0,.6));backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:space-between}
.card-title{font-size:17px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.card-count{font-size:12px;color:rgba(255,255,255,.75);background:rgba(255,255,255,.15);border-radius:10px;padding:2px 10px;flex-shrink:0;margin-left:8px}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="wrap"><div class="title" id="title">📋 专题（0个）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var page=0,loading=false,finished=false,count=0;
function el(s){return document.querySelector(s)}
function openTopic(it){location.href='/topic-detail?url='+encodeURIComponent(it.url)+'&title='+encodeURIComponent(it.title)}
function row(it){var d=document.createElement('div');d.className='card';d.innerHTML='<img loading="lazy" referrerpolicy="no-referrer" src="'+(it.img||'')+'"><div class="card-overlay"><div class="card-title">'+it.title+'</div>'+(it.tag?'<div class="card-count">'+it.tag+'</div>':'')+'</div>';var img=d.querySelector('img');if(img){img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/600/300'}}d.onclick=function(){openTopic(it)};return d}
function load(){if(loading||finished)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/topic-api?page='+next).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'暂无数据';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#title').textContent='📋 专题（'+count+'个）';el('#tip').textContent='已加载 '+count+' 个。'}).catch(e=>{loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败：'+(e.message||e)+'</span><br><button onclick="loading=false;load()" style="margin-top:8px;padding:6px 16px;border-radius:8px;border:0;background:rgba(255,255,255,.2);color:#fff;cursor:pointer">重试</button>'})}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
<\/script></body></html>`;
}

// ========== 专题详情页HTML ==========
function topicDetailHtml(topicUrl, topicTitle) {
  const escUrl = topicUrl.replace(/'/g, "\\'");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(topicTitle)}</title>
<style>
${COMMON_STYLE}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.topbar{display:flex;align-items:center;padding:4px 0 10px;gap:10px}.back{background:rgba(0,0,0,.4);backdrop-filter:blur(8px);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}.toptitle{font-size:16px;font-weight:700}
.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px;background:rgba(255,255,255,.06);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.smeta{font-size:12px;color:rgba(255,255,255,.7);margin-top:6px;line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="wrap"><div class="topbar"><button class="back" onclick="history.back()">←</button><div class="toptitle">${esc(topicTitle)}</div></div><div class="title" id="title">${esc(topicTitle)}（0部）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var page=0,loading=false,finished=false,count=0;
var topicUrl='${escUrl}';
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.youzisp.tv'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function row(it){var d=document.createElement('div');d.className='row';var tagHtml=it.tag?'<span class="sptext">'+it.tag+'</span>':'';d.innerHTML='<div class="sposter"><img loading="lazy" referrerpolicy="no-referrer" src="'+(it.img||'')+'">'+tagHtml+'</div><div class="sinfo"><div class="sname">'+it.title+'</div>'+(it.desc?'<div class="smeta" style="-webkit-line-clamp:5">'+it.desc+'</div>':'')+'</div>';var img=d.querySelector('.sposter img');if(img){img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'}}d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/topic-detail-api?page='+next+'&url='+encodeURIComponent(topicUrl)).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'暂无数据';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#title').textContent='${esc(topicTitle)}（'+count+'部）';el('#tip').textContent='已加载 '+count+' 部。'}).catch(e=>{loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败：'+(e.message||e)+'</span><br><button onclick="loading=false;load()" style="margin-top:8px;padding:6px 16px;border-radius:8px;border:0;background:rgba(255,255,255,.2);color:#fff;cursor:pointer">重试</button>'})}
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
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:4px 0 10px;gap:10px}.back{background:rgba(255,255,255,.12);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.2);box-shadow:0 2px 12px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1);color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}.back:active{background:rgba(255,255,255,.2);transform:scale(.92)}.toptitle{font-size:16px;font-weight:700}
.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:12px;background:rgba(255,255,255,.06);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s;position:relative}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 80px;width:80px;height:110px;border-radius:12px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}
.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}
.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.smeta{font-size:12px;color:rgba(255,255,255,.7);margin-top:6px}
.delbtn{position:absolute;top:8px;right:8px;background:rgba(255,71,87,.8);border:0;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s}
.row:hover .delbtn,.row:active .delbtn{opacity:1}
.clearbtn{background:rgba(255,71,87,.2);border:1px solid rgba(255,71,87,.4);color:#ff4757;padding:4px 12px;border-radius:16px;font-size:12px;cursor:pointer}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="wrap"><div class="topbar"><div style="display:flex;align-items:center;gap:10px"><button class="back" onclick="history.back()">←</button><div class="toptitle">❤️ 我的收藏</div></div><button class="clearbtn" onclick="if(confirm('确定清空所有收藏？')){fetch('/fav-clear',{method:'POST'}).then(()=>load())}">清空</button></div><div class="list" id="list"></div><div class="tip" id="tip">加载中...</div></div>
<script>
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.youzisp.tv'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function load(){
  fetch('/fav-list').then(r=>r.json()).then(j=>{
    if(!j.ok||!j.items.length){
  el('#list').innerHTML = '';  // 清空列表
  el('#tip').textContent='暂无收藏，快去收藏喜欢的影片吧 ❤️';
  return;
}
    el('#list').innerHTML='';
    j.items.forEach(function(it){
      var d=document.createElement('div');d.className='row';
      d.innerHTML='<div class="sposter"><img loading="lazy" src="'+(it.img||'')+'"></div><div class="sinfo"><div class="sname">'+it.title+'</div><div class="smeta">'+new Date(it.addedAt).toLocaleDateString()+'</div></div><button class="delbtn" data-id="'+it.id+'">✕</button>';
      d.querySelector('.sposter').onclick=d.querySelector('.sname').onclick=function(){openVod(it)};
      d.querySelector('.delbtn').onclick=function(e){
        e.stopPropagation();
        fetch('/fav-remove?id='+encodeURIComponent(it.id),{method:'POST'}).then(()=>load());
      };
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
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:4px 0 10px;gap:10px}.back{background:rgba(255,255,255,.12);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.2);box-shadow:0 2px 12px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1);color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}.back:active{background:rgba(255,255,255,.2);transform:scale(.92)}.toptitle{font-size:16px;font-weight:700}
.clearbtn{background:rgba(255,71,87,.2);border:1px solid rgba(255,71,87,.4);color:#ff4757;padding:4px 12px;border-radius:16px;font-size:12px;cursor:pointer}
.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:12px;background:rgba(255,255,255,.06);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s;position:relative}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 80px;width:80px;height:110px;border-radius:12px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}
.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}
.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.smeta{font-size:12px;color:rgba(255,255,255,.7);margin-top:4px}
.sepi{font-size:12px;color:#4fc3f7;margin-top:4px}
.delbtn{position:absolute;top:8px;right:8px;background:rgba(255,71,87,.8);border:0;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s}
.row:hover .delbtn,.row:active .delbtn,.row.show-del .delbtn{opacity:1}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="wrap"><div class="topbar"><div style="display:flex;align-items:center;gap:10px"><button class="back" onclick="history.back()">←</button><div class="toptitle">🕐 观看历史</div></div><button class="clearbtn" onclick="if(confirm('确定清空所有历史？')){fetch('/his-clear',{method:'POST'}).then(()=>load())}">清空</button></div><div class="list" id="list"></div><div class="tip" id="tip">加载中...</div></div>
<script>
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.youzisp.tv'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function timeAgo(ts){var d=Date.now()-ts;if(d<60000)return'刚刚';if(d<3600000)return Math.floor(d/60000)+'分钟前';if(d<86400000)return Math.floor(d/3600000)+'小时前';if(d<604800000)return Math.floor(d/86400000)+'天前';return new Date(ts).toLocaleDateString()}
function load(){
  fetch('/his-list').then(r=>r.json()).then(j=>{
    if(!j.ok||!j.items.length){
  el('#list').innerHTML = '';  // 清空列表
  el('#tip').textContent='暂无观看历史 🎬';
  return;
}
    el('#list').innerHTML='';
    j.items.forEach(function(it){
      var d=document.createElement('div');d.className='row';
      d.innerHTML='<div class="sposter"><img loading="lazy" src="'+(it.img||'')+'"></div><div class="sinfo"><div class="sname">'+it.title+'</div>'+(it.episode?'<div class="sepi">▶ '+it.episode+'</div>':'')+'<div class="smeta">'+timeAgo(it.lastWatch)+'</div></div><button class="delbtn" data-id="'+it.id+'">✕</button>';
      d.querySelector('.sposter').onclick=d.querySelector('.sname').onclick=function(){openVod(it)};
      d.querySelector('.delbtn').onclick=function(e){
        e.stopPropagation();
        if(confirm('确定删除这条历史记录吗？')){
          fetch('/his-remove?id='+encodeURIComponent(it.id),{method:'POST'}).then(()=>load());
        }
      };
      var longPressTimer=null;
      d.addEventListener('touchstart',function(e){
        longPressTimer=setTimeout(function(){
          d.classList.toggle('show-del');
          longPressTimer=null;
        },600);
      });
      d.addEventListener('touchend',function(){
        if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}
      });
      d.addEventListener('touchmove',function(){
        if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}
      });
      d.addEventListener('mousedown',function(e){
        longPressTimer=setTimeout(function(){
          d.classList.toggle('show-del');
          longPressTimer=null;
        },600);
      });
      d.addEventListener('mouseup',function(){
        if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}
      });
      d.addEventListener('mouseleave',function(){
        if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}
      });
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
.title{display:flex;align-items:center;justify-content:space-between;font-size:18px;font-weight:700;margin:4px 0 14px;min-height:36px}.title-text{flex:1;min-width:0}.title .back{background:rgba(255,255,255,.12);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.2);box-shadow:0 2px 12px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.1);color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0}.title .back:active{background:rgba(255,255,255,.2);transform:scale(.92)}.list{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px;background:rgba(255,255,255,.06);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;border-radius:12px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;padding:0}.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;line-height:1.3}.sintro{font-size:12px;color:rgba(255,255,255,.7);line-height:1.4;display:-webkit-box;-webkit-line-clamp:7;-webkit-box-orient:vertical;overflow:hidden;margin:auto 0;min-height:0}.smeta{font-size:11px;color:rgba(255,255,255,.55);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;margin-top:auto;padding-top:2px}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="wrap"><div class="title"><div class="title-text" id="titleText">搜索「${esc(wd)}」（0个）</div><button class="back" onclick="goBack()">←</button></div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var wd=${JSON.stringify(wd||'')},page=0,loading=false,finished=false,count=0;
function el(s){return document.querySelector(s)}
function goBack(){try{parent.postMessage({type:'searchBack'},'*')}catch(e){history.back()}}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.youzisp.tv'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function row(it){var d=document.createElement('div');d.className='row';var tagHtml=it.tag?'<span class="sptext">'+it.tag+'</span>':'';var descHtml=it.desc?'<div class="sintro">'+it.desc+'</div>':'';var metaHtml=it.meta?'<div class="smeta">'+it.meta+'</div>':'';d.innerHTML='<div class="sposter"><img loading="lazy" src="'+(it.img||'')+'">'+tagHtml+'</div><div class="sinfo"><div class="sname">'+it.title+'</div>'+descHtml+metaHtml+'</div>';var img=d.querySelector('.sposter img');if(img){img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'}}d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished||!wd)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/search-api?wd='+encodeURIComponent(wd)+'&page='+next).then(r=>r.json()).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'未找到匹配内容';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#titleText').textContent='搜索「'+wd+'」（'+count+'个）';el('#tip').textContent='已加载 '+count+' 个。'}).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)}).finally(()=>loading=false)}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
<\/script></body></html>`;
}

// ========== TMDB详情页HTML（保持原有深色背景，不透明） ==========
function tmdbPageHtml(d, vodUrl, fallbackImg) {
  const fullUrl = vodUrl && !/^https?:/.test(vodUrl) ? 'https://www.youzisp.tv' + vodUrl : vodUrl;
  const bgImg = d.backdrop || fallbackImg || '';
  const img = fallbackImg || '';
  const gTags = d.genres.map(g=>`<span class=tag>${esc(g)}</span>`).join('');
  const rt = d.rating>0?`<span class=rtag>⭐ ${d.rating.toFixed(1)}</span>`:'';
  const yr = d.year?`<span class=tag>${d.year}</span>`:'';
  const rm = d.runtime?`<span class=tag>${d.runtime}分钟</span>`:'';
  const ss = d.seasons?`<span class=tag>共${d.seasons}季${d.eps}集</span>`:'';
  const castHtml = d.cast.map(c=>{
    const img = c.pic?`<img class=cimg src="${c.pic}" loading=lazy onerror="this.style.display='none'">`:'<div class=cimg style="background:#333;display:flex;align-items:center;justify-content:center;color:#666;font-size:18px">?</div>';
    return `<a class=cast href="/tmdb/person-page?id=${c.id}&name=${encodeURIComponent(c.name)}" target="_self">${img}<div class=cname>${esc(c.name)}</div></a>`;
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
/* 修改点：body背景改为纯色 #0a0e1a，不再半透明 */
body{font-family:-apple-system,sans-serif;background:#0a0e1a;color:#eee}
.bg{position:fixed;top:0;left:0;right:0;height:56vh;overflow:hidden;z-index:0;background:#0a0e1a}.bg img{width:100%;height:100%;object-fit:cover;object-position:center 20%;filter:brightness(.85)}.bg .fade{position:absolute;bottom:0;left:0;right:0;height:35%;background:linear-gradient(to top,#0a0e1a 0%,rgba(10,14,26,.6) 50%,transparent 100%)}
.topbar{position:fixed;top:0;left:0;right:0;z-index:20;padding:10px 14px;display:flex;align-items:center}
.nbtn{background:rgba(0,0,0,.4);backdrop-filter:blur(8px);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}
.fbtn{position:fixed;bottom:24px;right:16px;z-index:30;width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.5);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.fbtn:active{transform:scale(.9)}
.content{position:relative;z-index:10;padding-top:38vh}
.hero{padding:40px 16px 0}.info .t{font-family:'ZCOOL KuaiLe',cursive;font-size:39px;font-weight:400;line-height:1.2;margin-bottom:16px;background:linear-gradient(135deg,#f6d365,#fda085,#f6d365,#fda085);background-size:200% 200%;-webkit-background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:gradientMove 3s ease infinite;filter:drop-shadow(6px 8px 12px rgba(79,195,247,.9)) drop-shadow(0 0 25px rgba(79,195,247,.5)) drop-shadow(0 0 60px rgba(79,195,247,.25))}
@keyframes gradientMove{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}.info .sub { display: none; }.info .tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{padding:3px 10px;border-radius:14px;font-size:11px;background:rgba(79,195,247,.15);color:#4fc3f7;border:1px solid rgba(79,195,247,.3)}.rtag{padding:3px 10px;border-radius:14px;font-size:12px;font-weight:700;background:rgba(255,193,7,.15);color:#ffc107;border:1px solid rgba(255,193,7,.3)}
.play{display:block;margin:18px auto 0;width:calc(100% - 32px);max-width:400px;padding:14px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.25);border-radius:24px;color:#fff;font-size:17px;font-weight:700;cursor:pointer}.play:active{transform:scale(.97)}
.favbtn{display:block;margin:10px auto 0;width:calc(100% - 32px);max-width:400px;padding:12px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.25);border-radius:24px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:all .2s}.favbtn:active{transform:scale(.97)}
.sec{padding:20px 16px 0}.sh{font-size:15px;font-weight:700;margin-bottom:10px}
.desc{font-size:13px;color:rgba(224,224,224,.78);line-height:1.7;white-space:pre-line}
.desc.collapsed{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:normal}
.desc.expanded{display:block;white-space:pre-line}
.ebtn{background:0;border:0;color:#4fc3f7;font-size:12px;cursor:pointer;padding:4px 0}
.clist{display:flex;gap:14px;overflow-x:auto;padding-bottom:8px}.clist::-webkit-scrollbar{display:none}
.cast{flex-shrink:0;width:72px;text-align:center;cursor:pointer;text-decoration:none;color:#eee}.cimg{width:62px;height:62px;border-radius:50%;object-fit:cover;background:#222;display:block;margin:0 auto 6px;border:2px solid rgba(255,255,255,.2)}
.cname{font-size:10px;color:rgba(224,224,224,.85);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:600}
.play, .favlink, a[href="/history"] {padding: 8px 16px;height: 44px;display: inline-flex;align-items: center;justify-content: center;box-sizing: border-box;}
</style></head><body>
<div class=bg>${bgImg?'<img src="'+bgImg+'">':''}<div class=fade></div></div>
<div class=topbar><button class=nbtn onclick="try{parent.postMessage({type:'dsjClose'},'*')}catch(e){history.back()}">←</button></div>
<div class=content><div class=hero><div class=info><div class=t>${esc(d.title)}</div><div class=sub>${esc(d.originalTitle)}</div><div class=tags>${yr}${rm}${ss}${gTags}${rt}</div></div></div>
<div style="display:flex;gap:10px;margin:18px auto 0;width:calc(100% - 32px);max-width:400px">
<button class=play style="flex:1;margin:0" onclick="try{parent.postMessage({type:'dsjPlay',url:'${fullUrl.replace(/'/g, "\\'")}'},'*')}catch(e){window.open('${fullUrl.replace(/'/g, "\\'")}','_blank')}">▶ 播放</button>
<a class=favlink href="/fav-add-redirect?title=${encodeURIComponent(d.title)}&url=${encodeURIComponent(fullUrl)}&img=${encodeURIComponent(img||'')}" style="flex:0 0 auto;padding:14px 16px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.25);border-radius:24px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;margin:0;white-space:nowrap">❤️ 收藏</a>
<a href="/history" style="flex:0 0 auto;padding:14px 16px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.25);border-radius:24px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;margin:0;white-space:nowrap">🕐 历史</a>
</div>
${overviewHtml}
${castHtml?'<div class=sec><div class=sh>主演</div><div class=clist>'+castHtml+'</div></div>':''}
</div><button class=fbtn onclick="try{parent.postMessage({type:'dsjClose'},'*')}catch(e){history.back()}">\u2190</button></body></html>`;
}

// ========== HTTP路由 ==========
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://0.0.0.0:${PORT}`);
  const path = u.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (path === '/health') return send(res, 200, 'ok');

  if (path === '/shutdown') {
    send(res, 200, 'shutting down');
    setTimeout(() => {
      try { server.close(); } catch(e) {}
      try {
        for (const [k, v] of cache) { cache.delete(k); }
      } catch(e) {}
    }, 200);
    return;
  }

  // 首页数据
  if (path === '/home-api') return handleHomeApi(res);

  // 代理请求
  if (path === '/proxy') {
    const target = u.searchParams.get('url');
    if (!target) return send(res, 400, '{"ok":false,"error":"missing url"}');
    return fetchPage(target, (err, html) => {
      if (err) return send(res, 502, 'error:' + err.message);
      send(res, 200, html, 'text/html; charset=utf-8');
    });
  }

  // 分类API
  if (path === '/api') {
    const cid = u.searchParams.get('cid') || 'dianying';
    const page = parseInt(u.searchParams.get('page') || '1');
    const url = page <= 1
      ? `${SITE}/vodtype/${cid}.html`
      : `${SITE}/vodtype/${cid}/page/${page}.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const items = parseCards(html);
      send(res, 200, JSON.stringify({ok:true, items}), 'application/json');
    });
  }

  // 分类页
  if (path === '/category') {
    const cid = u.searchParams.get('cid') || 'dianying';
    const name = u.searchParams.get('name') || '电影';
    return send(res, 200, categoryHtml(cid, name), 'text/html; charset=utf-8');
  }

  // 搜索API（适配youzisp.tv macCMS）
  if (path === '/search-api') {
    const wd = u.searchParams.get('wd') || '';
    const page = parseInt(u.searchParams.get('page') || '1', 10);
    const url = page > 1
      ? `${SITE}/vodsearch/${encodeURIComponent(wd)}----------${page}---.html`
      : `${SITE}/vodsearch/${encodeURIComponent(wd)}-------------.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const items = parseCardItems(html);
      send(res, 200, JSON.stringify({ok:true, items}), 'application/json');
    });
  }

  // 最新页
  if (path === '/latest') {
    const page = parseInt(u.searchParams.get('page') || '1');
    return send(res, 200, latestHtml(page), 'text/html; charset=utf-8');
  }

  // 最新API（适配youzisp.tv，支持tab切换）
  // tab=0: 今日更新竖卡片, tab=1: 新片上线横卡片
  if (path === '/latest-api') {
    const page = parseInt(u.searchParams.get('page') || '1');
    const tab = parseInt(u.searchParams.get('tab') || '0');
    const url = page <= 1
      ? `${SITE}/label/new.html`
      : `${SITE}/label/new/page/${page}.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const tabs = splitTabs(html);
      let items = [];
      if (tab === 1 && tabs.length > 1) {
        items = parseCardItems(tabs[1]);
      } else if (tabs.length > 0) {
        items = parseCards(tabs[0]);
        if (!items.length && tabs.length > 1) items = parseCardItems(tabs[1]);
      }
      send(res, 200, JSON.stringify({ok:true, items, tabCount: tabs.length}), 'application/json');
    });
  }

  // 排行页
  if (path === '/rank') {
    const page = parseInt(u.searchParams.get('page') || '1');
    return send(res, 200, rankHtml(page), 'text/html; charset=utf-8');
  }

  // 排行API（适配youzisp.tv，支持tab切换）
  // tab=0: 排行榜(paper-item), tab=1: 最近热门(card-item), tab=2: 近期热门(card-item)
  if (path === '/rank-api') {
    const page = parseInt(u.searchParams.get('page') || '1');
    const tab = parseInt(u.searchParams.get('tab') || '0');
    const url = page <= 1
      ? `${SITE}/label/hot.html`
      : `${SITE}/label/hot/page/${page}.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const tabs = splitTabs(html);
      let items = [];
      if (tab === 0) {
        items = parseRankItems(tabs[0] || html);
      } else if (tab === 1 && tabs.length > 1) {
        items = parseCardItems(tabs[1]);
      } else if (tab === 2 && tabs.length > 2) {
        items = parseCardItems(tabs[2]);
      } else {
        items = parseRankItems(tabs[0] || html);
      }
      send(res, 200, JSON.stringify({ok:true, items, tabCount: tabs.length}), 'application/json');
    });
  }

  // 专题页
  if (path === '/topic') {
    return send(res, 200, topicHtml(), 'text/html; charset=utf-8');
  }

  // 专题API（适配youzisp.tv）
  if (path === '/topic-api') {
    const page = parseInt(u.searchParams.get('page') || '1');
    const url = page <= 1
      ? `${SITE}/topic.html`
      : `${SITE}/topic/page/${page}.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const items = parseTopicItems(html);
      send(res, 200, JSON.stringify({ok:true, items}), 'application/json');
    });
  }

  // 专题详情页
  if (path === '/topic-detail') {
    const topicUrl = u.searchParams.get('url') || '';
    const topicTitle = u.searchParams.get('title') || '专题';
    return send(res, 200, topicDetailHtml(topicUrl, topicTitle), 'text/html; charset=utf-8');
  }

  // 专题详情API
  if (path === '/topic-detail-api') {
    const topicUrl = u.searchParams.get('url') || '';
    const page = parseInt(u.searchParams.get('page') || '1');
    if (!topicUrl) return send(res, 200, JSON.stringify({ok:false,error:'no url'}));
    const fullTopicUrl = /^https?:/.test(topicUrl) ? topicUrl : SITE + topicUrl;
    const fetchUrl = page <= 1
      ? fullTopicUrl
      : fullTopicUrl.replace(/\.html?$/, '/page/' + page + '.html');
    return fetchPage(fetchUrl, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const items = parseCards(html);
      send(res, 200, JSON.stringify({ok:true, items}), 'application/json');
    });
  }

  // 搜索页
  if (path === '/search') {
    const wd = u.searchParams.get('wd') || '';
    return send(res, 200, searchHtml(wd), 'text/html; charset=utf-8');
  }

  // TMDB详情页
  if (path === '/tmdb-page') {
    const title = u.searchParams.get('title') || '';
    const vodUrl = u.searchParams.get('url') || '';
    const img = u.searchParams.get('img') || '';
    // 自动记录观看历史
    const fullVodUrl = vodUrl && !/^https?:/.test(vodUrl) ? 'https://www.youzisp.tv' + vodUrl : vodUrl;
    hisAdd({ id: fullVodUrl.replace(/[^a-zA-Z0-9]/g, '_'), title, url: fullVodUrl, img, source: 'youzisp.tv' });
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
          const detailUrl = `${TMDB_BASE}/${mt}/${r.id}?api_key=${TMDB_KEY}&language=zh-CN&append_to_response=credits`;
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
              if(mt==='tv'){d.seasons=det.number_of_seasons||0;d.eps=det.number_of_episodes||0;}
            } catch(e){}
            send(res, 200, tmdbPageHtml(d, vodUrl, img), 'text/html; charset=utf-8');
            return;
          });
        }
      } catch(e){}
      if (!d.overview && !d.cast.length) {
        d.overview = '未在 TMDB 匹配到该影片信息。';
      }
      send(res, 200, tmdbPageHtml(d, vodUrl, img), 'text/html; charset=utf-8');
    });
  }

  // TMDB演员详情页
  if (path === '/tmdb/person-page') {
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
          character: w.character
        })));
        const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{min-height:100vh;overflow-x:hidden;background:rgba(10,14,26,.3);color:#eee;background-image:radial-gradient(ellipse at 30% 20%,rgba(79,195,247,.08) 0%,transparent 50%),radial-gradient(ellipse at 70% 80%,rgba(246,211,101,.06) 0%,transparent 50%)}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.topbar{background:transparent;}
.nbtn{background:rgba(255,255,255,.15);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center;margin-left:6px;margin-top:8px;margin-bottom:8px;}
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
.pwi{cursor:pointer;background:rgba(255,255,255,.06);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .15s,box-shadow .3s}
.pwi:active{transform:scale(.96)}
.pwi img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;background:#161628}
.pwi .pwt{padding:4px 6px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(224,224,224,.9)}
.pwi .pwr{padding:0 6px 6px;font-size:10px;color:#ffc107}
.tip{text-align:center;padding:16px;color:rgba(255,255,255,.5);font-size:13px}
.fbtn{position:fixed;bottom:24px;right:16px;z-index:30;width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.5);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.fbtn:active{transform:scale(.9)}
</style></head><body>
<div class=topbar><button class=nbtn onclick="history.back()">\u2190</button><div style="font-size:16px;font-weight:700"></div></div>
<div class=wrap>
${photo ? '<div class=photo><img src="'+photo+'"><div class=pinfo><div class=nm>'+esc(name)+'</div>'+infoHtml+'</div></div>' : '<div class=nm>'+esc(name)+'</div>'+infoHtml}
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
  var safeT=w.title.replace(/'/g,"\\'");
  var charHtml = w.character ? '<div style="font-size:9px;color:rgba(255,255,255,0.6);padding:0 6px 4px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">饰演：' + w.character + '</div>' : '';
var metaHtml = '';
if (w.rating || w.character) {
  metaHtml = '<div style="display:flex;justify-content:space-between;align-items:center;padding:0 6px 4px;font-size:10px;color:rgba(255,255,255,0.7);">';
  if (w.rating) metaHtml += '<span>⭐ ' + w.rating + '</span>';
  if (w.character) metaHtml += '<span style="color:rgba(255,255,255,0.5);font-size:9px;">饰演：' + w.character + '</span>';
  metaHtml += '</div>';
}
d.innerHTML = img + '<div class=pwt>' + w.title + '</div>' + metaHtml;
  d.onclick=function(){parent.postMessage({type:'dsjSearch',query:safeT},'*')};
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
io.observe(el('#tip'));
loadMore();
<\/script><button class=fbtn onclick="history.back()">\u2190</button></body></html>`;
        send(res, 200, html, 'text/html; charset=utf-8');
      } catch (err) { send(res, 500, 'parse error'); }
    });
  }

  // ========== 收藏 & 历史 API ==========
  if (path === '/fav-add') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { const item = JSON.parse(body); send(res, 200, JSON.stringify(favAdd(item)), 'application/json'); }
      catch(e) { send(res, 400, '{"ok":false}'); }
    });
    return;
  }

  if (path === '/fav-remove') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const id = new URL('http://0.0.0.0?' + body).searchParams.get('id') || u.searchParams.get('id') || '';
          send(res, 200, JSON.stringify(favRemove(id)), 'application/json');
        } catch(e) { send(res, 400, '{"ok":false}'); }
      });
      return;
    }
    const id = u.searchParams.get('id') || '';
    return send(res, 200, JSON.stringify(favRemove(id)), 'application/json');
  }

  if (path === '/fav-list') {
    return send(res, 200, JSON.stringify({ ok: true, items: favList() }), 'application/json');
  }

  if (path === '/fav-check') {
    const id = u.searchParams.get('id') || '';
    return send(res, 200, JSON.stringify({ faved: favCheck(id) }), 'application/json');
  }

  if (path === '/his-add') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { const item = JSON.parse(body); send(res, 200, JSON.stringify(hisAdd(item)), 'application/json'); }
      catch(e) { send(res, 400, '{"ok":false}'); }
    });
    return;
  }

  if (path === '/his-list') {
    return send(res, 200, JSON.stringify({ ok: true, items: hisList() }), 'application/json');
  }

  if (path === '/his-clear') {
    return send(res, 200, JSON.stringify(hisClear()), 'application/json');
  }

if (path === '/his-remove') {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const id = new URL('http://0.0.0.0?' + body).searchParams.get('id') || u.searchParams.get('id') || '';
        const list = hisList().filter(h => h.id !== id);
        writeJSON(HIS_FILE, list);
        send(res, 200, JSON.stringify({ ok: true }), 'application/json');
      } catch(e) { send(res, 400, '{"ok":false}'); }
    });
    return;
  }
  const id = u.searchParams.get('id') || '';
  const list = hisList().filter(h => h.id !== id);
  writeJSON(HIS_FILE, list);
  send(res, 200, JSON.stringify({ ok: true }), 'application/json');
}

  if (path === '/fav-clear') {
    writeJSON(FAV_FILE, []);
    return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
  }

  if (path === '/fav-add-redirect') {
    const title = u.searchParams.get('title') || '';
    const url = u.searchParams.get('url') || '';
    const img = u.searchParams.get('img') || '';
    const id = url.replace(/[^a-zA-Z0-9]/g, '_');
    favAdd({ id, title, url, img, source: 'youzisp.tv' });
    res.writeHead(302, { 'Location': '/favorites' });
    return res.end();
  }

  // 收藏页
  if (path === '/favorites') {
    return send(res, 200, favoritesHtml(), 'text/html; charset=utf-8');
  }

  // 历史页
  if (path === '/history') {
    return send(res, 200, historyHtml(), 'text/html; charset=utf-8');
  }

  send(res, 404, 'Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[youzisp.tv-proxy] http://0.0.0.0:${PORT}`);
});