# 第三方声明与来源边界

本文件记录《seekdb 大海戦》公开源码及离线试玩包使用的第三方组件。许可原文优先于本说明；各组件继续适用自己的许可。公开仓库不会改变第三方代码、字体或品牌的许可。

本项目的原创游戏代码、玩法文案与自绘界面目前**尚未指定开源许可证**。仓库公开不表示为原创部分选择了 MIT、Apache-2.0 或其他开源许可证；下文的第三方许可也不应被套用于整个游戏。

## seekdb 引擎

游戏使用 [seekdb 官方项目](https://github.com/oceanbase/seekdb) 的浏览器 Shell 发行文件。Apache-2.0 原文保存在 [game/engine/LICENSE](../game/engine/LICENSE)，每个下载文件的官方地址、大小和 SHA-256 保存在 [引擎来源记录](../game/engine/来源.json)。

本次采用的 Shell 发布 ID 为：

```text
d2ece8f7aba157c0e18f600bd876000302f61d879426cbf1c96b2d501ee89887
```

Chrome 与 WebKit 两套 Wasm 二进制保留官方原始字节。单页打包会重定位 JavaScript 模块、Wasm URL 与 Worker URL；这些分发副本改动由构建清单的 `packagedPatches` 记录，不应将改动后的分发副本称为未经修改的上游 JavaScript。

本项目另为 SDK 加载器添加了窄范围 OPFS 句柄兼容：运行日志轮转时暂时释放锁并在原句柄编号重开；可重建的 `local/allocation.tmp` 延迟到最后句柄关闭后删除。原始与修改后哈希、范围见 [OPFS 兼容修改记录](../game/engine/OPFS日志兼容修改.json)，实现见 [兼容模块](../game/engine/opfs-log-handles.mjs)。数据库 CLOG、SST 及两个 Wasm 二进制保持原有行为与字节。

### NOTICE 的来源与版本边界

[game/engine/NOTICE](../game/engine/NOTICE) 按上游 **v1.4.0** 源码树原字节保存，包含 libev、http_parser、lz4、snappy、zlib、zstd 的归属及许可声明。

- [官方标签 API](https://api.github.com/repos/oceanbase/seekdb/git/ref/tags/v1.4.0)确认 v1.4.0 指向 commit `de5be277d4398b0cad018a666a54be0d99470543`。
- [固定 commit 的 NOTICE 原文](https://raw.githubusercontent.com/oceanbase/seekdb/de5be277d4398b0cad018a666a54be0d99470543/NOTICE)与 [v1.4.0 标签原文](https://raw.githubusercontent.com/oceanbase/seekdb/v1.4.0/NOTICE)逐字节一致。
- 保存文件为 11,071 字节，SHA-256 为 `c753aec56c61055ae25ca41d71984674b1f32d2e1c745efbbaa5bdbaf3ab2a0b`。

2026-11-12 核查时，同一 Shell 发布目录的 `engine/NOTICE`、`NOTICE` 与 `manifest.json` 地址均返回 HTTP 404。**尚未取得该 Shell 发布 ID 与上游源码 commit 精确对应的构建记录，也未取得 Wasm 的完整链接依赖清单。** 因此，这份 NOTICE 用于保留已取得的上游归属，不代表已经证实其列尽两套 Wasm 的全部依赖，不能当作二进制 SBOM。

完整可复核地址、哈希和上述边界见 [公开第三方来源记录](../game/engine/public-third-party.json)。

## Fusion Pixel Font

界面使用 [Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font) 的 12 像素等宽简体中文 WOFF2 字体，来源为官方 2026.11.10 发行包。

- 字体文件：[game/assets/fusion-pixel-12px.woff2](../game/assets/fusion-pixel-12px.woff2)。
- 许可：[SIL Open Font License 1.1 原文及版权声明](../game/assets/字体许可证.txt)。
- [本地来源记录](../game/assets/字体来源.json)保留官方发行地址；[上游许可](https://raw.githubusercontent.com/TakWolf/fusion-pixel-font/master/LICENSE-OFL)可在线查看。

字体继续适用 OFL-1.1；该许可不会自动扩展到使用字体展示的原创游戏代码或文案。此前试用的 Noto 标题字体未进入本次公开运行文件。

## Go 运行时与原生启动器

Mac 与 Windows 离线包带有用 Go 编译的本机 HTTP 启动器。Go 运行时等 Go 项目组件保留 The Go Authors 的版权及 BSD-3-Clause 条款，原文见 [game/离线启动器/LICENSE-Go.txt](../game/离线启动器/LICENSE-Go.txt)及 [Go 官方许可](https://go.dev/LICENSE)。

这份 Go 许可针对对应第三方组件，不表示本项目的 `main.go` 或其他原创源码已选择 BSD 许可证。发行 HTML 内保留对应第三方许可文本，源码仓库同时保留独立原文文件。

## seekdb Logo 与商标

[seekdb Logo PNG](../game/assets/branding/seekdb-logo.png)由项目作者提供；仓库保留提供时的原始 PNG 字节，界面的低分辨率像素呈现由代码完成。

seekdb、OceanBase 的名称、Logo 与相关商标归各自权利人。本说明记录素材来源，不为品牌或商标授予额外使用许可，也不把 Logo 纳入原创代码许可或字体许可。

## 未纳入公开仓库和离线包的研究材料

本次运行文件不依赖以下材料，公开范围排除了：

- 商业游戏 ROM、装有 ROM 的 ZIP、反汇编、模拟器与模拟器状态。
- 原作截图、录屏、音频、手册，以及包含这些素材的研究目录。
- 内部 PPT、内部文档链接、研究笔记、个人工作路径与历史测试输出。
- 未使用的旧标题字体素材、旧版试玩 HTML 与旧版发行包。

公开说明中的游戏截图选自本项目实际界面。上述排除项用于说明本次分发范围，不为原作或未分发材料另作许可判断。
