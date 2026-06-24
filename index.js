const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 9978;
const HOST = '0.0.0.0';
const AYF = 'https://www.yfvod.com';
const TMDB_KEY = '304ca56b1b7b57ca7a47d9b59946be94';
const TMDB_BASE = 'https://api.tmdb.org/3';
const cache = new Map();

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
  return String(s || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function buildUrl(cid, page) {
  page = parseInt(page || 1);
  if (page <= 1) return `${AYF}/vod-show/${cid}-----------.html`;
  return `${AYF}/vod-show/${cid}--------${page}---.html`;
}

function buildSearchUrl(wd, page) {
  page = parseInt(page || 1);
  return `${AYF}/vod-search/${encodeURIComponent(wd || '')}----------${page}---.html`;
}

function fetchText(target, cb) {
  const hit = cache.get(target);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return cb(null, hit.v, 200, true);
  const u = new URL(target);
  const req = https.request(u, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      'Referer': AYF + '/',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'identity'
    },
    timeout: 15000
  }, r => {
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      cache.set(target, { t: Date.now(), v: text });
      console.log(`[proxy] ${r.statusCode} ${target} len=${text.length}`);
      cb(null, text, r.statusCode || 200, false);
    });
  });
  req.on('timeout', () => req.destroy(new Error('request timeout')));
  req.on('error', e => cb(e));
  req.end();
}

