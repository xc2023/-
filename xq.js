const BASE_URL = "https://git.tyrantg.com/tyrantgenesis/hikerViewRules/raw/master/"
/* Base Function */

/**
* @param fetch_file String 远程文件web地址
* @param local_file String 本地文件路径
* */
const godWriteFile = (fetch_file, local_file) => {
  let localFile = request(local_file);
  let fetchFile = request(fetch_file);
  if (!localFile || localFile !== fetchFile) writeFile(local_file, fetchFile)
}

const godSaveFile = (fetch_file, local_file) => {
  let localFile = request(local_file);
  let fetchFile = request(fetch_file);
  if (!localFile) writeFile(local_file, fetchFile)
}

const time = (new Date()).getTime()

/* Base Function */

/* Customize Function */
const xqzb = _ => {
  godWriteFile(BASE_URL+"zbxq.js", 'hiker://hiker://files/xc2022/xqzb.js')
  /* Customize Function */