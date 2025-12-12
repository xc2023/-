var l = [];
var 版本号 = '20251212';
var 版本文件 = "hiker://files/xc2022/szbb_clock.js";

function 检查更新() {
    try {
        var 本地HTML = "hiker://files/xc2022/sz_clock.html";
        var 在线HTML = "https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html";
      
        if (!fileExist(本地HTML) || !fileExist(版本文件) || request(版本文件) !== 版本号) {
            downloadFile(在线HTML, 本地HTML);
       
            var 版本内容 = '20251212'; 
            saveFile(版本内容, 版本文件);
            
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

// 执行检查
检查更新();

// 返回结果
let x5_app = getPath("hiker://files/xc2022/sz_clock.html");
[{
    title: '时钟天气',
    url: x5_app,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]