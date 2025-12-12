var 本地号 = '20251212';
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

if (!fileExist(本地号文件)) {
    // 本地文件不存在，需要更新
    需要更新 = true;
} else {
    try {
        // 读取本地版本号
        var 本地版本内容 = readFile(本地号文件);
        var 本地版本号 = 本地版本内容.trim();
        
        // 获取远程版本号
        showLoading('检查更新中');
        var 远程版本内容 = request(最新号, {method: 'GET'});
        var 远程版本号 = 远程版本内容.trim();
        hideLoading();
        
        // 比较版本号（按字符串或按数字比较）
        if (本地版本号 !== 远程版本号) {
            // 你也可以使用数字比较：Number(本地版本号) < Number(远程版本号)
            需要更新 = true;
        }
    } catch (e) {
        // 出错时也更新
        需要更新 = true;
        console.log('检查更新时出错：' + e);
    }
}

// 如果需要更新，则下载文件
if (需要更新) {
    showLoading('更新文件中');
    
    // 删除旧文件（如果存在）
    if (fileExist(本地源)) {
        deleteFile(本地源);
    }
    if (fileExist(本地号文件)) {
        deleteFile(本地号文件);
    }
    
    // 下载新文件
    try {
        // 先下载版本号文件
        var 远程版本内容 = request(最新号, {method: 'GET'});
        saveFile(远程版本内容, 本地号文件);
        
        // 再下载源文件
        downloadFile(最新源, 本地源);
        
        hideLoading();
        toast('更新完成');
    } catch (e) {
        hideLoading();
        toast('更新失败：' + e);
    }
}

let x5_app=getPath('hiker://files/xc2022/sz_clock.html');
[{
    title:'时钟天气',
    url:x5_app,
    col_type:'x5_webview_single',
    desc:'160&&list',
}]