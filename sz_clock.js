var 本地HTML = 'hiker://files/xc2022/sz_clock.html';

// 创建目录
if (!dirExist('hiker://files/xc2022/')) {
    createDir('hiker://files/xc2022/');
}

// 只检查HTML文件是否存在，不存在就下载
if (!fileExist(本地HTML)) {
    try {
        // 只使用downloadFile，避免saveFile的问题
        downloadFile(
            'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html',
            本地HTML
        );
        toast('HTML文件已下载');
    } catch (e) {
        console.log('下载失败：' + e);
    }
}

// 直接使用本地HTML文件
let x5_app = getPath(本地HTML);
[{
    title: '时钟天气',
    url: x5_app,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]