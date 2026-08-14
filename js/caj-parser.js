/**
 * caj-parser.js — CAJ 格式解析器（纯 JS）
 *
 * 移植自 caj2pdf-wasm 的 Go 实现（qgjyf2001/caj2pdf-wasm，MIT 兼容）与
 * caj2pdf/caj2pdf 的 Python 实现（maguang/caj2pdf-2025）。
 *
 * CAJ 文件结构（提取嵌入 PDF）：
 *   1. 偏移 0x10 处 4 字节（little-endian）→ pdf_start_pointer（跳转地址）
 *   2. 跳转到 pdf_start_pointer 处读 4 字节 → pdf_start_value（PDF 数据实际开始）
 *   3. 从 pdf_start_value 到最后一个 "endobj"+6 → PDF 数据体
 *   4. 补 %PDF 头 + 处理乱序/缺失的 Catalog、Pages 对象
 */

const CAJ_TOC_NUMBER_OFFSET = 0x110;

/**
 * 在 Uint8Array 中查找子串（支持跨 chunk 匹配）
 */
function findBytes(haystack, needle, fromOffset = 0) {
  if (needle.length === 0) return -1;
  outer: for (let i = fromOffset; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * 查找所有匹配位置
 */
function findAllOccurrences(haystack, needle) {
  const positions = [];
  let from = 0;
  while (true) {
    const idx = findBytes(haystack, needle, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + 1;
  }
  return positions;
}

/**
 * 读取 little-endian uint32
 */
function readUint32LE(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

/**
 * 读取文件头判断类型
 * 返回: 'caj' | 'hn' | 'unknown'
 */
export function detectType(bytes) {
  // CAJ 头特征：偏移 0x10 处有 PDF 指针
  if (bytes.length < 0x20) return 'unknown';
  const pdfStartPointer = readUint32LE(bytes, 0x14);
  if (pdfStartPointer > 0 && pdfStartPointer < bytes.length) {
    return 'caj';
  }
  return 'unknown';
}

/**
 * 从 CAJ 中提取嵌入的 PDF 原始字节
 * @param {Uint8Array} cajBytes
 * @returns {Uint8Array} 提取出的（可能损坏的）PDF 数据
 */
export function extractPDF(cajBytes) {
  // 1. 偏移 0x10+4 = 0x14 读 4 字节 → pdfStartPointer
  const pdfStartPointer = readUint32LE(cajBytes, 0x14);

  // 2. 跳转到 pdfStartPointer 读 4 字节 → pdfStartValue
  if (pdfStartPointer >= cajBytes.length) {
    throw new Error('CAJ 文件结构异常：PDF 起始指针越界');
  }
  const pdfStartValue = readUint32LE(cajBytes, pdfStartPointer);

  // 3. 找最后一个 "endobj" → PDF 结束位置
  const endObj = new TextEncoder().encode('endobj');
  const occurrences = findAllOccurrences(cajBytes, endObj);
  if (occurrences.length === 0) {
    throw new Error('CAJ 文件结构异常：未找到 endobj 标记');
  }
  const pdfEnd = occurrences[occurrences.length - 1] + 6;

  // 4. 提取 PDF 数据（从 pdfStartValue 到 pdfEnd）
  if (pdfStartValue >= pdfEnd || pdfStartValue >= cajBytes.length) {
    throw new Error('CAJ 文件结构异常：PDF 数据范围无效');
  }
  const pdfBody = cajBytes.slice(pdfStartValue, pdfEnd);

  // 5. 组装 PDF：加 %PDF 头 + 数据体
  const header = new TextEncoder().encode('%PDF-1.3\r\n');
  const result = new Uint8Array(header.length + pdfBody.length + 2);
  result.set(header, 0);
  result.set(pdfBody, header.length);
  result.set(new TextEncoder().encode('\r\n'), header.length + pdfBody.length);
  return result;
}

/**
 * 处理乱序对象：返回所有 "N 0 obj" 的编号列表（去重）
 */
function dealDisordered(pdfBytes) {
  const objNos = new Set();
  const objPattern = /\r?(\d+) 0 obj/g;
  // 转成文本查找（仅用于识别对象编号）
  const text = new TextDecoder('latin1').decode(pdfBytes);
  let m;
  while ((m = objPattern.exec(text)) !== null) {
    objNos.add(parseInt(m[1], 10));
  }
  return Array.from(objNos);
}

/**
 * 查找 "N 0 obj" 在字节数组中的位置
 */
function findObjectOffset(pdfBytes, objNo) {
  const needle = new TextEncoder().encode(`\r${objNo} 0 obj`);
  // 也尝试无 \r 前缀
  const idx = findBytes(pdfBytes, needle);
  if (idx !== -1) return idx;
  const needle2 = new TextEncoder().encode(`${objNo} 0 obj`);
  return findBytes(pdfBytes, needle2);
}

/**
 * 解析所有 "N 0 obj ... endobj" 段，找出其引用的对象
 * 返回 Map: objNo -> Set(被引用对象号)
 */
function parseObjectRefs(pdfBytes) {
  const text = new TextDecoder('latin1').decode(pdfBytes);
  const objRegex = /(\d+) 0 obj([\s\S]*?)endobj/g;
  const refs = new Map();
  let m;
  while ((m = objRegex.exec(text)) !== null) {
    const objNo = parseInt(m[1], 10);
    const body = m[2];
    const refSet = new Set();
    const refRegex = /(\d+) 0 R/g;
    let r;
    while ((r = refRegex.exec(body)) !== null) {
      refSet.add(parseInt(r[1], 10));
    }
    refs.set(objNo, refSet);
  }
  return refs;
}

/**
 * 判断对象是否为 Pages 对象（含 /Type /Pages）
 */
function isPagesObject(pdfBytes, objNo) {
  const idx = findObjectOffset(pdfBytes, objNo);
  if (idx === -1) return false;
  // 从对象开始找 endobj
  const endIdx = findBytes(pdfBytes, new TextEncoder().encode('endobj'), idx);
  if (endIdx === -1) return false;
  const seg = new TextDecoder('latin1').decode(pdfBytes.slice(idx, endIdx));
  return /\/Type\s*\/Pages/.test(seg);
}

/**
 * 寻找可用的未使用对象号
 */
function findUnusedNo(used, avoid) {
  const usedSet = new Set([...used, ...avoid]);
  let candidate = 1;
  while (usedSet.has(candidate)) candidate++;
  return candidate;
}

/**
 * 修复提取出的 PDF：补 Catalog/Pages 对象、加 EOF 标记
 * @param {Uint8Array} pdfBytes 提取的 PDF（可能损坏）
 * @returns {Uint8Array} 修复后的 PDF
 */
export function fixPDF(pdfBytes) {
  const objNos = dealDisordered(pdfBytes);
  const refs = parseObjectRefs(pdfBytes);

  // 找出所有 Pages 对象（被引用但未定义的，或定义的 Pages）
  // 简化策略：找所有被 /Type /Pages 定义的对象
  const text = new TextDecoder('latin1').decode(pdfBytes);
  const definedObjects = new Set(objNos);

  // 找缺失的引用（被其他对象引用但未定义的对象号）——这些可能是 Catalog/Pages
  const referenced = new Set();
  for (const refSet of refs.values()) {
    for (const r of refSet) referenced.add(r);
  }
  const missing = [];
  for (const r of referenced) {
    if (!definedObjects.has(r)) missing.push(r);
  }

  // 找已定义的 Pages 对象
  const pagesObjs = [];
  for (const objNo of objNos) {
    if (isPagesObject(pdfBytes, objNo)) pagesObjs.push(objNo);
  }

  // 构造 Catalog（如果缺失）
  let catalogObjNo = -1;
  let rootPagesObjNo = -1;

  // 已定义对象中找 Catalog
  const catalogObjNos = [];
  for (const objNo of objNos) {
    const idx = findObjectOffset(pdfBytes, objNo);
    if (idx === -1) continue;
    const endIdx = findBytes(pdfBytes, new TextEncoder().encode('endobj'), idx);
    if (endIdx === -1) continue;
    const seg = new TextDecoder('latin1').decode(pdfBytes.slice(idx, endIdx));
    if (/\/Type\s*\/Catalog/.test(seg)) catalogObjNos.push(objNo);
  }

  // 如果 Catalog 缺失：新建
  if (catalogObjNos.length === 0) {
    // 找到根 Pages（不含 Parent 的 Pages）
    let rootPages = -1;
    for (const p of pagesObjs) {
      const idx = findObjectOffset(pdfBytes, p);
      if (idx === -1) continue;
      const endIdx = findBytes(pdfBytes, new TextEncoder().encode('endobj'), idx);
      if (endIdx === -1) continue;
      const seg = new TextDecoder('latin1').decode(pdfBytes.slice(idx, endIdx));
      if (!/\/Parent\s+\d+\s+0\s+R/.test(seg)) {
        rootPages = p;
        break;
      }
    }
    if (rootPages === -1 && pagesObjs.length > 0) {
      rootPages = pagesObjs[0];
    }
    if (rootPages === -1) {
      // 极端情况：没有任何 Pages 对象——交给 mupdf 修复
      return pdfBytes;
    }
    rootPagesObjNo = rootPages;
    catalogObjNo = findUnusedNo(objNos, missing);
    const catalog = new TextEncoder().encode(
      `\r${catalogObjNo} 0 obj\r<</Type /Catalog\r/Pages ${rootPages} 0 R\r>>\rendobj\r`
    );
    const result = new Uint8Array(pdfBytes.length + catalog.length);
    result.set(pdfBytes, 0);
    result.set(catalog, pdfBytes.length);
    pdfBytes = result;
  }

  // 确保 EOF 标记存在
  const eofMark = new TextEncoder().encode('%%EOF');
  const hasEOF = findBytes(pdfBytes, eofMark) !== -1;
  if (!hasEOF) {
    const eof = new TextEncoder().encode('\r%%EOF\r');
    const result = new Uint8Array(pdfBytes.length + eof.length);
    result.set(pdfBytes, 0);
    result.set(eof, pdfBytes.length);
    pdfBytes = result;
  }

  return pdfBytes;
}

/**
 * 提取 CAJ 的书签目录（TOC）
 * 简化实现：CAJ TOC 数据位于偏移 0x110 附近的偏移表
 */
export function extractTOC(cajBytes) {
  try {
    const offset = readUint32LE(cajBytes, CAJ_TOC_NUMBER_OFFSET);
    if (offset <= 0 || offset >= cajBytes.length) return [];
    // TOC 结构复杂，返回空列表让上层跳过（正文转换不受影响）
    return [];
  } catch (e) {
    return [];
  }
}
