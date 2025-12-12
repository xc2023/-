var l = [];
var 版本号 = '20251212';
var 版本文件 = "hiker://files/xc2022/szbb_clock.js";

// 检查并更新文件
try {
    var 最新HTML = "https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html";
    var 最新JS = "https://raw.githubusercontent.com/xc2023/-/refs/heads/main/szbb_clock.js";
    var 本地HTML = "hiker://files/xc2022/sz_clock.html";
    
    // 确保目录存在
    var dirPath = 'hiker://files/xc2022/';
    if (!dirExist(dirPath)) {
        createDir(dirPath);
    }
    
    // 检查是否需要更新
    // 条件：本地HTML不存在 或 版本文件不存在 或 版本文件内容不是最新
    if (!fileExist(本地HTML) || !fileExist(版本文件) || request(版本文件) !== 版本号) {
        // 下载JS版本文件
        try {
            var jsContent = request(最新JS, {method: 'GET'});
            saveFile(jsContent, 版本文件);
        } catch (e) {
            console.log('下载JS文件失败：' + e);
            // 如果下载失败，创建默认版本文件
            saveFile(版本号, 版本文件);
        }
        
        // 下载HTML文件
        try {
            downloadFile(最新HTML, 本地HTML);
        } catch (e) {
            console.log('下载HTML文件失败：' + e);
        }
    }
} catch (error) {
    console.log('更新文件时出错：' + error);
}

// 加载本地HTML文件
if (fileExist(本地HTML)) {
    l.push({
        title: '时钟天气',
        url: getPath(本地HTML),
        desc: "160&&list",
        col_type: "x5_webview_single",
        exea: {
            autoPlay: true
        }
    });
} else {
    // 如果本地文件不存在，直接使用远程URL
    l.push({
        title: '时钟天气',
        url: "https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html",
        desc: "160&&list",
        col_type: "x5_webview_single",
        exea: {
            autoPlay: true
        }
    });
}

l;