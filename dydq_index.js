const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 9978;
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
    const score = (li.match(/class="[^"]*score[^"]*">([^<]*)<\/span>/) || ['',''])[1].trim();
    const sub = (li.match(/class="hl-item-sub[^"]*">([\s\S]*?)<\/div>/) || ['',''])[1];
    cards.push({
      title: a[2],
      url: a[1],
      img: urlFix(a[3]),
      tag: remarks,
      score: score,
      status: remarks,
      desc: strip(sub)
    });
  }
  return cards;
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
      if (title && href) lunbos.push({ title, url: href, img: urlFix(img), desc: strip(sub) });
    }
    
    // 热播推荐
    const hotItems = [];
    const hotReg = /热播推荐[\s\S]*?<ul class="hl-vod-list[^"]*">([\s\S]*?)<\/ul>/;
    const hotMatch = html.match(hotReg);
    if (hotMatch) {
      const cards = parseCards(hotMatch[1]);
      hotItems.push(...cards.slice(0, 9));
    }

    // 各分类模块：按 h2.hl-rb-title 分割
    const sectionNames = ['电影','电视剧','综艺','动漫'];
    const sections = [];
    if (hotItems.length) sections.push({ title: '热播推荐', items: hotItems });

    for (const name of sectionNames) {
      const secReg = new RegExp(name + '[\\s\\S]*?<ul class="hl-vod-list[^"]*">([\\s\\S]*?)<\\/ul>');
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
  var descHtml=(it.score?'⭐ '+it.score:'')+((it.status&&it.status!==it.score)?'<span style="color:rgba(255,255,255,.55);margin-left:6px;font-size:10px">'+it.status+'</span>':'')+((it.desc&&it.desc!==it.score&&it.desc!==it.status)?'<span style="color:rgba(255,255,255,.55);margin-left:6px;font-size:10px">'+it.desc+'</span>':'');
  d.innerHTML='<div class="poster"><img loading="lazy" src="'+(it.img||'')+'">'+(it.tag?'<span class="badge">'+it.tag+'</span>':'')+'</div><div class="info"><div class="name">'+it.title+'</div>'+(descHtml?'<div class="desc">'+descHtml+'</div>':'')+'</div>';
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
function searchHtml(wd) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>搜索 ${esc(wd)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#1e90ff,#ff6347);color:#fff;min-height:100vh}
.top{position:sticky;top:0;z-index:5;padding:10px;background:rgba(15,20,40,.82);backdrop-filter:blur(10px);display:flex;gap:8px}
.inp{flex:1;border:0;border-radius:18px;padding:9px 12px;background:rgba(255,255,255,.16);color:#fff;outline:0}
.inp::placeholder{color:rgba(255,255,255,.65)}
.sbtn{border:0;border-radius:18px;padding:8px 14px;background:#4fc3f7;color:#fff;font-weight:700}
.wrap{padding:14px}.title{font-size:18px;font-weight:700;margin:4px 0 14px}
.list{display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:12px;background:rgba(22,22,40,.58);border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.08);padding:9px;box-shadow:0 4px 16px rgba(0,0,0,.35)}
.row:active{transform:scale(.98)}
.sposter{flex:0 0 112px;width:112px;height:150px;background:#161628;border-radius:9px;overflow:hidden}
.sposter img{width:100%;height:100%;object-fit:cover;display:block}
.sinfo{min-width:0;flex:1;padding-top:2px}
.sname{font-size:18px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sdesc{font-size:13px;color:rgba(255,255,255,.68);margin-top:8px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.tip{text-align:center;padding:18px;color:rgba(255,255,255,.82);font-size:13px}
</style></head><body>
<div class="top"><input class="inp" id="kw" value="${esc(wd)}" placeholder="搜索影片"><button class="sbtn" id="go">搜索</button></div>
<div class="wrap"><div class="title" id="title">搜索「${esc(wd)}」（0个）</div><div class="list" id="list"></div><div class="tip" id="tip">准备加载...</div></div>
<script>
var wd=${JSON.stringify(wd||'')},page=0,loading=false,finished=false,count=0;
function el(s){return document.querySelector(s)}
function openVod(it){var item=Object.assign({},it);item.url=/^https?:/.test(item.url)?item.url:'https://www.1905dsj.com'+item.url;try{parent.postMessage({type:'dsjDetail',item:item},'*')}catch(e){location.href=item.url}}
function row(it){var d=document.createElement('div');d.className='row';d.innerHTML='<div class="sposter"><img loading="lazy" src="'+(it.img||'')+'"></div><div class="sinfo"><div class="sname">'+it.title+'</div><div class="sdesc">'+(it.desc||'')+'</div></div>';d.onclick=function(){openVod(it)};return d}
function load(){if(loading||finished||!wd)return;loading=true;var next=page+1;el('#tip').textContent='正在加载第 '+next+' 页...';fetch('/search-api?wd='+encodeURIComponent(wd)+'&page='+next).then(r=>r.json()).then(j=>{if(!j.ok)throw new Error(j.error||'load failed');if(!j.items.length){finished=true;el('#tip').textContent=count?'— 已显示全部 —':'未找到匹配内容';return}page=next;j.items.forEach(function(it){el('#list').appendChild(row(it));count++});el('#title').textContent='搜索「'+wd+'」（'+count+'个）';el('#tip').textContent='已加载 '+count+' 个，下滑继续加载'}).catch(e=>{el('#tip').textContent='加载失败：'+(e.message||e)}).finally(()=>loading=false)}
el('#go').onclick=function(){var q=el('#kw').value.trim();if(q)location.href='/search?wd='+encodeURIComponent(q)};
el('#kw').onkeydown=function(e){if(e.key==='Enter')el('#go').click()};
var io=new IntersectionObserver(function(es){if(es[0].isIntersecting)load()},{rootMargin:'500px'});
io.observe(el('#tip'));load();
</script></body></html>`;
}

// ========== TMDB详情页HTML ==========
function tmdbPageHtml(d, vodUrl) {
  const fullUrl = vodUrl && !/^https?:/.test(vodUrl) ? 'https://www.1905dsj.com' + vodUrl : vodUrl;
  const gTags = d.genres.map(g=>`<span class=tag>${esc(g)}</span>`).join('');
  const rt = d.rating>0?`<span class=rtag>⭐ ${d.rating.toFixed(1)}</span>`:'';
  const yr = d.year?`<span class=tag>${d.year}</span>`:'';
  const rm = d.runtime?`<span class=tag>${d.runtime}分钟</span>`:'';
  const ss = d.seasons?`<span class=tag>共${d.seasons}季${d.eps}集</span>`:'';
  const castHtml = d.cast.map(c=>{
    const img = c.pic?`<img class=cimg src="${c.pic}" loading=lazy onerror="this.style.display='none'">`:'<div class=cimg style="background:#333;display:flex;align-items:center;justify-content:center;color:#666;font-size:18px">?</div>';
    const safeName = esc(c.name).replace(/'/g, "\\'");
    return `<div class=cast style="cursor:pointer" onclick="parent.postMessage({type:'dsjSearch',query:'${safeName}'},'*')">${img}<div class=cname>${esc(c.name)}</div></div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(d.title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,sans-serif;background:#0a0e1a;color:#eee}
.bg{position:fixed;top:0;left:0;right:0;height:56vh;overflow:hidden;z-index:0;background:#0a0e1a}.bg img{width:100%;height:100%;object-fit:cover;object-position:center 20%;filter:brightness(.85)}.bg .fade{position:absolute;bottom:0;left:0;right:0;height:35%;background:linear-gradient(to top,#0a0e1a 0%,rgba(10,14,26,.6) 50%,transparent 100%)}
.topbar{position:fixed;top:0;left:0;right:0;z-index:20;padding:10px 14px;display:flex;align-items:center}
.nbtn{background:rgba(0,0,0,.4);backdrop-filter:blur(8px);border:0;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:22px;display:flex;align-items:center;justify-content:center}
.content{position:relative;z-index:10;padding-top:38vh}
.hero{padding:40px 16px 0}.info .t{font-size:22px;font-weight:800;line-height:1.2;margin-bottom:4px;text-shadow:0 2px 8px rgba(0,0,0,.5)}.info .sub{font-size:12px;color:rgba(255,255,255,.55);margin-bottom:8px}.info .tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{padding:3px 10px;border-radius:14px;font-size:11px;background:rgba(79,195,247,.15);color:#4fc3f7;border:1px solid rgba(79,195,247,.3)}.rtag{padding:3px 10px;border-radius:14px;font-size:12px;font-weight:700;background:rgba(255,193,7,.15);color:#ffc107;border:1px solid rgba(255,193,7,.3)}
.play{display:block;margin:18px auto 0;width:calc(100% - 32px);max-width:400px;padding:14px;background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.25);border-radius:24px;color:#fff;font-size:17px;font-weight:700;cursor:pointer}.play:active{transform:scale(.97)}
.sec{padding:20px 16px 0}.sh{font-size:15px;font-weight:700;margin-bottom:10px}
.clist{display:flex;gap:14px;overflow-x:auto;padding-bottom:8px}.clist::-webkit-scrollbar{display:none}
.cast{flex-shrink:0;width:72px;text-align:center}.cimg{width:62px;height:62px;border-radius:50%;object-fit:cover;background:#222;display:block;margin:0 auto 6px;border:2px solid rgba(255,255,255,.2)}
.cname{font-size:10px;color:rgba(224,224,224,.85);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:600}
</style></head><body>
<div class=bg>${d.backdrop?'<img src="'+d.backdrop+'">':''}<div class=fade></div></div>
<div class=topbar><button class=nbtn onclick="try{parent.postMessage({type:'dsjClose'},'*')}catch(e){history.back()}">←</button></div>
<div class=content><div class=hero><div class=info><div class=t>${esc(d.title)}</div><div class=sub>${esc(d.originalTitle)}</div><div class=tags>${yr}${rm}${ss}${gTags}${rt}</div></div></div>
<button class=play onclick="try{parent.postMessage({type:'dsjPlay',url:'${fullUrl.replace(/'/g, "\\'")}'},'*')}catch(e){window.open('${fullUrl.replace(/'/g, "\\'")}','_blank')}">▶ 进入播放</button>
${d.overview?'<div class=sec><div class=sh>简介</div><div style="font-size:13px;color:rgba(224,224,224,.78);line-height:1.7">'+esc(d.overview)+'</div></div>':''}
${castHtml?'<div class=sec><div class=sh>主演</div><div class=clist>'+castHtml+'</div></div>':''}
</div></body></html>`;
}

// ========== HTTP路由 ==========
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://0.0.0.0:${PORT}`);
  const path = u.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (path === '/health') return send(res, 200, 'ok');

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
    const url = `${SITE}/vod/search/wd/${encodeURIComponent(wd)}.html`;
    return fetchPage(url, (err, html) => {
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
              d.cast = (det.credits?.cast||[]).slice(0,20).map(c=>({id:c.id,name:c.name,pic:c.profile_path?`https://image.tmdb.org/t/p/w185${c.profile_path}`:''}));
              d.backdrop = det.backdrop_path?`https://image.tmdb.org/t/p/w780${det.backdrop_path}`:'';
              if(mt==='tv'){d.seasons=det.number_of_seasons||0;d.eps=det.number_of_episodes||0;}
            } catch(e){}
            send(res, 200, tmdbPageHtml(d, vodUrl), 'text/html; charset=utf-8');
          });
        }
      } catch(e){}
      send(res, 200, tmdbPageHtml(d, vodUrl), 'text/html; charset=utf-8');
    });
  }

  send(res, 404, 'Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[1905dsj-proxy] http://0.0.0.0:${PORT}`);
});