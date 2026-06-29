const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 9979;
const SITE = 'https://www.1905dsj.com';
const TMDB_KEY = '304ca56b1b7b57ca7a47d9b59946be94';
const TMDB_BASE = 'https://api.tmdb.org/3';
const cache = new Map();

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

function strip(s) { return String(s||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim(); }
function urlFix(img) { return img && img.startsWith('http') ? img : (img ? SITE + img : ''); }

// 解析影片列表（通用）
function parseCards(html) {
  const cards = [];
  const reg = /<li class="hl-list-item[\s\S]*?<\/li>/gi;
  let m;
  while ((m = reg.exec(html))) {
    const li = m[0];
    const a = li.match(/<a[^>]*href="([^"]*?)"[^>]*title="([^"]*?)"[^>]*data-original="([^"]*?)"/);
    if (!a) continue;
    const remarks = (li.match(/class="[^"]*remarks[^"]*">([^<]*)<\/span>/) || ['',''])[1].trim();
    const sub = (li.match(/class="hl-item-sub[^"]*">([\s\S]*?)<\/div>/) || ['',''])[1];
    cards.push({
      title: a[2],
      url: a[1],
      img: urlFix(a[3]),
      tag: remarks,
      desc: strip(sub)
    });
  }
  return cards;
}

// 解析最新页面（map列表格式）
function parseMapItems(html) {
  const items = [];
  const reg = /<li class="hl-list-item[^"]*">([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = reg.exec(html))) {
    const li = m[1];
    const href = (li.match(/href="([^"]*?)"/) || ['',''])[1];
    const title = (li.match(/class="hl-item-title[^"]*">([^<]*)/) || ['',''])[1].trim();
    const img = (li.match(/data-original="([^"]*?)"/) || ['',''])[1];
    const status = (li.match(/hl-text-subs hl-hidden-xs">\s*\/\s*([^<]*)/) || ['',''])[1].trim();
    const cat = (li.match(/hl-item-datas[^>]*>\s*([\s\S]*?)\s*<\/div>/) || ['',''])[1];
    const time = (li.match(/hl-item-time[^>]*>([\s\S]*?)<\/div>/) || ['',''])[1];
    if (title && href) {
      items.push({
        title: title,
        url: href,
        img: urlFix(img),
        tag: strip(cat),
        desc: (strip(status) + ' ' + strip(time)).trim()
      });
    }
  }
  return items;
}

// 解析排行页面（rank列表格式）
function parseRankItems(html) {
  const items = [];
  const reg = /<li class="hl-list-item[^"]*">([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = reg.exec(html))) {
    const li = m[1];
    const a = li.match(/<a[^>]*href="([^"]*?)"[^>]*title="([^"]*?)"[^>]*data-original="([^"]*?)"/);
    if (!a) continue;
    const remarks = (li.match(/class="hl-item-remarks[^"]*">([\s\S]*?)<\/div>/) || ['',''])[1].trim();
    const sub = (li.match(/class="hl-item-sub[^"]*">([\s\S]*?)<\/div>/) || ['',''])[1];
    const hits = (li.match(/class="hl-item-hits[^"]*">([\s\S]*?)<\/div>/) || ['',''])[1];
    const hitsNum = strip(hits).replace(/人气指数/g, '').trim();
    items.push({
      title: a[2],
      url: a[1],
      img: urlFix(a[3]),
      tag: strip(remarks),
      desc: strip(sub) + (hitsNum ? ' 🔥' + hitsNum : '')
    });
  }
  return items;
}

// 解析专题列表页面
function parseTopicItems(html) {
  const items = [];
  const reg = /<li class="hl-list-item[^"]*">[\s\S]*?<\/li>/gi;
  let m;
  while ((m = reg.exec(html))) {
    const li = m[0];
    const a = li.match(/<a[^>]*href="([^"]*?)"[^>]*title="([^"]*?)"[^>]*data-original="([^"]*?)"/);
    if (!a) continue;
    const remarks = (li.match(/class="remarks[^"]*">([^<]*)/) || ['',''])[1].trim();
    items.push({
      title: a[2],
      url: a[1],
      img: urlFix(a[3]),
      tag: remarks,
      desc: ''
    });
  }
  return items;
}

// ========== 首页数据API ==========
function handleHomeApi(res) {
  fetchPage(SITE + '/', (err, html) => {
    if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
    
    // 轮播
    const lunbos = [];
    const lunboReg = /<li class="hl-br-item swiper-slide">([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = lunboReg.exec(html)) && lunbos.length < 8) {
      const b = m[1];
      const href = (b.match(/href="([^"]*?)"/) || ['',''])[1];
      const title = (b.match(/title="([^"]*?)"/) || ['',''])[1];
      const img = (b.match(/data-original="([^"]*?)"/) || ['',''])[1];
      const sub = (b.match(/class="hl-br-sub[^"]*">([\s\S]*?)<\/div>/) || ['',''])[1];
      let type = strip((b.match(/class="hl-br-type[^"]*">([\s\S]*?)<\/[^>]+>/) || ['',''])[1]);
      if (!type) type = strip((b.match(/class="[^"]*hl-br-cate[^"]*">([\s\S]*?)<\/[^>]+>/) || ['',''])[1]);
      if (!type) type = strip((b.match(/class="[^"]*pic-tag[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/) || ['',''])[1]);
      if (!type) type = strip((b.match(/class="[^"]*tag[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/) || ['',''])[1]);
      if (title && href) lunbos.push({ title, url: href, img: urlFix(img), desc: strip(sub), type });
    }
    
    // 热播推荐
    const hotItems = [];
    const hotReg = /<h2[^>]*class="hl-rb-title"[^>]*>[\s\S]*?热播推荐[\s\S]*?<\/h2>[\s\S]*?<ul class="hl-vod-list[^"]*">([\s\S]*?)<\/ul>/;
    const hotMatch = html.match(hotReg);
    if (hotMatch) {
      const cards = parseCards(hotMatch[1]);
      hotItems.push(...cards.slice(0, 9));
    }

    // 各分类模块：用 h2 标签精确匹配分类名
    const sectionNames = ['电影','电视剧','综艺','动漫','短剧'];
    const sections = [];
    if (hotItems.length) sections.push({ title: '热播推荐', items: hotItems });

    for (const name of sectionNames) {
      const secReg = new RegExp('<h2[^>]*class="hl-rb-title"[^>]*>[\\s\\S]*?' + name + '[\\s\\S]*?<\\/h2>[\\s\\S]*?<ul class="hl-vod-list[^"]*">([\\s\\S]*?)<\\/ul>');
      const secMatch = html.match(secReg);
      if (secMatch) {
        const cards = parseCards(secMatch[1]).slice(0, 6);
        if (cards.length) sections.push({ title: name, items: cards });
      }
    }
    
    send(res, 200, JSON.stringify({ok:true, lunbos, sections}), 'application/json');
  });
}

// ========== 分类页HTML ==========
function categoryHtml(cid, name) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#1e90ff,#ff6347);color:#fff;min-height:100vh}
.wrap{padding:14px;padding-top:28px}
.gr{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{background:rgba(22,22,40,.58);border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.08);box-shadow:0 4px 16px rgba(0,0,0,.35);transition:transform .15s}
.card:active{transform:scale(.97)}
.poster{position:relative;background:#161628}
.poster img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block}
.badge{position:absolute;right:5px;top:5px;max-width:85%;padding:2px 6px;border-radius:6px;background:linear-gradient(90deg,rgba(255,193,7,.95),rgba(255,152,0,.92));font-size:10px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px #000}
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
  item.url=/^https?:/.test(item.url)?item.url:'https://www.1905dsj.com'+item.url;
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
    el('#tip').textContent='已加载 '+count+' 部，下滑继续加载';
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

// ========== 搜索页HTML ==========
function latestHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>最新上线</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#1e90ff,#ff6347);color:#fff;min-height:100vh}
.wrap{padding:14px}.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px;background:rgba(22,22,40,.58);border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.08);padding:9px;box-shadow:0 4px 16px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.2);transition:transform .15s}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;background:#161628;border-radius:9px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.smeta{font-size:12px;color:rgba(255,255,255,.7);margin-top:6px;line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="wrap"><div class="title" id="title">🕐 最新上线（0部）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var page=0,loading=false,finished=false,count=0;
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.1905dsj.com'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function row(it){var d=document.createElement('div');d.className='row';var tagHtml=it.tag?'<span class="sptext">'+it.tag+'</span>':'';d.innerHTML='<div class="sposter"><img loading="lazy" src="'+(it.img||'')+'">'+tagHtml+'</div><div class="sinfo"><div class="sname">'+it.title+'</div>'+(it.desc?'<div class="smeta" style="-webkit-line-clamp:5">'+it.desc+'</div>':'')+'</div>';var img=d.querySelector('.sposter img');if(img){img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'}}d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/latest-api?page='+next).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'暂无数据';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#title').textContent='🕐 最新上线（'+count+'部）';el('#tip').textContent='已加载 '+count+' 部，下滑继续加载'}).catch(e=>{loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败：'+(e.message||e)+'</span><br><button onclick="loading=false;load()" style="margin-top:8px;padding:6px 16px;border-radius:8px;border:0;background:rgba(255,255,255,.2);color:#fff;cursor:pointer">重试</button>'})}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
<\/script></body></html>`;
}

function rankHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>热门排行</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#1e90ff,#ff6347);color:#fff;min-height:100vh}
.tabs{display:flex;gap:8px;padding:10px 14px 0;overflow-x:auto;-webkit-overflow-scrolling:touch}.tabs::-webkit-scrollbar{display:none}.tab{flex-shrink:0;padding:6px 16px;border-radius:20px;font-size:13px;font-weight:600;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.15);cursor:pointer;transition:all .2s;white-space:nowrap}.tab.on{background:rgba(255,255,255,.3);border-color:rgba(255,255,255,.4)}
.wrap{padding:14px}.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px;background:rgba(22,22,40,.58);border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.08);padding:9px;box-shadow:0 4px 16px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.2);transition:transform .15s}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;background:#161628;border-radius:9px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.smeta{font-size:12px;color:rgba(255,255,255,.7);margin-top:6px;line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}.rank-badge{position:absolute;top:7px;left:7px;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.5)}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="tabs" id="tabs"></div>
<div class="wrap"><div class="title" id="title">🔥 热门排行（0部）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var tabs=[{name:'总榜',type:'rank'},{name:'月榜',type:'rankmonth'},{name:'周榜',type:'rankweek'}];
var curType='rank',page=0,loading=false,finished=false,count=0;
var rankColors=['#FF4757','#FF6B81','#FFA502','#7EC8E3','#7EC8E3','#7EC8E3'];
function el(s){return document.querySelector(s)}
function initTabs(){var c=document.getElementById('tabs');tabs.forEach(function(tab,i){var t=document.createElement('div');t.className='tab'+(i===0?' on':'');t.textContent=tab.name;t.onclick=function(){document.querySelectorAll('.tab').forEach(function(b){b.className='tab'});t.className='tab on';curType=tab.type;page=0;finished=false;count=0;el('#list').innerHTML='';el('#title').textContent='🔥 热门排行（0部）';load()};c.appendChild(t)})}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.1905dsj.com'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function row(it,idx){var d=document.createElement('div');d.className='row';var tagHtml=it.tag?'<span class="sptext">'+it.tag+'</span>':'';var badge=idx<6?'<div class="rank-badge" style="background:'+rankColors[idx]+'">'+(idx+1)+'</div>':'';d.innerHTML='<div class="sposter"><img loading="lazy" src="'+(it.img||'')+'">'+tagHtml+badge+'</div><div class="sinfo"><div class="sname">'+it.title+'</div>'+(it.desc?'<div class="smeta" style="-webkit-line-clamp:5">'+it.desc+'</div>':'')+'</div>';var img=d.querySelector('.sposter img');if(img){img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'}}d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/rank-api?page='+next+'&type='+curType).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'暂无数据';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it,count));count++});el('#title').textContent='🔥 热门排行（'+count+'部）';el('#tip').textContent='已加载 '+count+' 部，下滑继续加载'}).catch(e=>{loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败：'+(e.message||e)+'</span><br><button onclick="loading=false;load()" style="margin-top:8px;padding:6px 16px;border-radius:8px;border:0;background:rgba(255,255,255,.2);color:#fff;cursor:pointer">重试</button>'})}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));initTabs();load();
<\/script></body></html>`;
}

function topicHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>专题</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#1e90ff,#ff6347);color:#fff;min-height:100vh}
.wrap{padding:14px}.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:14px}
.card{position:relative;border-radius:14px;overflow:hidden;background:rgba(22,22,40,.58);border:1px solid rgba(255,255,255,.08);box-shadow:0 4px 16px rgba(0,0,0,.35);transition:transform .15s;cursor:pointer}.card:active{transform:scale(.98)}
.card img{width:100%;height:180px;object-fit:cover;display:block}
.card-overlay{position:absolute;bottom:0;left:0;right:0;padding:14px 16px 12px;background:linear-gradient(transparent,rgba(0,0,0,.85));display:flex;align-items:flex-end;justify-content:space-between}
.card-title{font-size:17px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.card-count{font-size:12px;color:rgba(255,255,255,.75);background:rgba(255,255,255,.15);border-radius:10px;padding:2px 10px;flex-shrink:0;margin-left:8px}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="wrap"><div class="title" id="title">📋 专题（0个）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var page=0,loading=false,finished=false,count=0;
function el(s){return document.querySelector(s)}
function openTopic(it){location.href='/topic-detail?url='+encodeURIComponent(it.url)+'&title='+encodeURIComponent(it.title)}
function row(it){var d=document.createElement('div');d.className='card';d.innerHTML='<img loading="lazy" src="'+(it.img||'')+'"><div class="card-overlay"><div class="card-title">'+it.title+'</div>'+(it.tag?'<div class="card-count">'+it.tag+'</div>':'')+'</div>';var img=d.querySelector('img');if(img){img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/600/300'}}d.onclick=function(){openTopic(it)};return d}
function load(){if(loading||finished)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/topic-api?page='+next).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'暂无数据';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#title').textContent='📋 专题（'+count+'个）';el('#tip').textContent='已加载 '+count+' 个，下滑继续加载'}).catch(e=>{loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败：'+(e.message||e)+'</span><br><button onclick="loading=false;load()" style="margin-top:8px;padding:6px 16px;border-radius:8px;border:0;background:rgba(255,255,255,.2);color:#fff;cursor:pointer">重试</button>'})}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
<\/script></body></html>`;
}

function topicDetailHtml(topicUrl, topicTitle) {
  const escUrl = topicUrl.replace(/'/g, "\\'");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(topicTitle)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#1e90ff,#ff6347);color:#fff;min-height:100vh}
.topbar{display:flex;align-items:center;padding:10px 14px;gap:10px}.back{background:rgba(0,0,0,.4);backdrop-filter:blur(8px);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}.toptitle{font-size:16px;font-weight:700}
.wrap{padding:14px}.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px;background:rgba(22,22,40,.58);border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.08);padding:9px;box-shadow:0 4px 16px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.2);transition:transform .15s}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;background:#161628;border-radius:9px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.smeta{font-size:12px;color:rgba(255,255,255,.7);margin-top:6px;line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="topbar"><button class="back" onclick="location.href='/topic'">←</button><div class="toptitle">${esc(topicTitle)}</div></div>
<div class="wrap"><div class="title" id="title">${esc(topicTitle)}（0部）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var page=0,loading=false,finished=false,count=0;
var topicUrl='${escUrl}';
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.1905dsj.com'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function row(it){var d=document.createElement('div');d.className='row';var tagHtml=it.tag?'<span class="sptext">'+it.tag+'</span>':'';d.innerHTML='<div class="sposter"><img loading="lazy" src="'+(it.img||'')+'">'+tagHtml+'</div><div class="sinfo"><div class="sname">'+it.title+'</div>'+(it.desc?'<div class="smeta" style="-webkit-line-clamp:5">'+it.desc+'</div>':'')+'</div>';var img=d.querySelector('.sposter img');if(img){img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'}}d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/topic-detail-api?page='+next+'&url='+encodeURIComponent(topicUrl)).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'暂无数据';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#title').textContent='${esc(topicTitle)}（'+count+'部）';el('#tip').textContent='已加载 '+count+' 部，下滑继续加载'}).catch(e=>{loading=false;el('#tip').innerHTML='<span style="color:#ff6b6b">加载失败：'+(e.message||e)+'</span><br><button onclick="loading=false;load()" style="margin-top:8px;padding:6px 16px;border-radius:8px;border:0;background:rgba(255,255,255,.2);color:#fff;cursor:pointer">重试</button>'})}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
<\/script></body></html>`;
}

function searchHtml(wd) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>搜索 ${esc(wd)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#1e90ff,#ff6347);color:#fff;min-height:100vh}
.wrap{padding:14px}.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px;background:rgba(22,22,40,.58);border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.08);padding:9px;box-shadow:0 4px 16px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.2);transition:transform .15s}.row:active{transform:scale(.98)}.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;background:#161628;border-radius:9px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.sinfo{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center}.sname{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.smeta{font-size:12px;color:rgba(255,255,255,.7);margin-top:6px;line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="wrap"><div class="title" id="title">搜索「${esc(wd)}」（0个）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var wd=${JSON.stringify(wd||'')},page=0,loading=false,finished=false,count=0;
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.1905dsj.com'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function row(it){var d=document.createElement('div');d.className='row';var tagHtml=it.tag?'<span class="sptext">'+it.tag+'</span>':'';d.innerHTML='<div class="sposter"><img loading="lazy" src="'+(it.img||'')+'">'+tagHtml+'</div><div class="sinfo"><div class="sname">'+it.title+'</div>'+(it.desc?'<div class="smeta" style="-webkit-line-clamp:5">'+it.desc+'</div>':'')+'</div>';var img=d.querySelector('.sposter img');if(img){img.onerror=function(){this.src='https://picsum.photos/seed/'+Math.floor(Math.random()*1000)+'/300/400'}}d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished||!wd)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/search-api?wd='+encodeURIComponent(wd)+'&page='+next).then(r=>r.json()).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'未找到匹配内容';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#title').textContent='搜索「'+wd+'」（'+count+'个）';el('#tip').textContent='已加载 '+count+' 个，下滑继续加载'}).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)}).finally(()=>loading=false)}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
<\/script></body></html>`;
}

// ========== TMDB详情页HTML ==========
function tmdbPageHtml(d, vodUrl, fallbackImg) {
  const fullUrl = vodUrl && !/^https?:/.test(vodUrl) ? 'https://www.1905dsj.com' + vodUrl : vodUrl;
  const bgImg = d.backdrop || fallbackImg || '';
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
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,sans-serif;background:rgba(10,14,26,.85);color:#eee}
.bg{position:fixed;top:0;left:0;right:0;height:56vh;overflow:hidden;z-index:0;background:#0a0e1a}.bg img{width:100%;height:100%;object-fit:cover;object-position:center 20%;filter:brightness(.85)}.bg .fade{position:absolute;bottom:0;left:0;right:0;height:35%;background:linear-gradient(to top,#0a0e1a 0%,rgba(10,14,26,.6) 50%,transparent 100%)}
.topbar{position:fixed;top:0;left:0;right:0;z-index:20;padding:10px 14px;display:flex;align-items:center}
.nbtn{background:rgba(0,0,0,.4);backdrop-filter:blur(8px);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}
.fbtn{position:fixed;bottom:24px;right:16px;z-index:30;width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.5);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.fbtn:active{transform:scale(.9)}
.content{position:relative;z-index:10;padding-top:38vh}
.hero{padding:40px 16px 0}.info .t{font-size:22px;font-weight:800;line-height:1.2;margin-bottom:4px;text-shadow:0 2px 8px rgba(0,0,0,.5)}.info .sub{font-size:12px;color:rgba(255,255,255,.55);margin-bottom:8px}.info .tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{padding:3px 10px;border-radius:14px;font-size:11px;background:rgba(79,195,247,.15);color:#4fc3f7;border:1px solid rgba(79,195,247,.3)}.rtag{padding:3px 10px;border-radius:14px;font-size:12px;font-weight:700;background:rgba(255,193,7,.15);color:#ffc107;border:1px solid rgba(255,193,7,.3)}
.play{display:block;margin:18px auto 0;width:calc(100% - 32px);max-width:400px;padding:14px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.25);border-radius:24px;color:#fff;font-size:17px;font-weight:700;cursor:pointer}.play:active{transform:scale(.97)}
.sec{padding:20px 16px 0}.sh{font-size:15px;font-weight:700;margin-bottom:10px}
.desc{font-size:13px;color:rgba(224,224,224,.78);line-height:1.7;white-space:pre-line}
.desc.collapsed{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:normal}
.desc.expanded{display:block;white-space:pre-line}
.ebtn{background:0;border:0;color:#4fc3f7;font-size:12px;cursor:pointer;padding:4px 0}
.clist{display:flex;gap:14px;overflow-x:auto;padding-bottom:8px}.clist::-webkit-scrollbar{display:none}
.cast{flex-shrink:0;width:72px;text-align:center;cursor:pointer;text-decoration:none;color:#eee}.cimg{width:62px;height:62px;border-radius:50%;object-fit:cover;background:#222;display:block;margin:0 auto 6px;border:2px solid rgba(255,255,255,.2)}
.cname{font-size:10px;color:rgba(224,224,224,.85);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:600}
</style></head><body>
<div class=bg>${bgImg?'<img src="'+bgImg+'">':''}<div class=fade></div></div>
<div class=topbar><button class=nbtn onclick="try{parent.postMessage({type:'dsjClose'},'*')}catch(e){history.back()}">←</button></div>
<div class=content><div class=hero><div class=info><div class=t>${esc(d.title)}</div><div class=sub>${esc(d.originalTitle)}</div><div class=tags>${yr}${rm}${ss}${gTags}${rt}</div></div></div>
<button class=play onclick="try{parent.postMessage({type:'dsjPlay',url:'${fullUrl.replace(/'/g, "\\'")}'},'*')}catch(e){window.open('${fullUrl.replace(/'/g, "\\'")}','_blank')}">▶ 进入播放</button>
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
      ? `${SITE}/vod/type/id/${cid}.html`
      : `${SITE}/vod/type/id/${cid}/page/${page}.html`;
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

  // 搜索API
  if (path === '/search-api') {
    const wd = u.searchParams.get('wd') || '';
    const page = parseInt(u.searchParams.get('page') || '1', 10);
    const url = page > 1
      ? `${SITE}/vod/search/page/${page}/wd/${encodeURIComponent(wd)}.html`
      : `${SITE}/vod/search.html?wd=${encodeURIComponent(wd)}`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const items = parseCards(html);
      send(res, 200, JSON.stringify({ok:true, items}), 'application/json');
    });
  }

  // 最新页
  if (path === '/latest') {
    const page = parseInt(u.searchParams.get('page') || '1');
    return send(res, 200, latestHtml(page), 'text/html; charset=utf-8');
  }

  // 最新API
  if (path === '/latest-api') {
    const page = parseInt(u.searchParams.get('page') || '1');
    const url = page <= 1
      ? `${SITE}/index.php/map/index.html`
      : `${SITE}/index.php/map/index/page/${page}.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const items = parseMapItems(html);
      send(res, 200, JSON.stringify({ok:true, items}), 'application/json');
    });
  }

  // 排行页
  if (path === '/rank') {
    const page = parseInt(u.searchParams.get('page') || '1');
    return send(res, 200, rankHtml(page), 'text/html; charset=utf-8');
  }

  // 排行API
  if (path === '/rank-api') {
    const page = parseInt(u.searchParams.get('page') || '1');
    const type = u.searchParams.get('type') || 'rank';
    const url = page <= 1
      ? `${SITE}/index.php/label/${type}.html`
      : `${SITE}/index.php/label/${type}/page/${page}.html`;
    return fetchPage(url, (err, html) => {
      if (err) return send(res, 200, JSON.stringify({ok:false,error:err.message}));
      const items = parseRankItems(html);
      send(res, 200, JSON.stringify({ok:true, items}), 'application/json');
    });
  }

  // 专题页
  if (path === '/topic') {
    return send(res, 200, topicHtml(), 'text/html; charset=utf-8');
  }

  // 专题API
  if (path === '/topic-api') {
    const page = parseInt(u.searchParams.get('page') || '1');
    const url = page <= 1
      ? `${SITE}/index.php/topic/index.html`
      : `${SITE}/index.php/topic/index/page/${page}.html`;
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
        d.overview = '未在 TMDB 匹配到该影片信息，以下为网站数据。';
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
          media_type: w.media_type
        })));
        const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{min-height:100vh;overflow-x:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:rgba(10,14,26,.85);color:#eee}
.topbar{position:sticky;top:0;z-index:10;padding:10px 14px;background:rgba(15,20,40,.88);backdrop-filter:blur(10px);display:flex;align-items:center;gap:10px}
.nbtn{background:rgba(255,255,255,.15);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}
.wrap{max-width:600px;margin:0 auto;padding:16px}
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
.pwi{cursor:pointer;background:rgba(22,22,40,.6);border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,.06);transition:transform .2s}
.pwi:active{transform:scale(.96)}
.pwi img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;background:#161628}
.pwi .pwt{padding:4px 6px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(224,224,224,.9)}
.pwi .pwr{padding:0 6px 6px;font-size:10px;color:#ffc107}
.tip{text-align:center;padding:16px;color:rgba(255,255,255,.5);font-size:13px}
.fbtn{position:fixed;bottom:24px;right:16px;z-index:30;width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.5);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.fbtn:active{transform:scale(.9)}
</style></head><body>
<div class=topbar><button class=nbtn onclick="history.back()">\u2190</button><div style="font-size:16px;font-weight:700">${esc(name)}</div></div>
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
  d.innerHTML=img+'<div class=pwt>'+w.title+'</div>'+(w.rating?'<div class=pwr>\u2b50 '+w.rating+'</div>':'');
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

  send(res, 404, 'Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[1905dsj-proxy] http://0.0.0.0:${PORT}`);
});