function attr(str, name) {
  const m = str.match(new RegExp(name + '=([\"\'])([\\s\\S]*?)\\1', 'i'));
  return m ? m[2] : '';
}
function strip(s) { return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function pickText(html, cls) {
  const re = new RegExp(`<[^>]*class=["'][^"']*${cls}[^"']*["'][^>]*>[\\s\\S]*?<\\/[^>]+>`, 'i');
  return strip((html.match(re) || [''])[0]);
}
function pickClassTexts(html, cls) {
  const out = []; const re = new RegExp(`<[^>]*class=["'][^"']*${cls}[^"']*["'][^>]*>[\\s\\S]*?<\\/[^>]+>`, 'ig');
  let m; while ((m = re.exec(html))) { const t = strip(m[0]); if (t) out.push(t); }
  return out;
}
function cleanText(s) { return strip(String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;nbsp;/g, ' ')); }
function isGoodMeta(t) { t = cleanText(t); return t && t.length <= 24 && !/[，。！？；：]/.test(t) && (t.match(/\//g) || []).length <= 2; }
function uniq(arr) { return arr.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i); }
function inferStatus(raw) { raw = cleanText(raw); const m = raw.match(/(更新至\d+集|全\d+集|第\d+集|正片|高清版|剧集|豆瓣高分)/); return m ? m[1] : ''; }
function inferMeta(raw, title, score) {
  raw = cleanText(raw).replace(cleanText(title), '').replace(score || '', ' ');
  const out = []; const year = (cleanText(title).match(/(?:19|20)\d{2}/) || raw.match(/(?:19|20)\d{2}/) || [''])[0];
  if (year) out.push(year);
  ['大陆','内地','香港','台湾','欧美','美国','日本','韩国','泰国','新马','英国','法国','印度','其它'].forEach(v => { if (raw.indexOf(v) > -1) out.push(v); });
  ['国产','连续剧','电影','综艺','动漫','剧情','爱情','古装','动作','喜剧','悬疑','惊悚','犯罪','恐怖','科幻','奇幻','战争','冒险','纪录','动画','家庭','历史','武侠'].forEach(v => { if (raw.indexOf(v) > -1) out.push(v); });
  return uniq(out).slice(0, 5);
}

function parseCards(html) {
  const cards = []; const reg = /<li\b[\s\S]*?<\/li>/gi; let m;
  while ((m = reg.exec(html))) {
    const li = m[0]; if (!/hl-list-item/.test(li)) continue;
    const a = (li.match(/<a\b[\s\S]*?>/i) || [''])[0];
    const href = attr(a, 'href'); const title = attr(a, 'title') || strip(a);
    if (!href || !title) continue;
    const imgTag = (li.match(/<img\b[\s\S]*?>/i) || [''])[0];
    const img = attr(a, 'data-original') || attr(imgTag, 'data-original') || attr(imgTag, 'src');
    const rawText = cleanText(li);
    const tag = cleanText(pickText(li, 'state')) || cleanText(pickText(li, 'version'));
    const status = cleanText(pickText(li, 'remarks')) || inferStatus(rawText);
    const sub = cleanText(pickText(li, 'hl-item-sub'));
    const score = cleanText(pickText(li, 'score'));
    const extra = pickClassTexts(li, 'hl-lc-').map(cleanText).filter(t => t && t !== title && t !== status && t !== score);
    const metaExtra = extra.filter(isGoodMeta).slice(0, 4);
    const descExtra = extra.filter(t => !isGoodMeta(t)).sort((a, b) => b.length - a.length)[0] || '';
    const inferredMeta = inferMeta(rawText, title, score);
    const meta = [score ? '⭐ ' + score : ''].concat(uniq(metaExtra.concat(inferredMeta))).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(' ｜ ');
    cards.push({ title, url: href, img: img && img.startsWith('http') ? img : (img ? AYF + img : ''), tag, status, desc: descExtra || sub, meta, score });
  }
  return cards;
}

function categoryHtml(cid, name) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#1e90ff,#ff6347);color:#fff;min-height:100vh}.wrap{padding:14px}.title{font-size:18px;font-weight:700;margin:4px 0 14px}.gr{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.card{background:rgba(22,22,40,.58);border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,.1)}.poster{position:relative;background:#161628}.poster img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block}.badge{position:absolute;right:5px;top:5px;max-width:85%;padding:2px 6px;border-radius:6px;background:linear-gradient(90deg,rgba(255,193,7,.95),rgba(255,152,0,.92));font-size:10px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px #000}.ptext{position:absolute;right:6px;bottom:6px;left:6px;text-align:right;font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.info{padding:6px 4px;text-align:center}.name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.desc{font-size:10px;color:#ffd966;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}@media(min-width:600px){.gr{grid-template-columns:repeat(4,1fr)}}@media(min-width:900px){.gr{grid-template-columns:repeat(5,1fr)}}
</style></head><body>
<div class="wrap"><div class="title" id="title">${esc(name)}（0部）</div><div class="gr" id="grid"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var cid=${JSON.stringify(cid)},page=0,loading=false,finished=false,count=0;
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.yfvod.com'+item.url;try{parent.postMessage({type:'ayfDetail',item:item},'*')}catch(e){location.href=item.url}}
function card(it){var d=document.createElement('div');d.className='card';d.innerHTML='<div class="poster"><img loading="lazy" src="'+(it.img||'')+'">'+(it.tag?'<span class="badge">'+it.tag+'</span>':'')+(it.status?'<span class="ptext">'+it.status+'</span>':'')+'</div><div class="info"><div class="name">'+it.title+'</div><div class="desc">'+(it.score?'⭐ '+it.score:'')+'</div></div>';d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/api?cid='+cid+'&page='+next).then(r=>r.json()).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent='— 已显示全部 —';return}page=next;j.items.forEach(function(it){el('#grid').appendChild(card(it));count++});el('#title').textContent=${JSON.stringify(name)}+'（'+count+'部）';el('#tip').textContent='已加载 '+count+' 部，下滑继续加载'}).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)}).finally(()=>loading=false)}
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});io.observe(el('#tip'));load();
</script></body></html>`;
}

function searchHtml(wd) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>搜索 ${esc(wd)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#1e90ff,#ff6347);color:#fff;min-height:100vh}.top{position:sticky;top:0;z-index:5;padding:10px;background:rgba(15,20,40,.82);backdrop-filter:blur(10px);display:flex;gap:8px}.inp{flex:1;border:0;border-radius:18px;padding:9px 12px;background:rgba(255,255,255,.16);color:#fff;outline:0}.inp::placeholder{color:rgba(255,255,255,.65)}.sbtn{border:0;border-radius:18px;padding:8px 14px;background:#4fc3f7;color:#fff;font-weight:700}.wrap{padding:14px}.title{font-size:18px;font-weight:700;margin:4px 0 14px}.list{display:flex;flex-direction:column;gap:12px}.row{display:flex;gap:12px;background:rgba(22,22,40,.58);border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.1);padding:9px}.sposter{position:relative;flex:0 0 112px;width:112px;height:150px;background:#161628;border-radius:9px;overflow:hidden}.sposter img{width:100%;height:100%;object-fit:cover;display:block}.sbadge{position:absolute;right:5px;top:5px;max-width:90%;padding:3px 7px;border-radius:6px;background:linear-gradient(90deg,rgba(255,193,7,.95),rgba(255,152,0,.92));font-size:11px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px #000}.sptext{position:absolute;right:7px;bottom:7px;left:7px;text-align:right;font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 3px #000,0 0 6px rgba(0,0,0,.75)}.sinfo{min-width:0;flex:1;max-height:150px;overflow:hidden;padding-top:2px}.sname{font-size:18px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sscore{font-size:13px;color:#bfc3cc;margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sdesc{font-size:13px;color:rgba(255,255,255,.68);margin-top:8px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="top"><input class="inp" id="kw" value="${esc(wd)}" placeholder="搜索影片"><button class="sbtn" id="go">搜索</button></div>
<div class="wrap"><div class="title" id="title">搜索「${esc(wd)}」（0个）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var wd=${JSON.stringify(wd||'')},page=0,loading=false,finished=false,count=0;
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.yfvod.com'+item.url;try{parent.postMessage({type:'ayfDetail',item:item},'*')}catch(e){location.href=item.url}}
function row(it){var d=document.createElement('div');d.className='row';d.innerHTML='<div class="sposter"><img loading="lazy" src="'+(it.img||'')+'">'+(it.tag?'<span class="sbadge">'+it.tag+'</span>':'')+(it.status?'<span class="sptext">'+it.status+'</span>':'')+'</div><div class="sinfo"><div class="sname">'+it.title+'</div><div class="sscore">'+(it.meta||'')+'</div><div class="sdesc">'+(it.desc||'')+'</div></div>';d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished||!wd)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/search-api?wd='+encodeURIComponent(wd)+'&page='+next).then(r=>r.json()).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'未找到匹配内容';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#title').textContent='搜索「'+wd+'」（'+count+'个）';el('#tip').textContent='已加载 '+count+' 个，下滑继续加载'}).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)}).finally(()=>loading=false)}
el('#go').onclick=function(){var q=el('#kw').value.trim();if(q)location.href='/search?wd='+encodeURIComponent(q)};
el('#kw').onkeydown=function(e){if(e.key==='Enter')el('#go').click()};
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});io.observe(el('#tip'));load();
</script></body></html>`;
}

