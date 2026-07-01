var d = [];
var Q = '\u2018\u2018\u2019\u2019';

var PROJECT_PATH = getPath("hiker://files/data/电影大全/").replace(/^file:\/\//, "");
var MAIN_INDEX = getPath("hiker://files/data/电影大全/dydq_index.js").replace(/^file:\/\//, "");

var nodeRunning = false;
try {
    var hr = request('http://127.0.0.1:9979/health?_t=' + Date.now()) || '';
    if (hr.indexOf('ok') > -1) nodeRunning = true;
} catch (e) {}

if (!nodeRunning) {
    var closedAt = parseInt(getItem("dydq_node_closed_at", "0")) || 0;
    if (Date.now() - closedAt >= 30000) {
        try {
            var nc = $.require("NodeController?rule=nodejs");
            if (nc) {
                // ====== 先检查 dydq_index.js 是否存在 ======
                var indexExists = false;
                try {
                    var test = request('hiker://files/data/电影大全/dydq_index.js');
                    if (test && test.length > 100) indexExists = true;
                } catch (e) {}

                if (!indexExists) {
                    log("【电影大全】dydq_index.js 未找到，跳过自启动，显示控制面板");
                } else {
                    var pid = 'dydq-node-proxy';
                    try { if (nc.isRunning(pid)) { nc.terminate(pid); java.lang.Thread.sleep(1000); } } catch(e1) {}
                    var project = { mainIndex: MAIN_INDEX, id: pid, projectPath: PROJECT_PATH, name: 'dydq-node-proxy' };
                    nc.runProject(project, pid, 0, {});
                    var waited = 0;
                    while (waited < 8000) {
                        java.lang.Thread.sleep(500);
                        waited += 500;
                        try {
                            var hr2 = request('http://127.0.0.1:9979/health?_t=' + Date.now()) || '';
                            if (hr2.indexOf('ok') > -1) {
                                nodeRunning = true;
                                break;
                            }
                        } catch (e2) {}
                    }
                    if (nodeRunning) {
                        log("【电影大全】Node服务自启动成功");
                    } else {
                        log("【电影大全】Node服务自启动超时");
                    }
                }
            }
        } catch (e) {
            log("【电影大全】自启动失败: " + e.message);
        }
    } else {
        log("【电影大全】30秒内刚关闭过，跳过自启动");
    }
}


if (!nodeRunning) {
    // ====== 控制面板 ======
    d.push({
        title: "电影大全全屏版入口",
        col_type: "pic_1_card",
        desc: "",
        pic_url: "https://www.1905dsj.com/upload/vod_cover/20260408-1/bf53de99d14c2aff023acd4074a41b72.jpg",
        url: $('hiker://empty#autoCache##gameTheme#').rule(function() {
            setResult($.require('hiker://page/b'))
        })
    });

    d.push({
        title: Q + '<font color="#22D59C"><b>Node.js 服务控制</b></font>',
        col_type: 'text_center_1',
        url: 'hiker://empty'
    });

    d.push({ col_type: 'line' });
    d.push({
        title: Q + '<font color="#FF4757">当前 Node 服务未运行</font>',
        col_type: 'text_center_1',
        url: 'hiker://empty'
    });
    d.push({ col_type: 'line' });
    d.push({
        title: Q + '<font color="#22D59C"><b>🟢 点击启动</b></font>',
        col_type: 'text_center_1',
        url: $("#noLoading#").lazyRule(function(mainIdx, projPath) {
            try {
                clearItem("dydq_node_closed_at");
                var NodeController = $.require("NodeController?rule=nodejs");
                if (!NodeController) {
                    return "toast://请先安装 Node.js 小程序";
                }
                var pid = 'dydq-node-proxy';
                if (NodeController.isRunning(pid)) {
                    NodeController.terminate(pid);
                    java.lang.Thread.sleep(1000);
                }
                var project = {
                    mainIndex: mainIdx,
                    id: pid,
                    projectPath: projPath,
                    name: 'dydq-node-proxy'
                };
                NodeController.runProject(project, pid, 0, {});
                var waited = 0;
                while (waited < 8000) {
                    java.lang.Thread.sleep(500);
                    waited += 500;
                    try {
                        var hr = request('http://127.0.0.1:9979/health?_t=' + Date.now()) || '';
                        if (hr.indexOf('ok') > -1) {
                            refreshPage(true);
                            return "toast://Node服务已启动";
                        }
                    } catch (e) {}
                }
                return "toast://启动超时，请检查配置";
            } catch (e) {
                return "toast://启动失败: " + e.message;
            }
        }, MAIN_INDEX, PROJECT_PATH)
    });

    d.push({ col_type: 'line' });

    var indexExists = false;
    var fileVirtualPath = 'hiker://files/data/电影大全/dydq_index.js';
    try {
        var test = request(fileVirtualPath);
        if (test && test.length > 100) indexExists = true;
    } catch (e) {}

    if (indexExists) {
        d.push({
            title: Q + '<font color="#22D59C"><b>📝 编辑 dydq_index.js</b></font>',
            col_type: 'text_center_1',
            url: 'editFile://' + fileVirtualPath + '@js=refreshPage(true)'
        });
        d.push({
            title: Q + '<small><font color="#aaa">编辑保存后自动刷新，若需生效请重启 Node 服务</font></small>',
            col_type: 'text_center_1',
            url: 'hiker://empty'
        });
    } else {
        d.push({
            title: Q + '<font color="#FF4757">dydq_index.js 未找到，点击下载</font>',
            col_type: 'text_center_1',
            url: $("#noLoading#").lazyRule(function() {
                try {
                    var remoteUrl = "https://raw.githubusercontent.com/xc2023/-/refs/heads/main/dydq_index.js";
                    var remote = request(remoteUrl);
                    if (remote && remote.length > 100) {
                        writeFile('hiker://files/data/电影大全/dydq_index.js', remote);
                        refreshPage(true);
                        return "toast://下载成功，可编辑";
                    } else {
                        return "toast://下载失败，请检查网络";
                    }
                } catch (e) {
                    return "toast://下载失败: " + e.message;
                }
            })
        });
    }

    d.push({ col_type: 'line' });
    d.push({
        url: 'hiker://empty',
        col_type: 'rich_text',
        title: '<font color="#22D59C"><b>Node.js 服务说明</b></font><br><br>' +
            '<small><font color="#aaa">1. Node 服务用于代理请求源站数据，提供搜索、分类、TMDB 详情等功能<br><br>' +
            '2. 首次使用请先安装 nodejs 小程序<br><br>' +
            '3. 将 dydq_index.js 放到 hiker://files/data/电影大全/ 目录下(可能网络问题需手动)<br><br>' +
            '4. 点击上方按钮启动/关闭服务<br><br>' +
            '5. 启动后请等待几秒，服务会自动检测连接状态<br><br>' +
            '6. 如启动失败，请检查 Node.js 小程序是否已安装，dydq_index.js 路径是否正确</font></small>'
    });

} else {
    // ====== 全屏版 ======
var host = 'https://www.1905dsj.com';

// ---------- 获取首页数据 ----------
var homeJson = '{}';
try {
    homeJson = request('http://127.0.0.1:9979/home-api') || '{}';
} catch (e) {
    homeJson = '{}';
}
var homeData = JSON.parse(homeJson);
var lunbos = (homeData.ok && homeData.lunbos) ? homeData.lunbos : [];
var sections = (homeData.ok && homeData.sections) ? homeData.sections : [];

// ---------- 分类（占位） ----------
var catData = [{
        name: '电影',
        cid: 'dianying',
        items: []
    },
    {
        name: '剧集',
        cid: 'dianshiju',
        items: []
    },
    {
        name: '综艺',
        cid: 'zongyi',
        items: []
    },
    {
        name: '动漫',
        cid: 'dongman',
        items: []
    },
    {
        name: '短剧',
        cid: 'duanju',
        items: []
    }
];

// ---------- HTML 模板 ----------
function lbcss() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>影视大全</title><style>
/* ----- 基础重置 + 新背景 ----- */
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{min-height:100vh;overflow-x:hidden;max-width:100vw;background:transparent!important}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e0e0e0}
.futuristic-pattern{position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;background:linear-gradient(145deg,rgba(169,140,76,.95),rgba(108,149,214,.95),rgba(124,43,117,.95));filter:url(#advanced-texture);pointer-events:none}
.texture-filter{position:absolute;width:0;height:0;overflow:visible}

/* ----- 原有样式（压缩后）----- */
.header{height:52px;background:rgba(10,14,39,0.2);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(3px);display:flex;align-items:center;padding:0 12px;position:sticky;top:0;z-index:100;box-shadow:0 2px 12px rgba(0,0,0,0.2)}
.logo-img{height:18px;width:auto;object-fit:contain;flex-shrink:0;margin-right:10px}
.logo-text{font-size:20px;font-weight:700;white-space:nowrap;color:#1736aa;flex-shrink:0;margin-left:10px;display:none;margin-left: 0px !important; margin-right: 10px !important;}
.header-search{position:relative;display:flex;align-items:center;flex:1;min-width:0}
.galaxy{height:50px;width:400px;background-image:radial-gradient(#fff 1px,transparent 1px),radial-gradient(#fff 1px,transparent 1px);background-size:50px 50px;background-position:0 0,25px 25px;position:absolute;z-index:-1;animation:twinkle 5s infinite;left:50%;transform:translateX(-50%);opacity: 0.3;}
@keyframes twinkle{0%,100%{opacity:.5}50%{opacity:1}}
.stardust,.cosmic-ring,.starfield,.nebula{max-height:44px;max-width:400px;height:100%;width:100%;position:absolute;overflow:hidden;z-index:-1;border-radius:10px;filter:blur(3px)}
.search-container{display:flex;align-items:center;justify-content:center;width:100%}
.cosmic-input{background-color:#fff;border:none;width:100%;height:36px;border-radius:8px;color:#a9c7ff;padding-inline:42px;font-size:13px}
.cosmic-input::placeholder{color:#6e8cff}
.cosmic-input:focus{outline:none}
#input-mask{pointer-events:none;width:80px;height:100%;position:absolute;background:linear-gradient(90deg,transparent 0%,rgba(0,0,0,.1) 30%,#05071b 100%);top:0;right:0;left:auto;border-radius:0 8px 8px 0}
#cosmic-glow{pointer-events:none;width:20px;height:14px;position:absolute;background:#4d6dff;top:6px;left:4px;filter:blur(16px);opacity:.8;transition:all 2s}
#cosmic-main:hover>#cosmic-glow{opacity:0}
#cosmic-main:focus-within>#input-mask{display:none}
.stardust{max-height:40px;max-width:390px;border-radius:8px;filter:blur(2px)}
.stardust::before{content:"";z-index:-2;text-align:center;top:50%;left:50%;transform:translate(-50%,-50%) rotate(83deg);position:absolute;width:600px;height:600px;background-repeat:no-repeat;background-position:0 0;filter:brightness(1.4);background-image:conic-gradient(rgba(0,0,0,0) 0%,#4d6dff,rgba(0,0,0,0) 8%,rgba(0,0,0,0) 50%,#6e8cff,rgba(0,0,0,0) 58%);transition:all 2s}
.cosmic-ring{max-height:38px;max-width:386px;border-radius:9px;filter:blur(.5px)}
.cosmic-ring::before{content:"";z-index:-2;text-align:center;top:50%;left:50%;transform:translate(-50%,-50%) rotate(70deg);position:absolute;width:600px;height:600px;background-repeat:no-repeat;background-position:0 0;filter:brightness(1.3);background-image:conic-gradient(#7f7e8a,#4d6dff 5%,#7f7e8a 14%,#7f7e8a 50%,#6e8cff 60%,#7f7e8a 64%);transition:all 2s}
.starfield{max-height:42px;max-width:398px}
.starfield::before{content:"";z-index:-2;text-align:center;top:50%;left:50%;transform:translate(-50%,-50%) rotate(82deg);position:absolute;width:600px;height:600px;background-repeat:no-repeat;background-position:0 0;background-image:conic-gradient(rgba(0,0,0,0),#1c2452,rgba(0,0,0,0) 10%,rgba(0,0,0,0) 50%,#2a3875,rgba(0,0,0,0) 60%);transition:all 2s}
.search-container:hover>.starfield::before{transform:translate(-50%,-50%) rotate(-98deg)}
.search-container:hover>.nebula::before{transform:translate(-50%,-50%) rotate(-120deg)}
.search-container:hover>.stardust::before{transform:translate(-50%,-50%) rotate(-97deg)}
.search-container:hover>.cosmic-ring::before{transform:translate(-50%,-50%) rotate(-110deg)}
.search-container:focus-within>.starfield::before{transform:translate(-50%,-50%) rotate(442deg);transition:all 4s}
.search-container:focus-within>.nebula::before{transform:translate(-50%,-50%) rotate(420deg);transition:all 4s}
.search-container:focus-within>.stardust::before{transform:translate(-50%,-50%) rotate(443deg);transition:all 4s}
.search-container:focus-within>.cosmic-ring::before{transform:translate(-50%,-50%) rotate(430deg);transition:all 4s}
.nebula{overflow:hidden;filter:blur(30px);opacity:.4;max-height:80px;max-width:440px}
.nebula:before{content:"";z-index:-2;text-align:center;top:50%;left:50%;transform:translate(-50%,-50%) rotate(60deg);position:absolute;width:999px;height:999px;background-repeat:no-repeat;background-position:0 0;background-image:conic-gradient(#000,#4d6dff 5%,#000 38%,#000 50%,#6e8cff 60%,#000 87%);transition:all 2s}
#wormhole-icon{position:absolute;top:5px;right:5px;display:flex;align-items:center;justify-content:center;z-index:2;max-height:28px;max-width:28px;height:100%;width:100%;isolation:isolate;overflow:hidden;border-radius:8px;background:linear-gradient(180deg,#1c2452,#05071b,#2a3875);border:1px solid transparent}
.wormhole-border{height:30px;width:30px;position:absolute;overflow:hidden;top:4px;right:4px;border-radius:8px}
.wormhole-border::before{content:"";text-align:center;top:50%;left:50%;transform:translate(-50%,-50%) rotate(90deg);position:absolute;width:600px;height:600px;background-repeat:no-repeat;background-position:0 0;filter:brightness(1.35);background-image:conic-gradient(rgba(0,0,0,0),#4d6dff,rgba(0,0,0,0) 50%,rgba(0,0,0,0) 50%,#6e8cff,rgba(0,0,0,0) 100%);animation:rotate 4s linear infinite}
#cosmic-main{position:relative;width:100%}
#search-icon{position:absolute;left:14px;top:9px}
@keyframes rotate{100%{transform:translate(-50%,-50%) rotate(450deg)}}

/* 轮播 */
.car{position:relative;margin:12px;border-radius:16px;overflow:hidden;box-shadow:0 8px 20px rgba(0,0,0,0.25);background:rgba(15,20,40,0.65);display:none}
.ct{display:flex;transition:transform .3s ease-out}
.cs{flex-shrink:0;width:100%;cursor:pointer;position:relative}
.cs img{width:100%;display:block;aspect-ratio:16/9;object-fit:cover;background:#161628}
.cxt{position:absolute;bottom:0;left:0;right:0;padding:16px;background:linear-gradient(to top,rgba(0,0,0,0.85),transparent);color:#fff}
.ctx{font-size:12px;background:rgba(0,0,0,0.6);display:inline-block;padding:2px 10px;border-radius:20px;margin-bottom:8px}
.cxn{font-size:18px;font-weight:bold;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cxd{font-size:12px;opacity:0.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cds{position:absolute;bottom:10px;left:0;right:0;display:flex;justify-content:center;z-index:5}
.cdot{width:8px;height:8px;background:rgba(255,255,255,0.5);border-radius:50%;margin:0 4px;cursor:pointer;transition:all .2s}
.cdot.on{background:#4fc3f7;width:20px;border-radius:12px}
.ca{position:absolute;top:50%;transform:translateY(-50%);width:32px;height:32px;background:rgba(0,0,0,0.5);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;cursor:pointer;z-index:5}
.ca:hover{background:rgba(0,0,0,0.7)}.cl{left:10px}.cr{right:10px}

/* 分类栏 & 内容 */
.cbar{display:flex;padding:8px 8px 8px 0;background:transparent;margin:0 0 0 8px;border-radius:20px;overflow-x:auto;position:sticky;top:52px;z-index:60;flex-wrap:nowrap;-webkit-overflow-scrolling:touch;scrollbar-width:none}.cbar::-webkit-scrollbar{display:none}
.ci{flex-shrink:0;text-align:center;padding:5px 10px;background:rgba(34,34,64,.6);border-radius:16px;font-size:13px;cursor:pointer;margin:0 3px;transition:background .2s;white-space:nowrap}
.ci.on{background:#4fc3f7;color:#fff}
.sec{margin-top:20px;padding:0 12px}
.sh{font-size:17px;font-weight:600;color:#fff;margin-bottom:12px}
.gr{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.crd{cursor:pointer;background:rgba(22,22,40,0.55);border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);transition:transform .2s,box-shadow .2s;box-shadow:0 4px 12px rgba(0,0,0,0.3)}
.crd:hover{transform:translateY(-4px);box-shadow:0 12px 24px rgba(0,0,0,0.4)}
.crd:active{transform:scale(.97)}
.crd img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block;background:#161628}
.crd-tag{position:absolute;top:8px;left:8px;font-size:10px;padding:2px 8px;border-radius:20px;background:linear-gradient(135deg,#4fc3f7,#2b9ed4);color:#fff;font-weight:500;z-index:1;box-shadow:0 2px 6px rgba(0,0,0,0.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90%}
.crdi{padding:6px 4px;text-align:center;background:rgba(22,22,40,0.5)}
.crdn{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.crdr{font-size:10px;color:#ffd966;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tip{text-align:center;padding:20px;color:rgba(255,255,255,0.7);font-size:13px}
.sr-list{display:flex;flex-direction:column}
.sri{display:flex;background:rgba(22,22,40,0.75);margin-bottom:12px;backdrop-filter:blur(12px);border-radius:12px;overflow:hidden;cursor:pointer;box-shadow:0 12px 22px rgba(0,0,0,0.35);transition:transform .2s,box-shadow .2s;border:1px solid rgba(255,255,255,0.12)}
.sri:hover{transform:translateY(-5px);box-shadow:0 20px 32px rgba(0,0,0,0.45)}
.sri:active{transform:scale(0.97)}
.sri-img{width:100px;height:133px;flex-shrink:0;background:#222;object-fit:cover;display:block;border-radius:12px;margin:8px 0 8px 8px;box-shadow:0 4px 8px rgba(0,0,0,0.3)}
.sri-info{flex:1;padding:10px 12px;display:flex;flex-direction:column;justify-content:center}
.sri-title{font-size:16px;font-weight:700;color:#fff;line-height:1.3;margin-bottom:6px}
.sri-meta{display:flex;flex-wrap:wrap;margin-bottom:4px}
.sri-tag{font-size:11px;background:rgba(79,195,247,.25);padding:3px 10px;border-radius:20px;color:rgba(255,255,255,0.9);margin-right:6px;margin-bottom:4px}
.sri-desc{font-size:12px;color:rgba(255,255,255,0.85);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4}
@media(min-width:600px){.gr{grid-template-columns:repeat(4,1fr)}}
@media(min-width:900px){.gr{grid-template-columns:repeat(5,1fr)}}
.tmdb-overlay{position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,.94);z-index:200;display:none;overflow-y:auto;-webkit-overflow-scrolling:touch}
.tmdb-overlay.show{display:block}
.tmdb-nav{height:52px;background:rgba(22,22,40,0.9);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:space-between;padding:0 16px;position:sticky;top:0;z-index:10}
.tmdb-nav-title{font-size:16px;font-weight:700;color:#fff}
.tmdb-close{background:rgba(255,255,255,.15);border:none;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center}
.tmdb-body{max-width:600px;margin:0 auto;padding:16px}
.tmdb-poster-wrap{border-radius:12px;overflow:hidden;background:#161628;margin-bottom:16px;box-shadow:0 8px 20px rgba(0,0,0,0.3)}
.tmdb-poster{width:100%;display:block}
.tmdb-title{font-size:20px;font-weight:700;color:#fff;margin-bottom:8px}
.tmdb-meta{display:flex;flex-wrap:wrap;margin-bottom:10px;align-items:center}
.tmdb-tag{padding:4px 12px;border-radius:20px;font-size:11px;background:rgba(79,195,247,.2);color:#4fc3f7;border:1px solid rgba(79,195,247,.4);margin-right:8px;margin-bottom:6px}
.tmdb-rating{background:rgba(255,193,7,.2);color:#ffc107;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;border:1px solid rgba(255,193,7,.4);margin-right:8px;margin-bottom:6px}
.tmdb-desc{font-size:13px;color:rgba(224,224,224,.85);line-height:1.6;margin-bottom:16px}
.tmdb-section-title{font-size:14px;color:#4fc3f7;margin-bottom:10px;font-weight:600;letter-spacing:.5px}
.tmdb-cast-list{display:flex;overflow-x:auto;padding-bottom:6px;margin-bottom:16px}
.tmdb-cast-list::-webkit-scrollbar{display:none}
.tmdb-cast-item{flex-shrink:0;text-align:center;width:65px;margin-right:12px}
.tmdb-cast-img{width:58px;height:58px;border-radius:50%;object-fit:cover;background:#222;margin-bottom:6px;display:block;border:2px solid rgba(79,195,247,0.5)}
.tmdb-cast-name{font-size:10px;color:rgba(224,224,224,.8);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.tmdb-similar-list{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
.tmdb-similar-item{cursor:pointer;background:rgba(22,22,40,0.7);border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.06);transition:transform .2s}
.tmdb-similar-item:hover{transform:translateY(-3px)}
.tmdb-similar-img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;background:#161628}
.tmdb-similar-title{padding:4px;font-size:11px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(224,224,224,.9)}
.tmdb-similar-rating{font-size:10px;text-align:center;color:#ffc107;padding-bottom:4px}
.tmdb-play-btn{display:block;width:100%;padding:14px;background:linear-gradient(135deg,#2563eb,#1d4ed8);border:none;border-radius:12px;color:#fff;font-size:16px;font-weight:700;cursor:pointer;text-align:center;box-shadow:0 4px 12px rgba(37,99,235,0.4);transition:all .2s}
.tmdb-play-btn:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(37,99,235,0.5)}
.tmdb-play-btn:active{transform:scale(0.97)}
.tmdb-loading{text-align:center;padding:40px;color:rgba(255,255,255,0.5);font-size:13px};
.galaxy,.stardust,.nebula,.starfield,.cosmic-ring{opacity:0!important};}
</style>
</head><body>

<!-- 新背景层 -->
<div class="futuristic-pattern">
  <svg class="texture-filter">
    <filter id="advanced-texture">
      <feTurbulence result="noise" numOctaves="3" baseFrequency="0.7" type="fractalNoise"/>
      <feSpecularLighting result="specular" lighting-color="#fff" specularExponent="20" specularConstant="0.8" surfaceScale="2" in="noise">
        <fePointLight z="100" y="50" x="50"/>
      </feSpecularLighting>
      <feComposite result="litNoise" operator="in" in2="SourceGraphic" in="specular"/>
      <feBlend mode="overlay" in2="litNoise" in="SourceGraphic"/>
    </filter>
  </svg>
</div>

<!-- 头部 -->
<div class="header">
<img class=logo-img src="" alt="电 影 大 全" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
<div class=logo-text style="display:none">🎬</div>
<div class=header-search>
<div class=galaxy></div>
<div class=search-container>
<div class=nebula></div><div class=starfield></div><div class=stardust></div><div class=cosmic-ring></div>
<div id=cosmic-main>
<input class=cosmic-input id=searchInput placeholder="搜索影片...">
<div id=input-mask></div><div id=cosmic-glow></div>
<div class=wormhole-border></div>
<div id=wormhole-icon><svg stroke-linejoin="round" stroke-linecap="round" stroke-width="2" stroke="#a9c7ff" fill="none" height="20" width="20" viewBox="0 0 24 24"><circle r="10" cy="12" cx="12"></circle><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path><path d="M2 12h20"></path></svg></div>
<div id=search-icon><svg stroke-linejoin="round" stroke-linecap="round" stroke-width="2" stroke="url(#cosmic-search)" fill="none" height="18" width="18" viewBox="0 0 24 24"><circle r="8" cy="11" cx="11"></circle><line y2="16.65" x2="16.65" y1="21" x1="21"></line><defs><linearGradient gradientTransform="rotate(45)" id=cosmic-search><stop stop-color="#a9c7ff" offset="0%"></stop><stop stop-color="#6e8cff" offset="100%"></stop></linearGradient></defs></svg></div>
</div>
</div>
</div>
</div>

<!-- 轮播容器 -->
<div class="car" id="car">
<div class="ct" id="ct"></div>
<div class="cds" id="cds"></div>
<div class="ca cl" id="cpl">‹</div>
<div class="ca cr" id="cpr">›</div>
</div>

<!-- 分类栏 -->
<div class="cbar" id="cbar">
<div class="ci on" data-action="home">🏠 首页</div>
<div class="ci" data-idx="0">🎬 电影</div>
<div class="ci" data-idx="1">📺 剧集</div>
<div class="ci" data-idx="2">🎤 综艺</div>
<div class="ci" data-idx="3">✨ 动漫</div>
<div class="ci" data-idx="4">📱 短剧</div>
<div class="ci" data-action="latest">🕐 最新</div>
<div class="ci" data-action="rank">🔥 排行</div>
<div class="ci" data-action="topic">📋 专题</div>
</div>

<!-- 主内容 -->
<div id="main"></div>
<div class="tip" id="tip">加载中...</div>

<!-- 详情浮层 -->
<div class="tmdb-overlay" id="tmdbOverlay">
<div class="tmdb-nav">
<div class="tmdb-nav-title" id="tmdbNavTitle">影片详情</div>
<button class="tmdb-close" id="tmdbClose">×</button>
</div>
<div class="tmdb-body">
<div class="tmdb-poster-wrap"><img class="tmdb-poster" id="tmdbPoster"></div>
<div class="tmdb-title" id="tmdbTitle">加载中...</div>
<div class="tmdb-meta" id="tmdbMeta" style="display:none"></div>
<div class="tmdb-desc" id="tmdbDesc"></div>
<div id="tmdbCastSection" style="display:none"><div class="tmdb-section-title">主演</div><div class="tmdb-cast-list" id="tmdbCastList"></div></div>
<div id="tmdbSimilarSection" style="display:none"><div class="tmdb-section-title">相似推荐</div><div class="tmdb-similar-list" id="tmdbSimilarList"></div></div>
<button class="tmdb-play-btn" id="tmdbPlayBtn">▶ 进入播放</button>
</div>
</div>
</body></html>`;
}

var htmlContent = lbcss();

// ---------- 构造 X5 页面 ----------
d.push({
    url: "about:blank#autoCache#",
    desc: "float&&100%",
    col_type: "x5_webview_single",
    extra: {
        // ----- 前端 JS（请完整粘贴您原来的全部前端逻辑） -----
        js: $.toString(
            (h, lunbos, sections, catData, HOST, TMDB_KEY, PROXY) => {
                document.documentElement.innerHTML = h;

                var fixUrl = function(u) {
                    if (!u) return '';
                    if (u.indexOf('//') === 0) return 'https:' + u;
                    if (u.charAt(0) === '/') return HOST + u;
                    return u;
                };

                // TMDB 详情页：用 iframe 加载（和分类/搜索页同样的方式）
                var TMDB_LOCAL = 'http://127.0.0.1:9979';

                var showDetail = function(item) {
                    window.item = item;
                    if (item.url && !/^https?:/.test(item.url)) {
                        item.url = 'https://www.1905dsj.com' + item.url;
                    }
                    var main = document.getElementById('main');
                    var car = document.getElementById('car');
                    var cbar = document.getElementById('cbar');
                    var header = document.querySelector('.header');
                    if (car) car.style.display = 'none';
                    if (main) main.style.display = 'none';
                    var frame = document.getElementById('tmdbFrame');
                    if (!frame) {
                        frame = document.createElement('iframe');
                        frame.id = 'tmdbFrame';
                        frame.style.cssText = 'width:100%;height:100vh;border:0;background:transparent;display:block;position:fixed;top:0;left:0;right:0;bottom:0;z-index:90';
                        document.body.appendChild(frame);
                    }
                    frame.style.display = 'block';
                    frame.src = TMDB_LOCAL + '/tmdb-page?title=' + encodeURIComponent(item.title || '') + '&url=' + encodeURIComponent(item.url || '') + '&img=' + encodeURIComponent(item.img || '');
                    window.scrollTo(0, 0);
                    setTimeout(function() {
                        if (cbar) cbar.style.display = 'none';
                        if (header) header.style.display = 'none';
                    }, 300);
                };

                var closeTmdbFrame = function(keepSubPage) {
                    var frame = document.getElementById('tmdbFrame');
                    if (frame) {
                        frame.style.display = 'none';
                        frame.src = 'about:blank';
                    }
                    if (keepSubPage) return;
                    var main = document.getElementById('main');
                    var car = document.getElementById('car');
                    var cbar = document.getElementById('cbar');
                    var header = document.querySelector('.header');
                    if (main) main.style.display = '';
                    if (car) car.style.display = '';
                    if (cbar) cbar.style.display = '';
                    if (header) header.style.display = '';
                };

                window.addEventListener('message', function(e) {
                    var data = e && e.data ? e.data : null;
                    if (!data) return;
                    if (data.type === 'ayfPlay' && data.url) {
                        closeTmdbFrame();
                        window.open(data.url, '_blank');
                    } else if (data.type === 'dsjPlay' && data.url) {
                        closeTmdbFrame();
                        window.open(data.url, '_blank');
                    } else if (data.type === 'ayfClose' || data.type === 'dsjClose') {
                        var catFrame = document.getElementById('catFrame');
                        if (catFrame && catFrame.style.display !== 'none') {
                            closeTmdbFrame(true);
                            var cbar2 = document.getElementById('cbar');
                            var header2 = document.querySelector('.header');
                            if (cbar2) cbar2.style.display = '';
                            if (header2) header2.style.display = '';
                        } else {
                            closeTmdbFrame();
                        }
                    } else if ((data.type === 'ayfSearch' || data.type === 'dsjSearch') && data.query) {
                        closeTmdbFrame();
                        showSearch(data.query);
                    } else if (data.type === 'ayfDetail' && data.item) {
                        showDetail(data.item);
                    } else if (data.type === 'dsjDetail' && data.item) {
                        showDetail(data.item);
                    }
                });

                var esc = function(s) {
                    return s ? s.replace(/[&<>]/g, function(m) {
                        return m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'
                    }) : '';
                };

                // 创建影片卡片
                var renderCard = function(item) {
                    var crd = document.createElement('div');
                    crd.className = 'crd';

                    var cimg = document.createElement('img');
                    cimg.src = fixUrl(item.img);
                    cimg.loading = 'lazy';

                    cimg.onerror = function() {
                        var seed = Math.floor(Math.random() * 1000);
                        this.src = 'https://picsum.photos/seed/' + seed + '/300/400';
                    };
                    if (item.tag) {
                        var imgWrap = document.createElement('div');
                        imgWrap.style.cssText = 'position:relative';
                        imgWrap.appendChild(cimg);
                        var tagEl = document.createElement('div');
                        tagEl.className = 'crd-tag';
                        tagEl.textContent = item.tag;
                        imgWrap.appendChild(tagEl);
                        crd.appendChild(imgWrap);
                    } else {
                        crd.appendChild(cimg);
                    }
                    var info = document.createElement('div');
                    info.className = 'crdi';
                    var title = document.createElement('div');
                    title.className = 'crdn';
                    title.textContent = item.title || '';
                    info.appendChild(title);
                    var rm = document.createElement('div');
                    rm.className = 'crdr';
                    if (item.desc) {
                        rm.textContent = item.desc;
                        info.appendChild(rm);
                    }
                    crd.appendChild(info);
                    crd.onclick = function() {
                        showDetail(item);
                    };
                    return crd;
                };

                // 搜索结果卡片
                var renderSearchCard = function(item) {
                    var card = document.createElement('div');
                    card.className = 'sri';

                    var img = document.createElement('img');
                    img.className = 'sri-img';
                    img.src = fixUrl(item.img);
                    img.loading = 'lazy';

                    img.onerror = function() {
                        this.style.background = '#333';
                    };
                    var info = document.createElement('div');
                    info.className = 'sri-info';
                    var title = document.createElement('div');
                    title.className = 'sri-title';
                    title.textContent = item.title || '';
                    info.appendChild(title);
                    var meta = document.createElement('div');
                    meta.className = 'sri-meta';
                    if (item.tag) {
                        var tagEl = document.createElement('span');
                        tagEl.className = 'sri-tag';
                        tagEl.textContent = item.tag;
                        meta.appendChild(tagEl);
                    }
                    if (item.score) {
                        var scoreEl = document.createElement('span');
                        scoreEl.className = 'sri-tag';
                        scoreEl.style.cssText = 'background:rgba(255,193,7,.2);color:#ffc107';
                        scoreEl.textContent = 'br' + '⭐ ' + item.score;
                        meta.appendChild(scoreEl);
                    }
                    if (meta.children.length > 0) info.appendChild(meta);
                    if (item.desc) {
                        var desc = document.createElement('div');
                        desc.className = 'sri-desc';
                        desc.textContent = item.desc;
                        info.appendChild(desc);
                    }
                    card.appendChild(img);
                    card.appendChild(info);
                    card.onclick = function() {
                        showDetail(item);
                    };
                    return card;
                };

                // emoji 映射
                var secIcons = {
                    '热播推荐': '🔥',
                    '电影': '🎬',
                    '电视剧': '📺',
                    '剧集': '📺',
                    '综艺': '🎤',
                    '动漫': '✨',
                    '短剧': '📱'
                };
                var catIcons = {
                    '电影': '🎬',
                    '剧集': '📺',
                    '综艺': '🎤',
                    '动漫': '✨',
                    '短剧': '📱'
                };

                // 渲染首页板块
                var renderSections = function(container, data) {
                    container.innerHTML = '';
                    for (var i = 0; i < data.length; i++) {
                        var secName = data[i].name || data[i].title || '';
                        var sec = document.createElement('div');
                        sec.className = 'sec';
                        var hd = document.createElement('div');
                        hd.className = 'sh';
                        hd.textContent = (secIcons[secName] || '🎞️') + ' ' + secName;
                        sec.appendChild(hd);
                        var grid = document.createElement('div');
                        grid.className = 'gr';
                        for (var k = 0; k < data[i].items.length; k++) {
                            grid.appendChild(renderCard(data[i].items[k]));
                        }
                        sec.appendChild(grid);
                        container.appendChild(sec);
                    }
                };

                // 分类页渲染：通过本地 Node 代理按需加载分页
                var BATCH = 12;
                var activeCat = null;
                var buildCatUrl = function(cid, pg) {
                    pg = parseInt(pg || 1);
                    if (pg <= 1) return HOST + '/vod/show/id/' + cid + '.html';
                    return HOST + '/vod/show/id/' + cid + '/page/' + pg + '.html';
                };
                var readText = function(el, sel) {
                    var n = el.querySelector(sel);
                    return n ? (n.textContent || '').trim() : '';
                };
                var readAttr = function(el, sel, attr) {
                    var n = el.querySelector(sel);
                    return n ? (n.getAttribute(attr) || '') : '';
                };
                var parseCatHtml = function(html, pg) {
                    var doc = new DOMParser().parseFromString(html, 'text/html');
                    var nodes = doc.querySelectorAll('.hl-list-item');
                    var arr = [];
                    for (var i = 0; i < nodes.length; i++) {
                        var li = nodes[i];
                        var u = readAttr(li, 'a', 'href');
                        var t = readAttr(li, 'a', 'title') || readText(li, 'a');
                        if (!t || !u) continue;
                        arr.push({
                            title: t,
                            img: readAttr(li, 'a', 'data-original') || readAttr(li, 'img', 'data-original') || readAttr(li, 'img', 'src'),
                            url: u,
                            desc: readText(li, '.remarks') || readText(li, '.hl-item-sub'),
                            tag: readText(li, '.state') || readText(li, '.version'),
                            score: readText(li, '.score'),
                            page: pg
                        });
                    }
                    return arr;
                };
                var fetchCatPage = function(catInfo, pg) {
                    var rawUrl = buildCatUrl(catInfo.cid, pg);
                    var cacheKey = 'ayf_x5_proxy_cat_' + catInfo.cid + '_p' + pg;
                    var cached = '';
                    try {
                        cached = localStorage.getItem(cacheKey) || '';
                    } catch (e) {}
                    if (cached) return Promise.resolve(JSON.parse(cached));
                    return fetch(PROXY + encodeURIComponent(rawUrl)).then(function(r) {
                        return r.text();
                    }).then(function(html) {
                        var list = parseCatHtml(html, pg);
                        try {
                            localStorage.setItem(cacheKey, JSON.stringify(list));
                        } catch (e) {}
                        return list;
                    });
                };
                var showCategory = function(catInfo) {
                    activeCat = catInfo;
                    var main = document.getElementById('main');
                    main.innerHTML = '';
                    document.getElementById('car').style.display = 'none';
                    catInfo.items = catInfo.items || [];
                    catInfo.page = catInfo.page || 0;
                    catInfo.loading = false;
                    catInfo.finished = false;
                    catInfo.seen = catInfo.seen || {};
                    var sec = document.createElement('div');
                    sec.className = 'sec';
                    var hd = document.createElement('div');
                    hd.className = 'sh';
                    hd.textContent = (catIcons[catInfo.name] || '🎞️') + ' ' + catInfo.name;
                    sec.appendChild(hd);
                    var grid = document.createElement('div');
                    grid.className = 'gr';
                    sec.appendChild(grid);
                    var bottom = document.createElement('div');
                    var statusTip = document.createElement('div');
                    statusTip.className = 'tip';
                    statusTip.textContent = '准备加载...';
                    bottom.appendChild(statusTip);
                    sec.appendChild(bottom);
                    main.appendChild(sec);
                    var appendItems = function(list) {
                        for (var i = 0; i < list.length; i++) {
                            if (list[i].url && !catInfo.seen[list[i].url]) {
                                catInfo.seen[list[i].url] = true;
                                catInfo.items.push(list[i]);
                                grid.appendChild(renderCard(list[i]));
                            }
                        }
                        hd.textContent = (catIcons[catInfo.name] || '🎞️') + ' ' + catInfo.name + '（' + catInfo.items.length + '部）';
                    };
                    var loadNext = function() {
                        if (catInfo.loading || catInfo.finished) return;
                        catInfo.loading = true;
                        var nextPage = (catInfo.page || 0) + 1;
                        statusTip.textContent = '正在加载第 ' + nextPage + ' 页...';
                        fetchCatPage(catInfo, nextPage).then(function(list) {
                            if (activeCat !== catInfo) return;
                            if (!list || list.length === 0) {
                                catInfo.finished = true;
                                statusTip.textContent = '— 已显示全部 —';
                                observer.disconnect();
                                return;
                            }
                            catInfo.page = nextPage;
                            appendItems(list);
                            statusTip.textContent = '已加载 ' + catInfo.items.length + ' 部。';
                        }).catch(function(e) {
                            statusTip.textContent = '加载失败，请确认 Node 代理已启动';
                        }).finally(function() {
                            catInfo.loading = false;
                        });
                    };
                    var observer = new IntersectionObserver(function(entries) {
                        if (entries[0].isIntersecting) loadNext();
                    }, {
                        rootMargin: '500px'
                    });
                    observer.observe(bottom);
                    // 回到顶部按钮
                    var backToTop = document.createElement('div');
                    backToTop.innerHTML = '↑';
                    backToTop.style.cssText = 'position:fixed;bottom:80px;right:16px;width:44px;height:44px;border-radius:50%;background:rgba(79,195,247,.45);color:#fff;font-size:22px;display:none;align-items:center;justify-content:center;cursor:pointer;z-index:200;border:1px solid rgba(79,195,247,.3);backdrop-filter:blur(6px);-webkit-tap-highlight-color:transparent;box-shadow:0 2px 10px rgba(0,0,0,.3)';
                    backToTop.onclick = function() {
                        window.scrollTo({
                            top: 0,
                            behavior: 'smooth'
                        });
                    };
                    document.body.appendChild(backToTop);
                    var _catScrollHandler = function() {
                        backToTop.style.display = window.scrollY > 400 ? 'flex' : 'none';
                    };
                    window.addEventListener('scroll', _catScrollHandler);

                    if (catInfo.items.length > 0) {
                        appendItems(catInfo.items);
                        statusTip.textContent = '已加载 ' + catInfo.items.length + ' 部。';
                    } else {
                        loadNext();
                    }
                };

                // 搜索
                var showSearch = function(query) {
                    var main = document.getElementById('main');
                    var car = document.getElementById('car');
                    var cbar = document.getElementById('cbar');
                    if (car) car.style.display = 'none';
                    main.style.display = 'none';
                    var frame = document.getElementById('catFrame');
                    if (!frame) {
                        frame = document.createElement('iframe');
                        frame.id = 'catFrame';
                        frame.style.cssText = 'width:100%;height:calc(100vh - 96px);border:0;background:transparent;display:block;position:fixed;top:96px;left:0;right:0;bottom:0;z-index:50';
                        main.parentNode.insertBefore(frame, main.nextSibling);
                    }
                    frame.style.display = 'block';
                    frame.src = 'http://127.0.0.1:9979/search?wd=' + encodeURIComponent(query);
                    window.scrollTo(0, 0);
                    return;
                    main.innerHTML = '';
                    document.getElementById('car').style.display = 'none';
                    var q = query.toLowerCase();
                    var allItems = [];
                    var seen = {};
                    var addFrom = function(arr) {
                        for (var i = 0; i < arr.length; i++) {
                            if (arr[i].url && !seen[arr[i].url]) {
                                seen[arr[i].url] = true;
                                allItems.push(arr[i]);
                            }
                        }
                    };
                    for (var s = 0; s < secData.length; s++) addFrom(secData[s].items);
                    for (var c = 0; c < catList.length; c++) addFrom(catList[c].items);
                    var results = [];
                    for (var r = 0; r < allItems.length; r++) {
                        if (allItems[r].title.toLowerCase().indexOf(q) !== -1) results.push(allItems[r]);
                    }
                    var sec = document.createElement('div');
                    sec.className = 'sec';
                    var hd = document.createElement('div');
                    hd.className = 'sh';
                    hd.textContent = '🔍 搜索「' + query + '」（' + results.length + '个结果）';
                    sec.appendChild(hd);
                    if (results.length === 0) {
                        var noResult = document.createElement('div');
                        noResult.className = 'tip';
                        noResult.textContent = '未找到匹配内容';
                        sec.appendChild(noResult);
                    } else {
                        var list = document.createElement('div');
                        list.className = 'sr-list';
                        for (var i = 0; i < results.length; i++) list.appendChild(renderSearchCard(results[i]));
                        sec.appendChild(list);
                    }
                    main.appendChild(sec);
                    window.scrollTo(0, 0);
                };

                // === 初始化 ===
                var secData = typeof sections === 'string' ? JSON.parse(sections) : sections;
                var catList = typeof catData === 'string' ? JSON.parse(catData) : catData;
                var main = document.getElementById('main');
                renderSections(main, secData);
                document.getElementById('tip').style.display = 'none';

                // ============================================================
                //  轮播模块 - 自动无缝循环轮播
                // ============================================================
                var carData = typeof lunbos === 'string' ? JSON.parse(lunbos) : lunbos;
                var carouselWrapper = document.getElementById('car');
                var track = document.getElementById('ct');
                var dotsContainer = document.getElementById('cds');
                initCarousel();

                function initCarousel() {

                    if (!carData || carData.length < 2) {
                        carouselWrapper.style.display = 'none';
                    } else {
                        var total = carData.length;
                        // 无缝：首尾各 clone 一份 → [cloneLast, ...original, cloneFirst]
                        var loopData = [carData[total - 1]].concat(carData).concat([carData[0]]);
                        var current = 1; // 指向原始数据第 0 项（loopData[1]）
                        var playing = false;
                        var timer = null;
                        var INTERVAL = 4000;

                        // 渲染轨道
                        track.innerHTML = '';
                        loopData.forEach(function(item) {
                            var slide = document.createElement('div');
                            slide.className = 'cs';
                            
                            var descText = (item.desc || '').replace(/&nbsp;/g, ' ');
                            slide.innerHTML =
                            '<img src="' + fixUrl(item.img) + '" alt="' + esc(item.title) + '" loading="lazy">' +
                            '<div class="cxt">' + (item.type ? '<div class="ctx">' + esc(item.type) + '</div>' : '') + '<div class="cxn">' + esc(item.title) + '</div><div class="cxd">' + esc(descText) + '</div></div>';
                            slide.addEventListener('click', (function(it) {
                                return function() {
                                    showDetail(it);
                                };
                            })(item));
                            track.appendChild(slide);
                        });

                        // 圆点
                        dotsContainer.innerHTML = '';
                        for (var i = 0; i < total; i++) {
                            var dot = document.createElement('div');
                            dot.className = 'cdot';
                            dot.addEventListener('click', (function(idx) {
                                return function() {
                                    if (playing) return;
                                    current = idx + 1; // +1 因为 loopData 偏移
                                    goTo(current, true);
                                    restartTimer();
                                };
                            })(i));
                            dotsContainer.appendChild(dot);
                        }

                        // ---- 核心函数 ----
                        function goTo(idx, animate) {
                            var w = track.parentElement.clientWidth;
                            if (!w) return;
                            track.style.transition = animate ? 'transform 0.4s ease-out' : 'none';
                            track.style.transform = 'translateX(-' + (idx * w) + 'px)';
                            current = idx;
                            updateDots();
                        }

                        function updateDots() {
                            var realIdx = ((current - 1) % total + total) % total;
                            var dots = dotsContainer.querySelectorAll('.cdot');
                            for (var i = 0; i < dots.length; i++) {
                                dots[i].className = 'cdot' + (i === realIdx ? ' on' : '');
                            }
                        }

                        function goNext() {
                            if (playing) return;
                            playing = true;
                            current++;
                            goTo(current, true);
                            setTimeout(function() {
                                playing = false;
                                // 到达尾部 clone → 无动画跳到原始第 0 项
                                if (current >= loopData.length - 1) {
                                    current = 1;
                                    goTo(current, false);
                                }
                            }, 420);
                        }

                        function goPrev() {
                            if (playing) return;
                            playing = true;
                            current--;
                            goTo(current, true);
                            setTimeout(function() {
                                playing = false;
                                // 到达头部 clone → 无动画跳到原始最后一项
                                if (current <= 0) {
                                    current = loopData.length - 2;
                                    goTo(current, false);
                                }
                            }, 420);
                        }

                        function startTimer() {
                            if (timer) clearInterval(timer);
                            timer = setInterval(goNext, INTERVAL);
                        }

                        function restartTimer() {
                            clearInterval(timer);
                            startTimer();
                        }

                        // ---- 触摸滑动 ----
                        var touchStartX = 0,
                            touchMoved = false;
                        carouselWrapper.addEventListener('touchstart', function(e) {
                            touchStartX = e.touches[0].clientX;
                            touchMoved = false;
                            restartTimer();
                        }, {
                            passive: true
                        });
                        carouselWrapper.addEventListener('touchmove', function(e) {
                            touchMoved = true;
                        }, {
                            passive: true
                        });
                        carouselWrapper.addEventListener('touchend', function(e) {
                            var dx = e.changedTouches[0].clientX - touchStartX;
                            if (Math.abs(dx) > 40) {
                                if (dx < 0) goNext();
                                else goPrev();
                            }
                            restartTimer();
                        }, {
                            passive: true
                        });

                        // ---- 初始化（延迟确保 clientWidth 可用） ----
                        setTimeout(function() {
                            goTo(1, false); // 定位到原始第 0 项
                            carouselWrapper.style.display = 'block';
                            startTimer();
                        }, 60);

                        // ---- 事件绑定 ----
                        document.getElementById('cpl').addEventListener('click', function() {
                            goPrev();
                            restartTimer();
                        });
                        document.getElementById('cpr').addEventListener('click', function() {
                            goNext();
                            restartTimer();
                        });
                        window.addEventListener('resize', function() {
                            goTo(current, false);
                        });

                        // 鼠标悬停暂停
                        carouselWrapper.addEventListener('mouseenter', function() {
                            clearInterval(timer);
                        });
                        carouselWrapper.addEventListener('mouseleave', function() {
                            startTimer();
                        });
                    }

                    // 搜索框
                    var searchInput = document.getElementById('searchInput');
                    var wormholeIcon = document.getElementById('wormhole-icon');
                    var doSearch = function() {
                        var q = searchInput.value.trim();
                        if (q) showSearch(q);
                    };
                    if (wormholeIcon) wormholeIcon.onclick = doSearch;
                    if (searchInput) searchInput.onkeydown = function(e) {
                        if (e.key === 'Enter') doSearch();
                    };

                } // initCarousel 结束

                // 分类栏
                var cates = document.querySelectorAll('.ci');
                for (var c = 0; c < cates.length; c++) {
                    cates[c].onclick = (function(btn) {
                        return function() {
                            for (var j = 0; j < cates.length; j++) cates[j].className = 'ci';
                            btn.className = 'ci on';
                            var action = btn.getAttribute('data-action');
                            var idx = parseInt(btn.getAttribute('data-idx'));
                            if (action === 'home') {
                                document.getElementById('car').style.display = 'block';
                                var header = document.querySelector('.header');
                                if (header) header.style.display = '';
                                var cbar = document.getElementById('cbar');
                                if (cbar) cbar.style.display = '';
                                var oldFrame = document.getElementById('catFrame');
                                if (oldFrame) oldFrame.parentNode.removeChild(oldFrame);
                                main.style.display = '';
                                renderSections(main, secData);
                            } else if (action === 'latest' || action === 'rank' || action === 'topic') {
                                document.getElementById('car').style.display = 'none';
                                main.style.display = 'none';
                                var frame = document.getElementById('catFrame');
                                if (!frame) {
                                    frame = document.createElement('iframe');
                                    frame.id = 'catFrame';
                                    frame.style.cssText = 'width:100%;height:calc(100vh - 96px);border:0;background:transparent;display:block;position:fixed;top:96px;left:0;right:0;bottom:0;z-index:50';
                                    main.parentNode.insertBefore(frame, main.nextSibling);
                                }
                                frame.style.display = 'block';
                                frame.src = 'http://127.0.0.1:9979/' + action;
                            } else if (!isNaN(idx) && catList[idx]) {
                                document.getElementById('car').style.display = 'none';
                                main.style.display = 'none';
                                var frame = document.getElementById('catFrame');
                                if (!frame) {
                                    frame = document.createElement('iframe');
                                    frame.id = 'catFrame';
                                    frame.style.cssText = 'width:100%;height:calc(100vh - 96px);border:0;background:transparent;display:block;position:fixed;top:96px;left:0;right:0;bottom:0;z-index:50';
                                    main.parentNode.insertBefore(frame, main.nextSibling);
                                }
                                frame.style.display = 'block';
                                frame.src = 'http://127.0.0.1:9979/category?cid=' + encodeURIComponent(catList[idx].cid) + '&name=' + encodeURIComponent(catList[idx].name);
                            }
                            window.scrollTo(0, 0);
                        };
                    })(cates[c]);
                }
            },
            htmlContent,
            JSON.stringify(lunbos),
            JSON.stringify(sections),
            JSON.stringify(catData),
            host,
            '304ca56b1b7b57ca7a47d9b59946be94',
            'http://127.0.0.1:9979/proxy?url='
        ),
        jsLoadingInject: true,

        urlInterceptor: $.toString((MY_RULE) => {
            return $.toString((url, MY_RULE) => {
                if (url && /^http:\/\/(127\.0\.0\.1|localhost):9979\/(category|api|search|search-api|proxy|health|tmdb|tmdb-page|home-api|latest|rank|topic|topic-detail|latest-api|rank-api|topic-api|topic-detail-api)/.test(url)) {
                    return url;
                }
                fy_bridge_app.open(JSON.stringify({
                    rule: MY_RULE.title,
                    title: "",
                    url: "hiker://page/c?rule=电影大全☃",
                    group: "",
                    col_type: "x5_webview_single",
                    findRule: "",
                    preRule: "",
                    extra: {
                        标签: "详情",
                        url: url + '#immersiveTheme##autoCache##gameTheme#'
                    }
                }));
                return "hiker://empty";
            }, input, MY_RULE)
        }, MY_RULE)
    }
})
}

setResult(d);