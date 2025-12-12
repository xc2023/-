// 最终简化版：只关心HTML文件
var 本地HTML = 'hiker://files/xc2022/sz_clock.html';
var 远程HTML = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html';

// 确保目录存在
if (!dirExist('hiker://files/xc2022/')) {
    createDir('hiker://files/xc2022/');
}

// 如果本地HTML不存在，从远程下载
if (!fileExist(本地HTML)) {
    try {
        // 简单下载，不检查版本
        downloadFile(远程HTML, 本地HTML);
    } catch (e) {
        // 如果下载失败，直接使用远程URL
        let x5_app = 远程HTML;
        return [{
            title: '时钟天气',
            url: x5_app,
            col_type: 'x5_webview_single',
            desc: '160&&list',
        }];
    }
}

// 使用本地HTML
let x5_app = getPath(本地HTML);
[{
    title: '时钟天气',
    url: x5_app,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]