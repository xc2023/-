var 本地HTML = 'hiker://files/xc2022/sz_clock.html';
var 本地JS = 'hiker://files/xc2022/szbb_clock.js';

// 确保目录存在
if (!dirExist('hiker://files/xc2022/')) {
    createDir('hiker://files/xc2022/');
}

// 检查是否需要更新
try {
    // 获取远程内容
    var 远程JS内容 = request('https://raw.githubusercontent.com/xc2023/-/refs/heads/main/szbb_clock.js');
    
    // 如果本地JS文件不存在，或者内容不同
    if (!fileExist(本地JS) || readFile(本地JS) !== 远程JS内容) {
        // 使用writeFile替代saveFile
        writeFile(本地JS, 远程JS内容);
        
        // 下载HTML文件
        downloadFile('https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html', 本地HTML);
    }
} catch (e) {
    console.log('更新检查失败: ' + e);
    
    // 如果失败，确保至少HTML文件存在
    if (!fileExist(本地HTML)) {
        try {
            downloadFile('https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html', 本地HTML);
        } catch (e2) {
            console.log('下载HTML失败: ' + e2);
        }
    }
}

// 返回本地HTML
let x5_app = getPath(本地HTML);
[{
    title: '时钟天气',
    url: x5_app,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]