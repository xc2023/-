// 版本号必须用引号，确保是字符串类型
var 版本号 = '20251212';
var 本地HTML = 'hiker://files/xc2022/sz_clock.html';
var 本地JS = 'hiker://files/xc2022/szbb_clock.js';
var 远程HTML = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html';
var 远程JS = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/szbb_clock.js';

// 确保目录存在
if (!dirExist('hiker://files/xc2022/')) {
    createDir('hiker://files/xc2022/');
}

// 检查是否需要更新
try {
    var 需要更新 = false;
    
    // 检查文件是否存在
    if (!fileExist(本地HTML) || !fileExist(本地JS)) {
        需要更新 = true;
    } else {
        // 读取本地JS文件内容
        var 本地内容 = readFile(本地JS).trim();
        
        // 尝试获取远程内容
        try {
            var 远程内容 = request(远程JS, {method: 'GET'}).trim();
            if (本地内容 !== 远程内容) {
                需要更新 = true;
            }
        } catch (e) {
            // 网络请求失败，跳过更新检查
            console.log('检查更新失败：' + e);
        }
    }
    
    // 如果需要更新
    if (需要更新) {
        showLoading('更新中...');
        
        // 确保使用字符串作为参数
        try {
            // 下载远程JS文件内容
            var js内容 = request(远程JS, {method: 'GET'});
            // 确保第二个参数是字符串
            saveFile(String(js内容), String(本地JS));
        } catch (e) {
            console.log('下载JS失败：' + e);
            // 如果下载失败，使用默认版本号
            saveFile(String(版本号), String(本地JS));
        }
        
        // 下载HTML文件
        try {
            downloadFile(远程HTML, 本地HTML);
        } catch (e) {
            console.log('下载HTML失败：' + e);
        }
        
        hideLoading();
    }
} catch (error) {
    console.log('更新过程出错：' + error);
}

// 直接返回本地HTML
let x5_app = getPath(本地HTML);
[{
    title: '时钟天气',
    url: x5_app,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]