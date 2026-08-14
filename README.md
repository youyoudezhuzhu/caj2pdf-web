# CAJ 转 PDF — 纯浏览器转换器

![license](https://img.shields.io/badge/license-AGPL--3.0-blue)
![platform](https://img.shields.io/badge/platform-Web-lightgrey)

**免费的在线 CAJ/KDH 转 PDF 工具。纯浏览器端转换，文件不出设备，隐私安全，无需上传服务器。**

🌐 **在线使用**: [https://youyoudezhuzhu.github.io/caj2pdf-web/](https://youyoudezhuzhu.github.io/caj2pdf-web/)

## ✨ 特性

- 🔒 **隐私安全** — 转换完全在浏览器本地完成（WebAssembly），文件不上传任何服务器
- ⚡ **无限大小** — 无文件大小限制，取决于设备内存
- 📚 **保留内容** — 转换后文字可复制，目录结构保留
- 🌍 **全平台** — Windows / Mac / Linux / Android / iPhone 浏览器均可使用
- 📥 **批量转换** — 支持拖拽多个文件批量处理

## 🎯 支持格式

| 格式 | 支持 | 说明 |
|------|------|------|
| CAJ | ✅ | 知网期刊/硕博论文（最常见，内部嵌入 PDF）|
| KDH | ❌ | 需知网官方"全球学术快报"软件 |

> HN / C8 / NH 格式暂不支持（需额外 jbig2 解码器，后续可扩展）。

## 🚀 本地运行

无需构建，直接用静态服务器打开：

```bash
cd caj2pdf-web
python3 -m http.server 8000
# 浏览器访问 http://localhost:8000
```

或直接双击 `index.html`（部分浏览器限制 file:// 下 wasm 加载，推荐用 http 方式）。

## 🛠 技术原理

1. **CAJ 解析**（纯 JS）：解析 CAJ 容器格式，提取内部嵌入的 PDF 数据
   - 偏移 `0x14` 处读取 PDF 起始指针
   - 提取从 PDF 数据开始到最后一个 `endobj` 的完整数据体
   - 补 `%PDF` 文件头、修复缺失的 Catalog/Pages 对象、加 `%%EOF` 标记
2. **PDF 修复**（MuPDF.js / WebAssembly）：用 Artifex 的 MuPDF 引擎重建 xref 表、清理压缩
   - `Document.openDocument()` 自动容错修复损坏的交叉引用表
   - `saveToBuffer('compress,garbage=deduplicate')` 输出干净 PDF

## 📁 项目结构

```
caj2pdf-web/
├── index.html          # 单页应用（拖拽上传 + 转换 + 下载）
├── js/
│   ├── caj-parser.js   # CAJ 格式解析器（纯 JS，移植自 caj2pdf-wasm）
│   └── pdf-fixer.js    # MuPDF.js 修复封装
├── lib/
│   ├── mupdf.js        # MuPDF.js（官方 wasm 绑定）
│   ├── mupdf-wasm.js   # wasm 加载器
│   └── mupdf-wasm.wasm # MuPDF 引擎（10MB）
├── test-parser.mjs     # 解析器测试
├── test-mupdf.mjs      # mupdf 修复测试
└── test-verify.mjs     # 最终 PDF 验证测试
```

## 📖 致谢

- [MuPDF.js](https://mupdf.com) — PDF 引擎（AGPL-3.0）
- [caj2pdf](https://github.com/caj2pdf/caj2pdf) — CAJ 解析参考
- [caj2pdf-wasm](https://github.com/qgjyf2001/caj2pdf-wasm) — Go wasm 解析参考
- [caj2pdf-2025](https://github.com/maguang/caj2pdf-2025) — 工作流脚本参考

## 📄 许可证

[AGPL-3.0](LICENSE)（因使用 MuPDF.js）
