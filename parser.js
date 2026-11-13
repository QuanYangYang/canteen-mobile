/* 送货单解析：只接受一张送货单（可多页）；多单直接拒绝。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vendor/xlsx.bundle.js'));
  } else {
    root.CanteenParser = factory(root.XLSX);
  }
})(typeof self !== 'undefined' ? self : this, function (XLSX) {
  'use strict';

  const NOTE_RE = /单据编号\s*[:：]\s*([^\s]+)/;
  const DATE_RE = /送货日期\s*[:：]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/;
  const STOP_RE = /本页小计|总金额|说明\s*[:：]|送货单位\s*[:：]|主配送员工号|收货人签字/;

  function text(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const raw = String(value).replace(/[,，￥¥\s元]/g, '');
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function ParseError(code, message, details) {
    const err = new Error(message);
    err.name = 'ParseError';
    err.code = code;
    err.details = details || null;
    return err;
  }

  function headerMap(row) {
    const cells = row.map(text);
    const line = cells.findIndex((v) => v === '序号');
    const name = cells.findIndex((v) => v === '品名及规格' || v === '品名');
    if (line < 0 || name < 0) return null;
    const find = (...names) => cells.findIndex((v) => names.includes(v));
    return {
      line,
      code: find('编号'),
      name,
      ordered: find('订购数', '订购数量'),
      unit: find('单位'),
      received: find('实送数', '实收数', '收货数'),
      price: find('单价'),
      amount: cells.findIndex((v) => v.startsWith('金额')),
      remark: find('备注'),
    };
  }

  function readContext(rows, headerIndex) {
    const start = Math.max(0, headerIndex - 10);
    let noteNo = '';
    let date = '';
    let customer = '';
    let company = '';
    for (let i = start; i < headerIndex; i++) {
      const row = rows[i] || [];
      const joined = row.map(text).join(' ');
      if (!noteNo) {
        const m = joined.match(NOTE_RE);
        if (m) noteNo = m[1];
      }
      if (!date) {
        const m = joined.match(DATE_RE);
        if (m) date = m[1].replace(/\//g, '-');
      }
      if (!company) {
        for (const v of row.map(text)) {
          if (v && /公司$/.test(v) && !/送货单位|收货单位/.test(v)) {
            company = v;
            break;
          }
        }
      }
      for (let c = 0; c < row.length; c++) {
        if (text(row[c]) === '客户名称') {
          for (let k = c + 1; k < row.length; k++) {
            if (text(row[k])) { customer = text(row[k]); break; }
          }
        }
      }
    }
    return { noteNo, date, customer, company };
  }

  function parseItem(row, map) {
    const lineNo = text(row[map.line]);
    if (!lineNo || !/^\d+$/.test(lineNo)) return null;
    const name = map.name >= 0 ? text(row[map.name]) : '';
    if (!name) return null;
    const code = map.code >= 0 ? text(row[map.code]) : '';
    const unit = map.unit >= 0 ? text(row[map.unit]) : '';
    const qtyOrdered = map.ordered >= 0 ? numberOrNull(row[map.ordered]) : null;
    const qtyReceivedRaw = map.received >= 0 ? numberOrNull(row[map.received]) : null;
    const qtyReceived = qtyReceivedRaw === null ? (qtyOrdered === null ? 0 : qtyOrdered) : qtyReceivedRaw;
    const price = map.price >= 0 ? numberOrNull(row[map.price]) : null;
    const amountRaw = map.amount >= 0 ? numberOrNull(row[map.amount]) : null;
    const amount = amountRaw === null ? round2(qtyReceived * (price || 0)) : amountRaw;
    const remark = map.remark >= 0 ? text(row[map.remark]) : '';
    return {
      lineNo,
      lineKey: String(Number(lineNo)),
      code,
      name,
      qtyOrdered: qtyOrdered === null ? '' : qtyOrdered,
      unit,
      qtyReceived,
      price: price === null ? '' : price,
      amount,
      remark,
    };
  }

  function parseWorkbook(input, fileName) {
    let wb;
    try {
      wb = XLSX.read(input, {
        type: typeof input === 'string' ? 'binary' : 'array',
        cellDates: false,
        raw: true,
      });
    } catch (err) {
      throw ParseError('BAD_FILE', '无法读取送货单文件，请确认是 Excel 文件。', { cause: String(err && err.message || err) });
    }

    const pages = [];
    const sheets = wb.SheetNames || [];
    for (const sheetName of sheets) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
      for (let i = 0; i < rows.length; i++) {
        const map = headerMap(rows[i] || []);
        if (!map) continue;
        const ctx = readContext(rows, i);
        const items = [];
        for (let j = i + 1; j < rows.length; j++) {
          const row = rows[j] || [];
          if (headerMap(row)) break;
          const joined = row.map(text).join(' ');
          if (STOP_RE.test(joined)) break;
          const item = parseItem(row, map);
          if (item) items.push(item);
        }
        if (items.length) {
          pages.push({
            noteNo: ctx.noteNo,
            date: ctx.date,
            customer: ctx.customer,
            company: ctx.company,
            sheetName,
            items,
          });
        }
        i += items.length;
      }
    }

    if (!pages.length) throw ParseError('NO_ITEMS', '没有找到货品行，请确认送货单格式。');
    const groups = new Map();
    for (const page of pages) {
      if (!page.noteNo) throw ParseError('NO_NOTE', '没有找到单据编号，请确认是送货单文件。');
      if (!groups.has(page.noteNo)) groups.set(page.noteNo, []);
      groups.get(page.noteNo).push(page);
    }
    if (groups.size > 1) {
      throw ParseError('MULTI_NOTE', '此文件包含多张送货单，请只保留当天一张（可多页）后再导入。', {
        noteIds: Array.from(groups.keys()),
      });
    }

    const noteNo = Array.from(groups.keys())[0];
    const notePages = groups.get(noteNo);
    const first = notePages[0];
    const company = notePages.map((p) => p.company).find(Boolean) || '';
    if (!company) throw ParseError('NO_COMPANY', '没有找到公司名称，请确认送货单表头。');

    const seen = new Set();
    const items = [];
    for (const page of notePages) {
      for (const item of page.items) {
        if (seen.has(item.lineKey)) {
          throw ParseError('DUPLICATE_LINE', `序号 ${item.lineNo} 重复，请检查送货单。`, { lineNo: item.lineNo });
        }
        seen.add(item.lineKey);
        items.push(item);
      }
    }
    if (!items.length) throw ParseError('NO_ITEMS', '送货单没有有效货品行。');

    return {
      fileName: fileName || '',
      noteNo,
      date: notePages.map((p) => p.date).find(Boolean) || '',
      customer: notePages.map((p) => p.customer).find(Boolean) || '',
      company,
      pageCount: notePages.length,
      sheetCount: sheets.length,
      items,
    };
  }

  return {
    parseWorkbook,
    ParseError,
    _internals: { text, numberOrNull, headerMap, readContext, parseItem },
  };
});
