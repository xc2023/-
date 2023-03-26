js:
var d = [];

function lazy(url) {
    return $(url).lazyRule(() => {
        showLoading("\u5df2\u5f00\u542f\u5f3a\u529b\u55c5\u63a2\uff0c\u8bf7\u7a0d\u5019");
        return 'x5Rule://' + input + '@' + $.toString(() => {
            var urls = _getUrls()
            for (var i in urls) {
                if (urls[i].match(/\.mp4?|\.m3u8|\.mp4|\.flv|\_mp4/)) {
                    return urls[i] + '#isVideo=true#;{User-Agent@Mozilla/5.0 (Windows NT 10.0)}';
                }
            }
        })
    })
}
d.push({
    title: "八卦象棋直播",
    img: "https://p3-search.byteimg.com/img/labis/7729e2205bfc947e8bd46600467eb0f2~640x640.PNG",
    url: lazy('https://m.douyu.com/851040'),
    
})
d.push({
    title: "帽子哥象棋直播",
    img: "https://nimg.ws.126.net/?url=http://videoimg.ws.126.net/cover/20221225/HDJYEvRBj_cover.jpg&thumbnail=668y375&quality=95&type=jpg",
    url: lazy('https://m.douyu.com/4487219'),
})
d.push({
    title: "柳大华象棋直播",
    img: "https://i0.hdslb.com/bfs/archive/997c04d0f1eb16023c4539ba522360ed9f53d493.jpg",
    url: lazy('https://webcast.amemv.com/douyin/webcast/reflow/7212967913798798140?sec_user_id=MS4wLjABAAAAHSZshX0i347y7D9zeQPOoEFEtF4-jipaNTx2yDZdCkJh6MC551h4r7gznlOEV_jp'),
    
})
d.push({
    title: "勇哥讲棋直播间",
    img: "https://p3-search.byteimg.com/obj/labis/643be37741574dd9a04b4141e2a5e11c",
    url: lazy('https://www.huya.com/223683'),
    
})
d.push({
    title: "陈栋象棋直播",
    img: "https://img04.sogoucdn.com/v2/thumb?t=2&url=http%3A%2F%2Fpuui.qpic.cn%2Fvpic_cover%2Fd07218qvfkf%2Fd07218qvfkf_hz.jpg%2F1280&appid=200580",
    url: lazy('https://live.douyin.com/16281719939?cover_type=0&enter_from_merge=web_live&enter_method=web_card&game_name=%E8%B1%A1%E6%A3%8B&is_recommend=1&live_type=game&more_detail=game_597&request_id=20230321211207FA1D7931EDB3B4312E74&room_id=7212975822414564157&stream_type=vertical&title_type=1&web_live_page=game_591&web_live_tab=more'),
    
})
d.push({
    title: "孙浩宇象棋直播",
    img: "https://img2.baidu.com/it/u=954847606,1386344710&fm=253&fmt=auto&app=138&f=JPEG?w=889&h=500",
    url: lazy('https://webcast.amemv.com/douyin/webcast/reflow/7212979125890419513?sec_user_id=MS4wLjABAAAAd5djhg7AQ73is0G6MZK3lqDvA-Ta91UDmBfSoBReFyAHMIFw5w9-i7w3dq0uNfAc'),
    
})
d.push({
    title: "背谱王子象棋直播",
    img: "https://live-cover.msstatic.com/huyalive/1199535077034-1199535077034-5322329700905779200-2399070277524-10057-A-0-1/20230326090716.jpg?x-oss-process=image/resize,limit_0,m_fill,w_338,h_190/sharpen,80/quality,q_90&streamName=1199535077034-1199535077034-5322329700905779200-2399070277524-10057-A-0-1&interval=10",
    url: lazy('https://webcast.amemv.com/douyin/webcast/reflow/7212680385648642853?sec_user_id=MS4wLjABAAAAzrnWpUUhEMloALFn2AdOksquSxxjKn6-2vEOyteVmLjpP_jyprFlQDwOJI2hSZMr'),
    
})
d.push({
    title: "赵鑫鑫象棋直播",
    img: "https://img03.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto/q/79/crop/xy/ai/w/686/h/386/resize/w/686?url=https%3A%2F%2Fpuui.qpic.cn%2Fvpic_cover%2Fh0859h0x1rw%2Fh0859h0x1rw_hz.jpg%2F1280&appid=201003&sign=58bfb7fb41eefed9d9ca0c3f5d1404b4",
    url: lazy('https://webcast.amemv.com/douyin/webcast/reflow/7213903710936714021?sec_user_id=MS4wLjABAAAAjnsO-GbjDI1A4b-kkuT38m6dgRgARwPuVsePhMFQcj04y9ip2u5nYcTv0QnvSfW8'),
    
})
d.push({
    title: "象棋王子象棋直播",
    img: "https://p4.itc.cn/images01/20220702/9f2fe6584151453c83b572d70c54fc71.jpeg",
    url: lazy('https://webcast.amemv.com/douyin/webcast/reflow/7213918089358986039?sec_user_id=MS4wLjABAAAAode9VIMI-91LZUKN3J7vdmXT4ZTL9rfm8CmnHLDTyHk'),
    
})
d.push({
    title: "金松象棋直播",
    img: "https://img02.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto/q/79/crop/xy/ai/w/686/h/386/resize/w/686?url=https%3A%2F%2Fi2.hdslb.com%2Fbfs%2Farchive%2F180b6b8ec06ef79229fdf479e4b0e25a8cdc6ab5.png&appid=201003&sign=8185a9df1774331435c1a27a3f552047",
    url: lazy('https://webcast.amemv.com/douyin/webcast/reflow/7214041731430435642?sec_user_id=MS4wLjABAAAAGGR3nFeqEn57DzEkExozej0XtvFJVfrhL4a_bWEVfmI'),
    
})
d.push({
    title: "郑惟桐象棋直播",
    img: "https://img02.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto/q/79/crop/xy/ai/w/686/h/386/resize/w/686?url=https%3A%2F%2Fi0.hdslb.com%2Fbfs%2Farchive%2Fb66be24971c78874e48f94e79c88552e48e6878b.jpg&appid=201003&sign=ba8be7bb1872ab95a7522220e7734cf6",
    url: lazy('https://webcast.amemv.com/douyin/webcast/reflow/7214019509168900924?sec_user_id=MS4wLjABAAAA47Fan8r0VK2ojCtS05ARN58AHoIMPH36cOPmq0thDQw'),
    
})
d.push({
    title: "孙浩宇虎牙象棋直播",
    img: "https://img2.baidu.com/it/u=954847606,1386344710&fm=253&fmt=auto&app=138&f=JPEG?w=889&h=500",
    url: lazy('https://www.huya.com/382310'),
    
})
d.push({
    title: "许银川象棋直播",
    img: "https://i02piccdn.sogoucdn.com/f1e08d1d0f6a564f",
    url: lazy('https://live.douyin.com/969280804278'),
    
})
d.push({
    title: "天天象棋直播",
    img: "https://img02.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto/q/79/crop/xy/ai/w/686/h/386/resize/w/686?url=http%3A%2F%2Fp26-sign.bdxiguaimg.com%2Ftos-cn-i-0004%2Ff3a3f58ae7124173b566190a8f858014~tplv-pk90l89vgd-crop-center%3A864%3A486.jpeg%3Fx-expires%3D1705355469%26x-signature%3DFZITI7Lgu7nLxXvb6P8d6cqgDRM%253D&appid=201003&sign=ad5dc6fbc4eabc2f9a6dd4f5c7b87930",
    url: lazy('https://wap.yy.com/mobileweb/1354650216/0#/ent')
})
d.push({
    title: "橘仙象棋直播",
    img: "https://rpic.douyucdn.cn/asrpic/230322/5139927_src_0813.avif/dy1",
    url: lazy('https://m.douyu.com/5139927')
})
d.push({
    title: "背谱王子象棋直播",
    img: "https://rpic.douyucdn.cn/asrpic/230322/10237093_src_0807.avif/dy1",
    url: lazy('https://m.douyu.com/10237093')
})
d.push({
    title: "大神KOR象棋直播",
    img: "https://rpic.douyucdn.cn/asrpic/230322/1227260_src_0806.avif/dy1",
    url: lazy('https://m.douyu.com/1227260')
})
d.push({
    title: "小鹤求败象棋直播",
    img: "https://rpic.douyucdn.cn/asrpic/230322/3830820_src_0759.avif/dy1",
    url: lazy('https://m.douyu.com/3830820')
})
d.push({
    title: "肖九拙象棋直播",
    img: "https://img04.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto/q/79/crop/xy/ai/w/686/h/386/resize/w/686?url=https%3A%2F%2Fi2.hdslb.com%2Fbfs%2Farchive%2F97fe1b65fb83191e24670018053a1d596ee2c64d.jpg&appid=201003&sign=93eb686d3e798f25760ee2e2fe916589",
    url: lazy('https://www.douyu.com/4369877')
})
d.push({
    title: "雷疯象棋直播",
    img: "https://img04.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto/q/79/crop/xy/ai/w/686/h/386/resize/w/686?url=http%3A%2F%2Fi1.hdslb.com%2Fbfs%2Farchive%2Fb0a1abda926a4eb8956043cdec908dcde4d4a10a.jpg&appid=201003&sign=401f9076f6a2704d99eb8f2d066bd83e",
    url: lazy('https://www.douyu.com/291514')
})
d.push({
    title: "林秋延象棋直播",
    img: "https://img04.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto/q/79/crop/xy/ai/w/686/h/386/resize/w/686?url=http%3A%2F%2Fi2.hdslb.com%2Fbfs%2Farchive%2Fc0e708189ff57238432798d3f2053e40ec73f5b7.jpg&appid=201003&sign=76f8abe6a19fef021d2a89497e062e51",
    url: lazy('https://m.huya.com/856751')
})
d.push({
    title: "小鹤求败象棋直播",
    img: "https://rpic.douyucdn.cn/asrpic/230322/3830820_src_0759.avif/dy1",
    url: lazy('https://m.douyu.com/3830820')
})
d.push({
    title: "王天一象棋直播轮播",
    img: "https://img03.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto/q/79/crop/xy/ai/w/686/h/386/resize/w/686?url=http%3A%2F%2Fp26-sign.bdxiguaimg.com%2Ftos-cn-i-0000%2F2a962ca4af6a11e9bc7e7cd30a55e9ba~tplv-pk90l89vgd-crop-center%3A864%3A486.jpeg%3Fx-expires%3D1694563237%26x-signature%3DclK04HrTSykrDO9dbrGhT803kxM%253D&appid=201003&sign=3dc07dcbb30ebfef0ebbb0285d6ff1bc",
    url: lazy('https://m.huya.com/19096040')
})
d.push({
    title: "虎牙象棋国手象棋直播",
    img: "https://hw-live-cover.msstatic.com/huyalive/17989609-17989609-77264782322827264-4404057136-10057-A-0-1/20230326090257.jpg?x-oss-process=style/w338_h190&ignore-sign-in-query=x-image-process,x-oss-process&AWSAccessKeyId=QZDMVHKCUJBV0Z15GO0X&Expires=1695344577&Signature=CjnSjYJM3vJR6nclKqvhVSecems=&streamName=17989609-17989609-77264782322827264-4404057136-10057-A-0-1&interval=10",
    url: lazy('https://m.huya.com/14730819')
})
setResult(d);