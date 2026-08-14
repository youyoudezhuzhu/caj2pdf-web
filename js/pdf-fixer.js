/**
 * pdf-fixer.js — 用 MuPDF.js 修复/清理 PDF
 *
 * mupdf 是 Artifex 的 PDF 引擎（AGPL 协议），编译为 wasm。
 * 它内部有完整的 PDF 修复引擎，能自动重建损坏的 xref 表，
 * 与 Python 版 caj2pdf 的 mutool clean 方案等效。
 */

let mupdfModule = null;

/**
 * 动态加载 mupdf（ESM，浏览器端）
 * @returns {Promise<object>} mupdf 模块
 */
export async function loadMupdf() {
  if (mupdfModule) return mupdfModule;
  const mod = await import('./lib/mupdf.js');
  mupdfModule = mod.default;
  return mupdfModule;
}

/**
 * 用 mupdf 打开 PDF（自动修复 xref）并重新保存为干净 PDF
 * @param {Uint8Array} pdfBytes 输入的（可能损坏的）PDF
 * @returns {Uint8Array} 修复后的干净 PDF
 */
export function cleanPDF(pdfBytes) {
  if (!mupdfModule) {
    throw new Error('mupdf 未加载');
  }
  const mupdf = mupdfModule;

  try {
    // 打开 PDF（mupdf 自动容错重建 xref）
    const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');

    // 获取页数（验证文档有效）
    const pageCount = doc.countPages();
    if (pageCount <= 0) {
      doc.destroy();
      throw new Error('PDF 页数为 0，文档无效');
    }

    // 清理并保存：压缩 + 去除多余数据
    // saveToBuffer(options) 支持 "clean","garbage=deduplicate","compress"
    const buf = doc.saveToBuffer('compress,garbage=deduplicate');
    const cleanBytes = buf.asUint8Array();
    doc.destroy();

    return cleanBytes;
  } catch (e) {
    if (e && e.message && e.message.includes('Failed to recognise image format')) {
      throw new Error('PDF 数据损坏严重，mupdf 无法修复：' + e.message);
    }
    throw e;
  }
}

/**
 * 完整转换：CAJ → PDF
 * @param {Uint8Array} cajBytes CAJ 文件原始字节
 * @returns {{pdf: Uint8Array, pageCount: number}} 转换结果
 */
export function convertCAJtoPDF(cajBytes) {
  if (!mupdfModule) {
    throw new Error('mupdf 未加载');
  }
  const mupdf = mupdfModule;

  try {
    const doc = mupdf.Document.openDocument(cajBytes, 'application/pdf');
    const pageCount = doc.countPages();
    const buf = doc.saveToBuffer('compress,garbage=deduplicate');
    const pdfBytes = buf.asUint8Array();
    doc.destroy();
    return { pdf: pdfBytes, pageCount };
  } catch (e) {
    throw new Error('转换失败：' + (e.message || e));
  }
}
