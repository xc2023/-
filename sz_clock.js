var 本地HTML = "hiker://files/xc2022/sz_clock.html";
var 远程HTML = "https://raw.githubusercontent.com/xc2023/-/refs/heads/main/sz_clock.html";

// 每天检查一次更新
try {
    var 今天 = new Date().toDateString(); // 获取日期字符串，忽略时间部分
    
    // 检查上次更新日期
    var 上次更新键 = "时钟天气_上次更新";
    var 上次更新日期 = getVar(上次更新键, "");
    
    if (上次更新日期 !== 今天) {
        // 今天还没检查过
        try {
            var 远程内容 = request(远程HTML, {timeout: 3000});
            if (远程内容 && 远程内容.length > 0) {
                var 需要保存 = false;
                
                if (!fileExist(本地HTML)) {
                    需要保存 = true;
                } else {
                    var 本地内容 = readFile(本地HTML);
                    if (远程内容 !== 本地内容) {
                        需要保存 = true;
                    }
                }
                
                if (需要保存) {
                    writeFile(本地HTML, 远程内容);
                }
            }
        } catch (e) {
            // 网络错误，明天再试
        }
        
        // 记录今天已检查
        putVar(上次更新键, 今天);
    }
} catch (e) {
    console.log("更新检查出错: " + e);
}

// 使用本地文件
let x5_app = getPath(本地HTML);
 [{
    title: '时钟天气',
    url: x5_app,
    col_type: 'x5_webview_single',
    desc: '160&&list',
}]