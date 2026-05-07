// vertical_carousel.js - 竖推轮播渲染器
(function(){
    // 样式字符串（压缩版）
    const styleText = `*{-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}body{margin:0;padding:2px 15px;background:#1a1a1a}.loader{display:flex;justify-content:center;align-items:center;gap:5px;height:200px}.box-container{position:relative;height:200px;width:136px;animation:32s linear infinite;transition:width 0.5s;cursor:pointer;overflow:hidden;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.4);border:1px solid #fff;box-sizing:border-box}.box-1{width:1px;animation-name:box1Anim}.box-2{width:140px;animation-name:box2Anim}.box-3{width:140px;animation-name:box3Anim}.box-4{width:140px;animation-name:box4Anim}.box{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}.img-title{position:absolute;bottom:-3px;left:50%;transform:translateX(-50%);color:#fff;font-weight:700;font-size:12px;text-shadow:2px 2px 6px rgba(0,0,0,0.8);opacity:1;transition:opacity .3s;z-index:10;pointer-events:none;white-space:nowrap;text-align:center;max-width:90%;overflow:hidden;animation:scrollText 10s linear infinite}@keyframes scrollText{0%{transform:translateX(-50%)}25%{transform:translateX(-50%)}75%{transform:translateX(calc(-50% - var(--scroll-distance,0px)))}100%{transform:translateX(-50%)}}@keyframes box1Anim{0%,10.94%{width:1px}12.5%,85.94%{width:140px}87.5%,100%{width:1px}}@keyframes box2Anim{0%,10.94%{width:140px}12.5%,23.44%{width:1px}25%,73.44%{width:140px}75%,85.94%{width:1px}87.5%,100%{width:140px}}@keyframes box3Anim{0%,23.44%{width:140px}25%,35.94%{width:1px}37.5%,59.38%{width:140px}60.94%,73.44%{width:1px}75%,100%{width:140px}}@keyframes box4Anim{0%,35.94%{width:140px}37.5%,59.38%{width:1px}60.94%,100%{width:140px}}@media (min-width:768px){.img-title{opacity:0}.box-container:hover .img-title{opacity:1}}@media (max-width:767px){.img-title{opacity:1}.box-container.contracted .img-title{opacity:0!important}}`;

    // HTML 结构
    const htmlStruct = `<div class="loader"><div class="box-container box-1"><img class="box" alt="1"><p class="img-title">图1</p></div><div class="box-container box-2"><img class="box" alt="2"><p class="img-title">图2</p></div><div class="box-container box-3"><img class="box" alt="3"><p class="img-title">图3</p></div><div class="box-container box-4"><img class="box" alt="4"><p class="img-title">图4</p></div></div>`;

    // 默认图片和标题（稳托底）
    const defaultItems = [
        { title: "推荐1", img: "https://picsum.photos/id/1015/300/450", url: "#" },
        { title: "推荐2", img: "https://picsum.photos/id/104/300/450", url: "#" },
        { title: "推荐3", img: "https://picsum.photos/id/107/300/450", url: "#" },
        { title: "推荐4", img: "https://picsum.photos/id/116/300/450", url: "#" }
    ];

    window.renderVerticalCarousel = function(containerId, items) {
        var container = document.getElementById(containerId);
        if (!container) {
            console.error('[Carousel] container not found:', containerId);
            return;
        }
        // 清空并设置样式
        container.innerHTML = '';
        container.style.cssText = 'width:100%;height:100%;margin:0;padding:0;';

        // 注入样式
        if (!document.getElementById('vc-style')) {
            var style = document.createElement('style');
            style.id = 'vc-style';
            style.textContent = styleText;
            document.head.appendChild(style);
        }

        // 插入 HTML 骨架
        container.insertAdjacentHTML('beforeend', htmlStruct);
        var boxes = container.querySelectorAll('.box-container');
        if (!boxes.length) return;

        // 处理数据
        var data = items && items.length ? items.slice(0,4) : defaultItems.slice();
        while (data.length < 4) data.push(defaultItems[data.length % 4]);

        // 填充每个盒子
        for (var i = 0; i < boxes.length; i++) {
            var box = boxes[i];
            var item = data[i];
            var img = box.querySelector('.box');
            var titleSpan = box.querySelector('.img-title');
            if (titleSpan) titleSpan.textContent = item.title || '无标题';
            if (img) {
                img.style.backgroundColor = '#2c3e50';
                var imgUrl = item.img && item.img.trim() ? item.img : defaultItems[i % 4].img;
                // 异步加载图片
                var testImg = new Image();
                testImg.onload = function() { img.src = imgUrl; img.style.backgroundColor = 'transparent'; };
                testImg.onerror = function() { img.src = defaultItems[i % 4].img; img.style.backgroundColor = 'transparent'; };
                testImg.src = imgUrl;
            }
            // 绑定点击
            box.onclick = (function(url, itemData) {
                return function() {
                    if (url && url !== '#') {
                        window.item = itemData;
                        window.open(url, '_blank');
                    }
                };
            })(item.url, item);
        }

        // 收缩动画检测
        var checkWidth = function() {
            for (var i = 0; i < boxes.length; i++) {
                if (boxes[i].offsetWidth < 50) boxes[i].classList.add('contracted');
                else boxes[i].classList.remove('contracted');
            }
            requestAnimationFrame(checkWidth);
        };
        checkWidth();

        // 防止右键菜单
        document.addEventListener('contextmenu', function(e) { e.preventDefault(); });

        // 文字滚动
        var setupScrolling = function() {
            var titles = container.querySelectorAll('.img-title');
            for (var i = 0; i < titles.length; i++) {
                var t = titles[i];
                var parent = t.closest('.box-container');
                if (!parent) continue;
                var pw = parent.offsetWidth;
                var tw = t.scrollWidth;
                if (tw > pw * 0.8) {
                    var distance = tw - pw * 0.8;
                    t.style.setProperty('--scroll-distance', distance + 'px');
                } else {
                    t.style.animation = 'none';
                }
            }
        };
        setTimeout(setupScrolling, 100);
        window.addEventListener('resize', setupScrolling);
        console.log('[Carousel] rendered with', data.length, 'items');
    };
})();