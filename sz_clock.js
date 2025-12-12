var 远程HTML = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html';
var 本地HTML = 'hiker://files/xc2022/sz_clock.html';

// 确保目录存在
if (!dirExist('hiker://files/xc2022/')) {
    createDir('hiker://files/xc2022/');
}

// 如果文件不存在或超过30天没更新，重新下载
if (!fileExist(本地HTML) || (Date.now() - getFileLastModified(本地HTML)) > 30 * 24 * 60 * 60 * 1000) {
    requireDownload(远程HTML, 本地HTML);
}

// 使用本地文件
let x5_app = getPath(本地HTML);
[{
    title: '时钟天气',
    url: x5_app,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]