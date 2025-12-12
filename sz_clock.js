// 只需要一个HTML文件，JS文件仅用于版本控制
var 本地HTML = 'hiker://files/xc2022/sz_clock.html';
var 本地JS = 'hiker://files/xc2022/szbb_clock.js';
var 远程HTML = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html';
var 远程JS = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/szbb_clock.js';

// 确保目录存在
if (!dirExist('hiker://files/xc2022/')) {
    createDir('hiker://files/xc2022/');
}

// 简化的更新逻辑：只检查JS版本文件是否存在和是否需要更新
try {
    var 需要更新 = false;
    
    // 如果JS文件不存在，需要更新
    if (!fileExist(本地JS)) {
        需要更新 = true;
    } else {
        // 获取远程JS内容进行比较
        var 远程内容 = request(远程JS, {method: 'GET'}).trim();
        var 本地内容 = readFile(本地JS).trim();
        
        if (远程内容 !== 本地内容) {
            需要更新 = true;
        }
    }
    
    // 如果HTML文件不存在，也需要更新
    if (!fileExist(本地HTML)) {
        需要更新 = true;
    }
    
    // 如果需要更新，下载两个文件
    if (需要更新) {
        showLoading('更新中...');
        
        // 下载JS文件
        try {
            var js内容 = request(远程JS, {method: 'GET'});
            saveFile(js内容, 本地JS);
        } catch (e) {
            console.log('下载JS文件失败：' + e);
            // 创建默认JS文件
            saveFile('20251212', 本地JS);
        }
        
        // 下载HTML文件
        try {
            downloadFile(远程HTML, 本地HTML);
        } catch (e) {
            console.log('下载HTML文件失败：' + e);
        }
        
        hideLoading();
        toast('更新完成');
    }
} catch (error) {
    console.log('更新检查失败：' + error);
}

// 直接返回本地HTML文件路径
let x5_app = getPath(本地HTML);
[{
    title: '时钟天气',
    url: x5_app,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]