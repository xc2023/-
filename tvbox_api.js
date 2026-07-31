const { execFile } = require("child_process");

// ========== TVBox API ==========
class TVBoxAPI {
  constructor(config) {
    this.host = config.host;
    this.pkg = config.pkg;
    this.sk = config.sk;
    this.finger = config.finger;
    this.ver = String(config.ver);
    this.updateId = config.updateId;
    this.deviceBrand = config.deviceBrand || 'vivo';
    this.deviceModel = config.deviceModel || 'V2309A';
    this.deviceId = config.deviceId || this._genId(16);
    this._headers = { 'User-Agent': 'okhttp/4.12.0' };
  }
  _genId(len) {
    const chars = '0123456789abcdef';
    let r = '';
    for (let i = 0; i < len; i++) r += chars[Math.floor(Math.random() * chars.length)];
    return r;
  }
  _genNonce(len, chars) {
    chars = chars || '0123456789';
    let r = '';
    for (let i = 0; i < len; i++) r += chars[Math.floor(Math.random() * chars.length)];
    return r;
  }
  _sha256(s) {
    var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else if (c < 2048) { bytes.push(192|(c>>6), 128|(c&63)); }
      else { bytes.push(224|(c>>12), 128|((c>>6)&63), 128|(c&63)); }
    }
    var msgLen = bytes.length;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0x00);
    var lenBits = msgLen * 8;
    for (var i = 56; i >= 0; i -= 8) {
      bytes.push((lenBits / Math.pow(2, i)) & 0xff);
    }
    for (var offset = 0; offset < bytes.length; offset += 64) {
      var W = new Array(64);
      for (var i = 0; i < 16; i++) {
        W[i] = (bytes[offset+i*4] << 24) | (bytes[offset+i*4+1] << 16) | (bytes[offset+i*4+2] << 8) | bytes[offset+i*4+3];
      }
      for (var i = 16; i < 64; i++) {
        var gamma0 = ((W[i-15]>>>7)|(W[i-15]<<25)) ^ ((W[i-15]>>>18)|(W[i-15]<<14)) ^ (W[i-15]>>>3);
        var gamma1 = ((W[i-2]>>>17)|(W[i-2]<<15)) ^ ((W[i-2]>>>19)|(W[i-2]<<13)) ^ (W[i-2]>>>10);
        W[i] = (W[i-16] + gamma0 + W[i-7] + gamma1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3];
      var e = H[4], f = H[5], g = H[6], h = H[7];
      for (var i = 0; i < 64; i++) {
        var Sigma1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + Sigma1 + ch + K[i] + W[i]) | 0;
        var Sigma0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (Sigma0 + maj) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
      H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
      H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var hex = '';
    for (var i = 0; i < 8; i++) {
      var n = H[i];
      hex += ((n>>>28)&0xf).toString(16) + ((n>>>24)&0xf).toString(16) +
             ((n>>>20)&0xf).toString(16) + ((n>>>16)&0xf).toString(16) +
             ((n>>>12)&0xf).toString(16) + ((n>>>8)&0xf).toString(16) +
             ((n>>>4)&0xf).toString(16) + (n&0xf).toString(16);
    }
    return hex;
  }
  _sign(api) {
    var time = Date.now().toString();
    var nonce = 'F827F098' + this._genNonce(8);
    var params = { id: this.pkg, time: time, nonce: nonce, v: this.ver, finger: this.finger, sk: this.sk };
    var keys = Object.keys(params).sort();
    var signStr = keys.map(function(k) { return k + '=' + params[k]; }).join('&');
    var sign = this._sha256(signStr).toUpperCase();
    var headers = Object.assign({}, this._headers, {
      'Accept': 'application/json',
      'x-aid': this.pkg,
      'x-ave': this.ver,
      'x-time': time,
      'x-nonc': nonce,
      'x-sign': sign,
      'x-device-id': this.deviceId,
      'x-device-brand': this.deviceBrand,
      'x-device-model': this.deviceModel,
      'x-platform': 'android',
      'x-update-id': this.updateId
    });
    return headers;
  }
  // decode 接口专用 headers（对齐布布影视.js genHeaders 5个签名header + User-Agent）
  _decodeHeaders() {
    var time = Date.now().toString();
    var nonce = 'F827F098' + this._genNonce(8);
    var signStr = 'finger=' + this.finger + '&id=' + this.pkg + '&nonce=' + nonce + '&sk=' + this.sk + '&time=' + time + '&v=' + this.ver;
    var sign = this._sha256(signStr).toUpperCase();
    return {
      'User-Agent': 'okhttp/4.12.0',
      'x-aid': this.pkg,
      'x-ave': this.ver,
      'x-time': time,
      'x-nonc': nonce,
      'x-sign': sign
    };
  }
  _fetch(url, headers) {
    var h = headers || this._headers;
    return new Promise(function(resolve, reject) {
      var args = ['-s', '--max-time', '15', '-L', '--compressed'];
      for (var k in h) {
        if (h[k] !== undefined && h[k] !== null) {
          args.push('-H', k + ': ' + h[k]);
        }
      }
      args.push(url);
      execFile('curl', args, { timeout: 20000, maxBuffer: 5 * 1024 * 1024 }, function(err, stdout, stderr) {
        if (err) {
          if (err.killed) return reject(new Error('timeout'));
          return reject(err);
        }
        resolve(stdout);
      });
    });
  }
  async get(api, params) {
    var url = this.host + api;
    if (params && Object.keys(params).length > 0) {
      var qs = Object.keys(params).map(function(k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
      url += '?' + qs;
    }
    var headers = this._sign(api, params);
    return await this._fetch(url, headers);
  }
  // decode 接口专用（对齐布布影视.js：URL 手动拼接 + genHeaders 精简header）
  async decodeUrl(url, vodFrom) {
    var apiUrl = this.host + '/api.php/app/decode/url/?url=' + encodeURIComponent(url) + '&vodFrom=' + vodFrom + '&fro=app';
    var headers = this._decodeHeaders();
    return await this._fetch(apiUrl, headers);
  }
  async home() {
    try {
      var data = await this.get('/api.php/app/index/home');
      var json = JSON.parse(data);
      if (json.code !== 200) return { ok: false, error: json.msg, categories: [], lunbos: [], items: [] };
      var d = json.data || {};
      var self = this;
      var self = this;
      var categories = (d.categories || []).map(function(c) {
        return { type_id: c.type_id, type_name: c.type_name, videos: (c.videos || []).map(function(v) { return self._fmtVod(v); }) };
      });
      var lunbos = (d.recommend || []).slice(0, 8).map(function(v) { return { title: v.vod_name || '', img: v.vod_pic || '', url: '/api/parse-play?vod_id=' + v.vod_id }; });
      var items = (d.recommend || []).map(function(v) { return self._fmtVod(v); });
      return { ok: true, categories: categories, lunbos: lunbos, items: items };
    } catch(e) {
      console.error('[TVBox] home error:', e.message);
      return { ok: false, error: e.message, categories: [], lunbos: [], items: [] };
    }
  }
  async category(typeId, page, filters) {
    try {
      var params = { type_name: typeId, page: page || 1, limit: 18 };
      if (filters) { Object.keys(filters).forEach(function(k) { if (filters[k]) params[k] = filters[k]; }); }
      var data = await this.get('/api.php/app/filter/vod', params);
      var json = JSON.parse(data);
      if (json.code !== 200) return { ok: false, error: json.msg, items: [] };
      var self = this;
      return { ok: true, items: (json.data || []).map(function(v) { return self._fmtVod(v); }), page: parseInt(page) };
    } catch(e) {
      console.error('[TVBox] category error:', e.message);
      return { ok: false, error: e.message, items: [] };
    }
  }
  async search(wd, page) {
    try {
      var data = await this.get('/api.php/app/search/index', { wd: wd, page: page || 1, limit: 15 });
      var json = JSON.parse(data);
      if (json.code !== 200) return { ok: false, error: json.msg, items: [] };
      var self = this;
      return { ok: true, items: (json.data || []).map(function(v) { return self._fmtVod(v); }), page: parseInt(page) };
    } catch(e) {
      console.error('[TVBox] search error:', e.message);
      return { ok: false, error: e.message, items: [] };
    }
  }
  async rank(page) {
    try {
      // 用首页接口获取分类及每个分类下的推荐影片，按分类组装排行榜数据
      var data = await this.get('/api.php/app/index/home');
      var json = JSON.parse(data);
      if (json.code !== 200) return { ok: false, error: json.msg, items: [] };
      var d = json.data || {};
      var self = this;
      var categories = d.categories || [];
      var items = [];
      categories.forEach(function(cat) {
        var catName = cat.type_name || '排行榜';
        var videos = cat.videos || [];
        videos.forEach(function(v, i) {
          var formatted = self._fmtVod(v);
          var metaParts = [];
          if (catName) metaParts.push(catName);
          if (formatted.tag) metaParts.push(formatted.tag);
          if (formatted.year) metaParts.push(formatted.year);
          if (formatted.area) metaParts.push(formatted.area);
          if (formatted.class) metaParts.push(formatted.class);
          items.push({
            title: formatted.title,
            url: formatted.url,
            img: formatted.img,
            tag: String(i + 1),
            top: String(i + 1),
            note: formatted.tag,
            desc: formatted.actors || formatted.desc || '',
            actors: formatted.actors || '',
            year: formatted.year || '',
            area: formatted.area || '',
            type: catName,
            catTitle: catName,
            score: '',
            hits: '',
            infoTime: '',
            meta: metaParts.join(' | '),
            intro: formatted.desc || ''
          });
        });
      });
      // 如果没有分类数据，退回推荐列表
      if (!items.length && d.recommend) {
        d.recommend.forEach(function(v, i) {
          var formatted = self._fmtVod(v);
          var metaParts = [];
          if (formatted.tag) metaParts.push(formatted.tag);
          if (formatted.year) metaParts.push(formatted.year);
          if (formatted.area) metaParts.push(formatted.area);
          if (formatted.class) metaParts.push(formatted.class);
          items.push({
            title: formatted.title,
            url: formatted.url,
            img: formatted.img,
            tag: String(i + 1),
            top: String(i + 1),
            note: formatted.tag,
            desc: formatted.actors || '',
            actors: formatted.actors || '',
            year: formatted.year || '',
            area: formatted.area || '',
            type: '热门排行',
            catTitle: '热门排行',
            score: '',
            hits: '',
            infoTime: '',
            meta: metaParts.join(' | '),
            intro: formatted.desc || ''
          });
        });
      }
      return { ok: true, items: items, page: 1, finished: true };
    } catch(e) {
      console.error('[TVBox] rank error:', e.message);
      return { ok: false, error: e.message, items: [] };
    }
  }
  async detail(vodId) {
    try {
      var data = await this.get('/api.php/app/vod/get_detail', { vod_id: vodId });
      var json = JSON.parse(data);
      if (json.code !== 200) return { ok: false, error: json.msg };
      var vod = (json.data || [])[0] || {};
      var players = json.vodplayer || [];
      var froms = (vod.vod_play_from || '').split('$$$');
      var urls = (vod.vod_play_url || '').split('$$$');
      var sources = [];
      for (var i = 0; i < froms.length; i++) {
        var from = froms[i];
        var urlStr = urls[i] || '';
        var pInfo = players.find(function(p) { return p.from === from; }) || {};
        var eps = urlStr.split('#').filter(function(e) { return e.includes('$'); }).map(function(e) {
          var parts = e.split('$');
          return { name: parts[0], url: from + '@@' + (pInfo.decode_status || 0) + '@@' + (pInfo.decode_mode || 'server') + '@@' + encodeURIComponent(pInfo.parse_url || '') + '@@' + parts.slice(1).join('$') };
        });
        if (eps.length) sources.push({ name: from, episodes: eps });
      }
      // Also get direct URLs from search_aggregate
      try {
        var aggData = await this.get('/api.php/app/internal/search_aggregate', { vod_id: vodId });
        var aggJson = JSON.parse(aggData);
        var aggList = aggJson.data || [];
        for (var k = 0; k < aggList.length; k++) {
          var item = aggList[k];
          if (!item.site_key || !item.vod_play_url) continue;
          var eps2 = [];
          var parts2 = item.vod_play_url.split('#').filter(Boolean);
          for (var j = 0; j < parts2.length; j++) {
            var ep2 = parts2[j];
            var idx2 = ep2.indexOf('$');
            var title2 = idx2 === -1 ? ep2 : ep2.substring(0, idx2);
            if (!title2) continue;
            var url2 = idx2 === -1 ? '' : ep2.substring(idx2 + 1);
          if (url2) {
            // 统一 @@ 格式：from=site_key，直链标记2/需解析标记1，使 play() 能调 decode
            var ds2 = /\.(m3u8|mp4|flv|ts|aac)(\?|$)/i.test(url2) ? '2' : '1';
            eps2.push({ name: title2, url: item.site_key + '@@' + ds2 + '@@@@@@' + url2 });
          }
          }
          if (eps2.length > 0) sources.push({ name: item.site_name || item.site_key, episodes: eps2 });
        }
      } catch(e) {}
      return { ok: true, vod: { vod_id: vod.vod_id, vod_name: vod.vod_name, vod_pic: vod.vod_pic, vod_year: vod.vod_year, vod_area: vod.vod_area, vod_actor: vod.vod_actor, vod_director: vod.vod_director, vod_content: vod.vod_content, vod_class: vod.vod_class, type_name: vod.type_name }, sources: sources };
    } catch(e) {
      console.error('[TVBox] detail error:', e.message);
      return { ok: false, error: e.message };
    }
  }
  _fmtVod(v) {
    var area = v.vod_area || '';
    if (Array.isArray(area)) area = area.join('/');
    var cls = v.vod_class || '';
    if (Array.isArray(cls)) cls = cls.join('/');
    return { title: v.vod_name || '', img: v.vod_pic || '', url: '/api/parse-play?vod_id=' + v.vod_id, vodUrl: '/api/parse-play?vod_id=' + v.vod_id, tag: v.vod_remarks || '', desc: v.vod_content || '', year: v.vod_year || '', actors: v.vod_actor || '', type: v.type_name || '', area: area, class: cls };
  }
  async play(urlStr) {
    try {
      var UA = { 'User-Agent': 'okhttp/4.12.0' };
      var isVideo = function(u){ return u && /^https?:\/\//i.test(u) && /(m3u8|mp4|flv|ts|aac)/i.test(u); };
      // 外部 iframe 解析器（仅用于官网播放页兜底：腾讯/优酷/爱奇艺等）
      var DEFAULT_PARSER = 'https://xn--qvr2v.850088.xyz/player/?url=';
      var parseIframe = function(u, parser){
        var p = parser || DEFAULT_PARSER;
        var full = p.indexOf('?') > -1 || p.indexOf('=') > -1
          ? p + (p.indexOf('=') > -1 && p.charAt(p.length-1) !== '=' ? '' : '') + encodeURIComponent(u)
          : p + '?url=' + encodeURIComponent(u);
        return { ok: true, url: full, header: UA, parse: true };
      };

      var parts = urlStr.split('@@');
      var from = '', realUrl = urlStr, decodeStatus = '', parseUrl = '';
      if (parts.length >= 5) {
        from = parts[0];
        decodeStatus = parts[1];
        parseUrl = decodeURIComponent(parts[3] || '');
        realUrl = parts.slice(4).join('@@');
      } else if (parts.length >= 4) {
        from = parts[0];
        decodeStatus = parts[1];
        realUrl = parts.slice(3).join('@@');
      }

      // 1) 直链视频（参考 布布影视.js：m3u8/mp4/flv/ts/aac 直接返回）
      if (isVideo(realUrl)) return { ok: true, url: realUrl, header: UA };
      // decode_status=2 视为直链
      if (decodeStatus === '2' && realUrl && /^https?:/.test(realUrl)) return { ok: true, url: realUrl, header: UA };

      // 2) 服务端 decode 接口（对齐布布影视.js：用 genHeaders 精简header + 手动拼接URL）
      if (realUrl && from) {
        try {
          var decodeData = await this.decodeUrl(realUrl, from);
          var dj = JSON.parse(decodeData);
          if (dj && dj.data) {
            var du = String(dj.data).trim();
            // decode 返回新内容（非原样）才采用；原样返回说明 decode 无效（无套餐/获取失败）
            if (du && du !== realUrl) {
              // 参考布布影视.js：decode 成功直接返回 play.data，不管格式
              return { ok: true, url: du, header: UA };
            }
          }
        } catch(e) { console.error('[TVBox] decode error:', e.message); }
      }

      // 3) realUrl 为 http 非视频（官网播放页：腾讯/优酷/爱奇艺等）→ 外部 iframe 解析器兜底
      if (realUrl && /^https?:/.test(realUrl)) return parseIframe(realUrl, parseUrl);

      // 4) 令牌（JD-/co_ 等）decode 失败 → 不走外部解析器，返回失败
      //    （外部解析器不认识这些加密令牌，走过去也是白屏）
      return { ok: false, error: 'decode failed (no subscription or token invalid)' };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  }
}
const tvboxSources = {
  bubu: new TVBoxAPI({
    host: 'https://bubutv.top',
    pkg: 'com.sunshine.tv',
    sk: 'SK-thanks',
    finger: 'SF-C3B2B41F6EFFFF9869176CF68F6790E8F07506FC88632C94B4F5F0430D5498CA',
    ver: '6',
    updateId: '38b0ddfd-9aa3-8e42-5c92-a7fddd3d36e7',
    deviceBrand: 'vivo',
    deviceModel: 'V2309A'
  }),
  yunduo: new TVBoxAPI({
    host: 'https://ds3xy2yunsa.xyz',
    pkg: 'com.tvcloud.io',
    sk: 'SK-sk_13oXDZ7u9j2Tk1c0cawWVFfO',
    finger: 'SF-F5F11CB15897115AE6BCFE063C288F730CA865588F572C780A3E8477D0DD3776',
    ver: '1',
    updateId: '175070c3-075c-468b-950a-bf575769f4f1',
    deviceBrand: 'vivo',
    deviceModel: 'V2309A'
  }),
  damahou: new TVBoxAPI({
    host: 'https://45.150.167.18:8000',
    pkg: 'com.damahou.tv',
    sk: 'SK-woniu-thanks',
    finger: 'SF-A962FEC75DA28D7514F2A16580334272A78AC0A8429F10C94F47C1BAFC876E3F',
    ver: '1',
    updateId: '43c1ef69-3748-aaeb-317f-c621c77653ee',
    deviceBrand: 'vivo',
    deviceModel: 'V2309A',
    filterDef: { '电影': { '地区': '大陆,中国', '类型': '喜剧' }, '动漫': { '地区': '大陆,中国' } }
  })
};

// 源元数据（名称、logo）
const sourceMeta = {
  bubu: { name: '布布影视', logo: 'https://bubutv.top/adad/LOGO1-removebg-preview.png' },
  yunduo: { name: '云朵影视', logo: '' },
  damahou: { name: '大马猴影视', logo: '' }
};


module.exports = { TVBoxAPI, tvboxSources, sourceMeta };