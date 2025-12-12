var 最新号 = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/szbb_clock.js';
var 最新源 = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html';
var 本地源 = 'hiker://files/xc2022/sz_clock.html';
var 本地号文件 = 'hiker://files/xc2022/szbb_clock.js';

// 确保目录存在
var dirPath = 'hiker://files/xc2022/';
if (!dirExist(dirPath)) {
    createDir(dirPath);
}

// 检查是否需要更新
var 需要更新 = false;

// 检查HTML文件是否存在且是否最新
if (!fileExist(本地源)) {
    需要更新 = true;
} else {
    try {
        // 获取远程HTML文件内容（只获取头部检查版本）
        var 远程HTML内容 = request(最新源, {
            method: 'GET',
            headers: {
                'Range': 'bytes=0-1000'
            }
        });
        
        // 读取本地HTML文件内容
        var 本地HTML内容 = readFile(本地源);
        
        // 简单比较文件开头是否相同
        if (本地HTML内容.substring(0, 1000) !== 远程HTML内容.substring(0, 1000)) {
            需要更新 = true;
        }
    } catch (e) {
        // 出错时也更新
        需要更新 = true;
    }
}

// 检查JS文件是否存在且是否最新
if (!fileExist(本地号文件)) {
    需要更新 = true;
}

// 如果需要更新，则下载文件
if (需要更新) {
    showLoading('更新文件中');
    
    try {
        // 先下载HTML文件
        var htmlContent = request(最新源, {method: 'GET'});
        saveFile(htmlContent, 本地源);
        
        // 然后下载JS文件
        var jsContent = request(最新号, {method: 'GET'});
        saveFile(jsContent, 本地号文件);
        
        hideLoading();
        toast('更新完成');
    } catch (e) {
        hideLoading();
        toast('更新失败：' + e);
        // 如果更新失败，尝试使用本地现有文件
    }
}

// 现在直接运行本地HTML文件
// 首先检查HTML文件是否存在
if (!fileExist(本地源)) {
    toast('HTML文件不存在');
    return [];
}

// 获取HTML文件的完整路径
var htmlPath = getPath(本地源);

// 返回结果，直接加载本地HTML文件
[{
    title: '时钟天气',
    url: htmlPath,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]