var 本地HTML = 'hiker://files/xc2022/sz_clock.html';
var 本地JS = 'hiker://files/xc2022/szbb_clock.js';
var 远程HTML = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html';
var 远程JS = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/szbb_clock.js';

// 创建目录（如果不存在）
if (!dirExist('hiker://files/xc2022/')) {
    createDir('hiker://files/xc2022/');
}

// 立即返回页面，后台检查更新
setTimeout(function() {
    try {
        // 检查是否需要更新
        var 需要更新 = false;
        
        if (!fileExist(本地JS) || !fileExist(本地HTML)) {
            需要更新 = true;
        } else {
            try {
                var 远程内容 = request(远程JS, {method: 'GET', timeout: 5000}).trim();
                var 本地内容 = readFile(本地JS).trim();
                if (远程内容 !== 本地内容) {
                    需要更新 = true;
                }
            } catch (e) {
                // 网络请求失败，跳过更新
            }
        }
        
        if (需要更新) {
            // 后台下载更新
            try {
                // 下载JS文件
                var js内容 = request(远程JS, {method: 'GET'});
                saveFile(js内容, 本地JS);
                
                // 下载HTML文件
                downloadFile(远程HTML, 本地HTML);
                
                // 可以发送通知，但不是必须的
                // toast('时钟已更新');
            } catch (e) {
                // 静默失败
            }
        }
    } catch (e) {
        // 忽略所有错误
    }
}, 100);

// 立即返回页面，不管更新状态
let x5_app = getPath(本地HTML);
[{
    title: '时钟天气',
    url: x5_app,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]