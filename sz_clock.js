var 本地HTML = 'hiker://files/xc2022/sz_clock.html';
var 本地JS = 'hiker://files/xc2022/szbb_clock.js';
var 远程HTML = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html';
var 远程JS = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/szbb_clock.js';

// 确保目录存在
if (!dirExist('hiker://files/xc2022/')) {
    createDir('hiker://files/xc2022/');
}

// 只检查HTML文件是否存在
if (!fileExist(本地HTML)) {
    try {
        // 使用downloadFile下载HTML文件
        downloadFile(远程HTML, 本地HTML);
    } catch (e) {
        console.log('下载HTML失败: ' + e);
    }
}

// 如果JS文件不存在，尝试下载（但不强求）
if (!fileExist(本地JS)) {
    try {
        // 使用downloadFile下载JS文件
        downloadFile(远程JS, 本地JS);
    } catch (e) {
        console.log('下载JS失败: ' + e);
    }
}

// 直接返回本地HTML文件路径
let x5_app = getPath(本地HTML);
[{
    title: '时钟天气',
    url: x5_app,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]