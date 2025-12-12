var 本地HTML = "hiker://files/xc2022/sz_clock.html";
var 本地JS = "hiker://files/xc2022/szbb_clock.js";
var 远程HTML = "https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html";
var 远程JS = "https://raw.githubusercontent.com/xc2023/-/refs/heads/main/szbb_clock.js";

// 创建目录
if (!dirExist('hiker://files/xc2022/')) {
    createDir('hiker://files/xc2022/');
}

// 简单检查：如果任意一个文件不存在，就更新
if (!fileExist(本地HTML) || !fileExist(本地JS)) {
    showLoading('下载文件中');
    try {
        // 下载JS文件
        var js内容 = request(远程JS);
        saveFile(js内容, 本地JS);
        
        // 下载HTML文件
        downloadFile(远程HTML, 本地HTML);
        hideLoading();
        toast('文件已下载');
    } catch (e) {
        hideLoading();
        toast('下载失败：' + e);
    }
}

// 返回结果
[{
    title: '时钟天气',
    url: fileExist(本地HTML) ? getPath(本地HTML) : 远程HTML,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]