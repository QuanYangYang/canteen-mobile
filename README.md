# 食堂收货拍照 PWA

这是“食堂收货拍照”手机端 PWA 的 GitHub Pages 部署仓库。

- 入口：https://quanyangyang.github.io/canteen-mobile/
- 电脑端导入：在电脑端“送货单导入”页选择“导入手机拍照包”，上传手机导出的 ZIP。
- 更新：重新上传 `index.html`、`app.js`、`styles.css`、`parser.js`、`workbook.js`、`sw.js`、`manifest.webmanifest`、`icons/`、`vendor/`；并同步修改 `sw.js` 的 `CACHE` 版本号。

数据只保存在手机浏览器本地，不上传服务器。
