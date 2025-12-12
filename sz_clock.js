var 本地号 = '20251212';
var 最新号 = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/szbb_clock.js';
var 最新源 = 'https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html';
var 本地源 = 'hiker://files/xc2022/sz_clock.html';
var 本地号 = 'hiker://files/xc2022/szbb_clock.js';
if(!fileExist(本地号)||Number(request(本地号)) < 最新号){
    showLoading('加载中')
    deleteFile(本地号);
    deleteFile(本地源);
    downloadFile(最新源, 本地源);
    saveFile(本地号, 最新号);
    hideLoading();
};
[{
    url: getPath(本地源),
    desc: "list&&160",
    col_type: "x5_webview_single"
}]