// ==================== TMDB 详情页模板 ====================
function tmdbPageHtml(d, vodUrl, PROF, IMG) {
  const gTags = d.genres.map(g => `<span class=tag>${esc(g)}</span>`).join('');
  const rt = d.rating > 0 ? `<span class=rtag>⭐ ${d.rating.toFixed(1)}</span>` : '';
  const yr = d.year ? `<span class=tag>${d.year}</span>` : '';
  const rm = d.runtime ? `<span class=tag>${d.runtime}分钟</span>` : '';
  const ss = d.seasons ? `<span class=tag>共${d.seasons}季${d.eps}集</span>` : '';
  const castHtml = d.cast.map((c, i) => {
    const img = c.pic ? `<img class=cimg src="${c.pic}" loading=lazy onerror="this.style.display='none'">` : '<div class=cimg style="background:#333;display:flex;align-items:center;justify-content:center;color:#666;font-size:18px">?</div>';
    const safeName = esc(c.name).replace(/'/g, "\\'");
    return `<a class=cast href="/tmdb/person-page?id=${c.id}&name=${encodeURIComponent(c.name)}" target="_self">${img}<div class=cname>${esc(c.name)}</div></a>`;
  }).join('');
  const escJs = s => String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;').replace(/\n/g,'\\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(d.title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow-x:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0e1a;color:#eee}
.bg{position:fixed;top:0;left:0;right:0;height:56vh;overflow:hidden;z-index:0;background:#0a0e1a}
.bg img{width:100%;height:100%;object-fit:cover;object-position:center 20%;filter:brightness(.85)}
.bg .fade{position:absolute;bottom:0;left:0;right:0;height:35%;background:linear-gradient(to top,#0a0e1a 0%,rgba(10,14,26,.6) 50%,transparent 100%)}
.topbar{position:fixed;top:0;left:0;right:0;z-index:20;padding:10px 14px;padding-top:max(10px,env(safe-area-inset-top));display:flex;align-items:center}
.nbtn{background:rgba(0,0,0,.4);backdrop-filter:blur(8px);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}
.content{position:relative;z-index:10;padding-top:max(38vh,env(safe-area-inset-top));padding-bottom:env(safe-area-inset-bottom)}
.hero{padding:40px 16px 0}
.info .t{font-size:22px;font-weight:800;line-height:1.2;margin-bottom:4px;text-shadow:0 2px 8px rgba(0,0,0,.5)}
.info .sub{font-size:12px;color:rgba(255,255,255,.55);margin-bottom:8px}
.info .tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{padding:3px 10px;border-radius:14px;font-size:11px;background:rgba(79,195,247,.15);color:#4fc3f7;border:1px solid rgba(79,195,247,.3)}
.rtag{padding:3px 10px;border-radius:14px;font-size:12px;font-weight:700;background:rgba(255,193,7,.15);color:#ffc107;border:1px solid rgba(255,193,7,.3)}
.play{display:block;margin:18px auto 0;width:calc(100% - 32px);max-width:400px;padding:14px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.25);border-radius:24px;color:#fff;font-size:17px;font-weight:700;cursor:pointer;letter-spacing:1px}
.play:active{transform:scale(.97);background:rgba(255,255,255,.25)}
.sec{padding:20px 16px 0}
.sh{font-size:15px;font-weight:700;color:#fff;margin-bottom:10px}
.desc{font-size:13px;color:rgba(224,224,224,.78);line-height:1.7}
.desc.collapsed{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.desc.expanded{display:block}
.ebtn{background:0;border:0;color:#4fc3f7;font-size:12px;cursor:pointer;padding:4px 0}
.clist{display:flex;gap:14px;overflow-x:auto;padding-bottom:8px;scroll-snap-type:x mandatory}
.clist::-webkit-scrollbar{display:none}
.cast{flex-shrink:0;width:72px;text-align:center;cursor:pointer;scroll-snap-align:start;transition:transform .2s}
.cast:active{transform:scale(.95)}
.cast.active .cimg{border-color:#e50914;box-shadow:0 0 10px rgba(229,9,20,.5)}
.cast.active .cname{color:#e50914}
.cimg{width:62px;height:62px;border-radius:50%;object-fit:cover;background:#222;display:block;margin:0 auto 6px;border:2px solid rgba(255,255,255,.2);transition:all .2s}
.cname{font-size:10px;color:rgba(224,224,224,.85);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:600}
.cchar{font-size:9px;color:rgba(224,224,224,.45);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.pbox{margin-top:12px;background:rgba(255,255,255,.04);border-radius:12px;padding:14px;border:1px solid rgba(255,255,255,.08);display:none;animation:fadeIn .3s}
@keyframes fadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
.pbox.show{display:block}
.pname{font-size:15px;font-weight:700;color:#fff;margin-bottom:8px}
.pbio{font-size:12px;color:rgba(224,224,224,.7);line-height:1.65;margin-bottom:12px}
.pworks{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px}
.pworks::-webkit-scrollbar{display:none}
.pwi{flex-shrink:0;width:80px;cursor:pointer}
.pwi img{width:80px;aspect-ratio:2/3;object-fit:cover;border-radius:6px;display:block;background:#161628}
.pwi .pwt{font-size:10px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(224,224,224,.8)}
.pwi .pwr{font-size:9px;color:#ffc107}
</style></head><body>
<div class=bg>${d.backdrop ? '<img src="' + d.backdrop + '">' : ''}<div class=fade></div></div>
<div class=content>
<div class=hero>
<div class=info>
<div class=t>${esc(d.title)}</div>
<div class=tags>${yr}${rt}${rm}${ss}${gTags}</div>
</div>
</div>
<button class=play onclick="window.parent.postMessage({type:'ayfPlay',url:'${vodUrl.replace(/'/g, "\\'")}'},'*')">▶ 播  放</button>
<div class=sec>
<div class=sh>剧情简介</div>
<div class="desc collapsed" id=desc>${esc(d.overview) || '暂无简介'}</div>
${d.overview.length > 80 ? '<button class=ebtn onclick="var e=document.getElementById(\'desc\');e.classList.toggle(\'collapsed\');e.classList.toggle(\'expanded\');this.textContent=e.classList.contains(\'collapsed\')?\'展开全文\':\'收起\'">展开全文</button>' : ''}
</div>
${d.cast.length ? '<div class=sec><div class=sh>演职人员</div><div class=clist id=cList>' + castHtml + '</div><div class=pbox id=pBox></div></div>' : ''}
<div style="height:40px"></div>
</div>
<div class=topbar><button class=nbtn onclick="window.parent.postMessage({type:'ayfClose'},'*')">‹</button></div>
<script>
var PROF='${PROF}',IMG='${IMG}';
var _pcache={};
function loadPerson(id,name,el){
  alert('click id='+id+' name='+name);
  var box=document.getElementById('pBox');
  alert('pBox='+(box?'found':'null'));
  document.querySelectorAll('.cast').forEach(function(c){c.classList.remove('active')});
  if(el)el.classList.add('active');
  if(_pcache[id]){_rP(box,_pcache[id],name);box.classList.add('show');box.scrollIntoView({behavior:'smooth',block:'nearest'});return;}
  box.innerHTML='<div style="text-align:center;padding:16px;color:rgba(255,255,255,.4);font-size:12px">加载中...</div>';
  box.classList.add('show');
  fetch('/tmdb/person/'+id+'?language=zh-CN&append_to_response=combined_credits').then(function(r){
    alert('fetch status='+r.status);
    return r.json();
  }).then(function(data){
    alert('data keys='+Object.keys(data).join(','));
    _pcache[id]=data;
    try{_rP(box,data,name);box.classList.add('show');}catch(e){alert('_rP error:'+e.message);}
  }).catch(function(e){alert('fetch error:'+(e.message||e));});
}
function _rP(box,data,name){
  var bio=data.biography||'暂无简介';
  var works=(data.combined_credits&&data.combined_credits.cast||[])
    .filter(function(w){return(w.media_type==='movie'||w.media_type==='tv')&&w.vote_average>0;})
    .sort(function(a,b){return(b.vote_average||0)-(a.vote_average||0);}).slice(0,15);
  var wh=works.map(function(w){
    var t=w.title||w.name||'';
    var p=w.poster_path?IMG+w.poster_path:'';
    var r=w.vote_average?w.vote_average.toFixed(1):'';
    var im=p?'<img src="'+p+'" loading=lazy onerror="this.style.background=\'#333\'">':'<div style="width:80px;height:120px;background:#222;border-radius:6px"></div>';
    var safeT = t.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
    return '<div class=pwi onclick="window.parent.postMessage({type:\'ayfSearch\',query:\''+safeT+'\'},\'*\')">'+im+'<div class=pwt>'+t+'</div>'+(r?'<div class=pwr>⭐ '+r+'</div>':'')+'</div>';
  }).join('');
  box.innerHTML='<div class=pname>'+name+'</div><div class=pbio>'+bio+'</div>'+(wh?'<div class=pworks>'+wh+'</div>':'');
}


</script>
</body></html>`;
}

// ==================== 服务端 ====================
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (u.pathname === '/health') return send(res, 200, 'ok');
    if (u.pathname === '/category') {
      return send(res, 200, categoryHtml(u.searchParams.get('cid') || '1', u.searchParams.get('name') || '电影'), 'text/html; charset=utf-8');
    }
    if (u.pathname === '/search') {
      return send(res, 200, searchHtml(u.searchParams.get('wd') || ''), 'text/html; charset=utf-8');
    }
    if (u.pathname === '/api') {
      const cid = u.searchParams.get('cid') || '1';
      const page = u.searchParams.get('page') || '1';
      return fetchText(buildUrl(cid, page), (err, html, status, cached) => {
        if (err) return send(res, 500, JSON.stringify({ ok:false, error: err.message || String(err) }), 'application/json; charset=utf-8');
        send(res, 200, JSON.stringify({ ok:true, status, cached, items: parseCards(html) }), 'application/json; charset=utf-8');
      });
    }
    if (u.pathname === '/search-api') {
      const wd = u.searchParams.get('wd') || '';
      const page = u.searchParams.get('page') || '1';
      return fetchText(buildSearchUrl(wd, page), (err, html, status, cached) => {
        if (err) return send(res, 500, JSON.stringify({ ok:false, error: err.message || String(err) }), 'application/json; charset=utf-8');
        send(res, 200, JSON.stringify({ ok:true, status, cached, items: parseCards(html) }), 'application/json; charset=utf-8');
      });
    }
    if (u.pathname === '/proxy') {
      const target = u.searchParams.get('url');
      const raw = u.searchParams.get('raw');
      return fetchText(target, (err, body) => {
        if (err) return send(res, 500, err.message);
        send(res, 200, body, raw === '1' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8');
      });
    }
    if (u.pathname === '/tmdb/person-page') {
      const id = u.searchParams.get('id') || '';
      const name = u.searchParams.get('name') || '';
      if (!id) return send(res, 400, 'missing id');
      const PP_IMG = 'https://images.tmdb.org/t/p/w500';
      const PP_PROF = 'https://image.tmdb.org/t/p/w185';
      const pUrl = `${TMDB_BASE}/person/${id}?api_key=${TMDB_KEY}&language=zh-CN&append_to_response=combined_credits`;
      return fetchText(pUrl, (e, json) => {
        if (e) return send(res, 500, 'fetch error');
        try {
          const data = JSON.parse(json);
          const bio = data.biography || '暂无简介';
          const photo = data.profile_path ? PP_PROF + data.profile_path : '';
          const works = ((data.combined_credits && data.combined_credits.cast) || [])
            .filter(w => (w.media_type === 'movie' || w.media_type === 'tv') && w.vote_average > 0)
            .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))
            .slice(0, 18);
          const worksHtml = works.map(w => {
            const t = w.title || w.name || '';
            const p = w.poster_path ? PP_IMG + w.poster_path : '';
            const r = w.vote_average ? w.vote_average.toFixed(1) : '';
            const imgHtml = p ? '<img src="'+p+'" loading=lazy>' : '<div style="width:80px;height:120px;background:#222;border-radius:6px"></div>';
            const safeT = esc(t).replace(/'/g, "\\'");
            return '<div class=pwi onclick="window.parent.postMessage({type:\'ayfSearch\',query:\''+safeT+'\'},\'*\')">'+imgHtml+'<div class=pwt>'+esc(t)+'</div>'+(r?'<div class=pwr>⭐ '+r+'</div>':'')+'</div>';
          }).join('');
          const html = '<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>'+esc(name)+'</title><style>*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}html,body{height:100%;overflow-x:hidden}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0e1a;color:#eee}.topbar{position:sticky;top:0;z-index:10;padding:10px 14px;background:rgba(15,20,40,.88);backdrop-filter:blur(10px);display:flex;align-items:center;gap:10px}.nbtn{background:rgba(255,255,255,.15);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}.wrap{max-width:600px;margin:0 auto;padding:16px}.photo{display:flex;gap:16px;align-items:flex-start;margin-bottom:20px}.photo img{width:100px;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,.4)}.nm{font-size:22px;font-weight:800;line-height:1.2}.bio{font-size:13px;color:rgba(224,224,224,.78);line-height:1.7;margin-bottom:20px}.stitle{font-size:15px;font-weight:700;color:#fff;margin-bottom:12px}.pworks{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.pwi{cursor:pointer;background:rgba(22,22,40,.6);border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,.06);transition:transform .2s}.pwi:active{transform:scale(.96)}.pwi img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;background:#161628}.pwi .pwt{padding:4px 6px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(224,224,224,.9)}.pwi .pwr{padding:0 6px 6px;font-size:10px;color:#ffc107}</style></head><body><div class=topbar><button class=nbtn onclick="history.back()">‹</button><div style="font-size:16px;font-weight:700">'+esc(name)+'</div></div><div class=wrap>'+(photo?'<div class=photo><img src="'+photo+'"><div class=nm>'+esc(name)+'</div></div>':'')+'<div class=bio>'+esc(bio)+'</div>'+(worksHtml?'<div class=stitle>相关作品</div><div class=pworks>'+worksHtml+'</div>':'')+'</div></body></html>';
          send(res, 200, html, 'text/html; charset=utf-8');
        } catch (err) { send(res, 500, 'parse error'); }
      });
    }
    if (u.pathname.startsWith('/tmdb/')) {
      const apiPath = u.pathname.replace(/^\/tmdb\//, '');
      const params = new URLSearchParams(u.search);
      params.set('api_key', TMDB_KEY);
      if (!params.has('language')) params.set('language', 'zh-CN');
      const tmdbUrl = `${TMDB_BASE}/${apiPath}?${params.toString()}`;
      return fetchText(tmdbUrl, (err, json) => {
        if (err) return send(res, 500, JSON.stringify({ ok:false, error: err.message||String(err) }), 'application/json; charset=utf-8');
        send(res, 200, json, 'application/json; charset=utf-8');
      });
    }
    if (u.pathname === '/tmdb-page') {
      const title = u.searchParams.get('title') || '';
      const vodUrl = u.searchParams.get('url') || '';
      if (!title) return send(res, 400, 'missing title');
      const cleanName = title.replace(/\(?\d{4}\)?$/, '').replace(/第\d+集$/, '').trim();
      const IMG = 'https://images.tmdb.org/t/p/w500';
      const IMG_LG = 'https://images.tmdb.org/t/p/w1280';
      const PROF = 'https://image.tmdb.org/t/p/w185';

      function tmdbSearch(kw, cb) {
        fetchText(`${TMDB_BASE}/search/multi?api_key=${TMDB_KEY}&language=zh-CN&query=${encodeURIComponent(kw)}&include_adult=false&page=1`, (e, json) => {
          if (e) return cb(e);
          try {
            const data = JSON.parse(json);
            const results = (data.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
            const cl = s => (s||'').replace(/[\s\u3000]/g,'').toLowerCase();
            const t = cl(kw); let m = results[0] || null;
            for (const r of results) { if (cl(r.title)===t||cl(r.original_title)===t) { m=r; break; } }
            if (!m) for (const r of results) { if (cl(r.title).includes(t)||t.includes(cl(r.title))) { m=r; break; } }
            cb(null, m);
          } catch(err) { cb(err); }
        });
      }
      function tmdbDetail(id, type, cb) {
        fetchText(`${TMDB_BASE}/${type}/${id}?api_key=${TMDB_KEY}&language=zh-CN&append_to_response=credits,similar`, (e, json) => {
          if (e) return cb(e);
          try { cb(null, JSON.parse(json)); } catch(err) { cb(err); }
        });
      }

      return tmdbSearch(cleanName, (err, match) => {
        if (err || !match) { res.writeHead(302, { 'Location': vodUrl || AYF }); return res.end(); }
        tmdbDetail(match.id, match.media_type, (err2, detail) => {
          if (err2 || !detail) { res.writeHead(302, { 'Location': vodUrl || AYF }); return res.end(); }
          const d = {
            title: detail.title || detail.name || title,
            orig: detail.original_title || detail.original_name || '',
            poster: detail.poster_path ? IMG + detail.poster_path : '',
            backdrop: detail.backdrop_path ? IMG_LG + detail.backdrop_path : '',
            rating: detail.vote_average || 0,
            year: (detail.release_date || detail.first_air_date || '').substring(0, 4),
            runtime: detail.runtime || (detail.episode_run_time && detail.episode_run_time[0]) || 0,
            genres: (detail.genres || []).map(g => g.name),
            overview: detail.overview || '',
            status: detail.status || '',
            seasons: detail.number_of_seasons || 0,
            eps: detail.number_of_episodes || 0,
            cast: ((detail.credits && detail.credits.cast) || []).slice(0, 15).map(c => ({
              id: c.id, name: c.name, ch: c.character || '',
              pic: c.profile_path ? PROF + c.profile_path : ''
            })),
            similar: (detail.similar ? detail.similar.results || [] : []).slice(0, 12).map(s => ({
              title: s.title || s.name || '',
              pic: s.poster_path ? IMG + s.poster_path : '',
              rating: s.vote_average ? s.vote_average.toFixed(1) : ''
            }))
          };
          send(res, 200, tmdbPageHtml(d, vodUrl, PROF, IMG), 'text/html; charset=utf-8');
        });
      });
    }
    send(res, 404, 'not found');
  } catch (e) {
    send(res, 500, e.message || String(e));
  }
});

server.listen(PORT, HOST, () => console.log(`AYF page proxy running: http://127.0.0.1:${PORT}`));
setInterval(() => console.log('AYF page proxy keep alive'), 60 * 1000);