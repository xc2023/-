// vertical_carousel.js - 竖推轮播组件
(function(){
    // 固定的 HTML 结构（4个盒子）
    const CAROUSEL_HTML = `
        <div class="loader">
            <div class="box-container box-1"><img class="box" alt="图1"><p class="img-title">图1</p></div>
            <div class="box-container box-2"><img class="box" alt="图2"><p class="img-title">图2</p></div>
            <div class="box-container box-3"><img class="box" alt="图3"><p class="img-title">图3</p></div>
            <div class="box-container box-4"><img class="box" alt="图4"><p class="img-title">图4</p></div>
        </div>
    `;

    // 样式字符串
    const STYLE_TEXT = `
        *{-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;tap-highlight-color:transparent}
        body{margin:0;padding:2px 15px;background:#1a1a1a;background-color:Canvas;color:CanvasText}
        .loader{display:flex;justify-content:center;align-items:center;gap:5px;height:200px}
        .box-container{position:relative;height:200px;width:136px;animation:32s linear infinite;transition:width 0.5s ease;cursor:pointer;overflow:hidden;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.4);border:1px solid white;box-sizing:border-box}
        .box-1{width:1px;animation-name:box1Anim}
        .box-2{width:140px;animation-name:box2Anim}
        .box-3{width:140px;animation-name:box3Anim}
        .box-4{width:140px;animation-name:box4Anim}
        .box{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
        .img-title{position:absolute;bottom:-3px;left:50%;transform:translateX(-50%);color:white;font-weight:bold;font-size:12px;text-shadow:2px 2px 6px rgba(0,0,0,0.8),0 0 10px rgba(0,0,0,0.5);opacity:1;transition:opacity 0.3s ease;z-index:10;pointer-events:none;white-space:nowrap;text-align:center;max-width:90%;overflow:hidden;animation:scrollText 10s linear infinite}
        @keyframes scrollText{0%{transform:translateX(-50%)}25%{transform:translateX(-50%)}75%{transform:translateX(calc(-50% - var(--scroll-distance, 0px)))}100%{transform:translateX(-50%)}}
        @keyframes box1Anim{0%,10.94%{width:1px;box-sizing:border-box}12.5%,85.94%{width:140px;box-sizing:border-box}87.5%,100%{width:1px;box-sizing:border-box}}
        @keyframes box2Anim{0%,10.94%{width:140px;box-sizing:border-box}12.5%,23.44%{width:1px;box-sizing:border-box}25%,73.44%{width:140px;box-sizing:border-box}75%,85.94%{width:1px;box-sizing:border-box}87.5%,100%{width:140px;box-sizing:border-box}}
        @keyframes box3Anim{0%,23.44%{width:140px;box-sizing:border-box}25%,35.94%{width:1px;box-sizing:border-box}37.5%,59.38%{width:140px;box-sizing:border-box}60.94%,73.44%{width:1px;box-sizing:border-box}75%,100%{width:140px;box-sizing:border-box}}
        @keyframes box4Anim{0%,35.94%{width:140px;box-sizing:border-box}37.5%,59.38%{width:1px;box-sizing:border-box}60.94%,100%{width:140px;box-sizing:border-box}}
        @media (min-width:768px){.img-title{opacity:0}.box-container:hover .img-title{opacity:1}}
        @media (max-width:767px){.img-title{opacity:1}.box-container.contracted .img-title{opacity:0!important}}
    `;

    // 全局函数：创建竖推轮播
    window.createVerticalCarousel = function(containerId, items) {
        const container = document.getElementById(containerId);
        if (!container) {
            console.error('容器不存在:', containerId);
            return;
        }
        // 清空容器并设置样式
        container.innerHTML = '';
        container.style.cssText = 'width:100%;height:100%;margin:0;padding:0;';

        // 注入样式（如果尚未注入）
        if (!document.getElementById('vc-style')) {
            const styleEl = document.createElement('style');
            styleEl.id = 'vc-style';
            styleEl.textContent = STYLE_TEXT;
            document.head.appendChild(styleEl);
        }

        // 插入 HTML 结构
        container.insertAdjacentHTML('beforeend', CAROUSEL_HTML);

        // 获取所有盒子
        const containers = container.querySelectorAll('.box-container');
        const defaultImages = [
            "https://picsum.photos/id/1015/800/400",
            "https://picsum.photos/id/104/800/400",
            "https://picsum.photos/id/107/800/400",
            "https://picsum.photos/id/116/800/400"
        ];

        // 更新每个盒子的内容和点击事件
        containers.forEach((box, idx) => {
            if (items && items[idx]) {
                const item = items[idx];
                const img = box.querySelector('img');
                const titleEl = box.querySelector('.img-title');
                if (titleEl) titleEl.textContent = item.title || '无标题';
                if (img) {
                    img.style.backgroundColor = '#2c3e50';
                    const userImg = item.img;
                    const defaultImg = defaultImages[idx % defaultImages.length];
                    if (userImg && userImg.trim()) {
                        const testImg = new Image();
                        testImg.onload = () => { img.src = userImg; img.style.backgroundColor = 'transparent'; };
                        testImg.onerror = () => { img.src = defaultImg; img.style.backgroundColor = 'transparent'; };
                        testImg.src = userImg;
                    } else {
                        img.src = defaultImg;
                        img.style.backgroundColor = 'transparent';
                    }
                }
                // 绑定点击事件
                box.onclick = () => {
                    if (item.url) {
                        window.item = item;
                        window.open(item.url, '_blank');
                    }
                };
            }
        });

        // 收缩效果和文字滚动（复用原有逻辑）
        const checkWidth = () => {
            containers.forEach(box => {
                if (box.offsetWidth < 50) box.classList.add('contracted');
                else box.classList.remove('contracted');
            });
            requestAnimationFrame(checkWidth);
        };
        checkWidth();

        document.addEventListener('contextmenu', (e) => e.preventDefault());

        const setupTextScrolling = () => {
            const titles = container.querySelectorAll('.img-title');
            titles.forEach(title => {
                const parent = title.closest('.box-container');
                if (!parent) return;
                const containerWidth = parent.offsetWidth;
                const titleWidth = title.scrollWidth;
                if (titleWidth > containerWidth * 0.8) {
                    const distance = titleWidth - containerWidth * 0.8;
                    title.style.setProperty('--scroll-distance', distance + 'px');
                } else {
                    title.style.animation = 'none';
                }
            });
        };
        setTimeout(setupTextScrolling, 100);
        window.addEventListener('resize', setupTextScrolling);
    };
})();