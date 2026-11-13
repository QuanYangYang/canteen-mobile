/* 生成修改后的送货单，并解析回传包中的修改后送货单。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vendor/xlsx.bundle.js'));
  } else {
    root.CanteenWorkbook = factory(root.XLSX);
  }
})(typeof self !== 'undefined' ? self : this, function (XLSX) {
  'use strict';

  const HEADERS = ['序号', '编号', '品名及规格', '订购数', '单位', '实送数', '单价', '金额（元）', '备注', '收货备注', '缺送'];
  const META_SHEET = '收货信息';
  const NOTE_SHEET = '送货单';

  function text(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\u00a0/g, ' ').trim();
  }

  function num(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number') return Number.isFinite(value) ? value : '';
    const raw = String(value).replace(/[,，￥¥\s元]/g, '');
    const n = Number(raw);
    return Number.isFinite(n) ? n : '';
  }

  function border() {
    const side = { style: 'thin', color: { rgb: 'FF000000' } };
    return { top: side, bottom: side, left: side, right: side };
  }

  function style(opts) {
    const s = {
      font: { name: '宋体', sz: 10, ...(opts.bold ? { bold: true } : {}) },
      alignment: { vertical: 'center', horizontal: opts.align || 'center', wrapText: true },
      border: border(),
    };
    if (opts.fill) s.fill = { patternType: 'solid', fgColor: { rgb: opts.fill } };
    return s;
  }

  function buildWorkbook(task, items, photoCount) {
    const sorted = items.slice().sort((a, b) => Number(a.lineNo) - Number(b.lineNo));
    const wb = XLSX.utils.book_new();
    const aoa = [];
    aoa.push([text(task.company)]);
    aoa.push(HEADERS);
    for (const item of sorted) {
      aoa.push([
        String(item.lineNo),
        text(item.code),
        text(item.name),
        num(item.qtyOrdered),
        text(item.unit),
        num(item.qtyReceived),
        num(item.price),
        num(item.amount),
        text(item.remark),
        text(item.receiveRemark),
        item.short ? '是' : '否',
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: HEADERS.length - 1 } }];
    ws['!cols'] = [
      { wch: 6 }, { wch: 10 }, { wch: 28 }, { wch: 8 }, { wch: 6 },
      { wch: 8 }, { wch: 8 }, { wch: 11 }, { wch: 14 }, { wch: 20 }, { wch: 6 },
    ];
    ws['!rows'] = [{ hpt: 26 }, { hpt: 30 }];
    for (let r = 0; r < aoa.length; r++) {
      for (let c = 0; c < HEADERS.length; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr] || (ws[addr] = { t: 's', v: '' });
        if (r === 0) {
          cell.s = {
            font: { name: '宋体', sz: 15, bold: true },
            alignment: { horizontal: 'center', vertical: 'center' },
          };
          continue;
        }
        if (r === 1) {
          cell.s = style({ bold: true, fill: 'FFE8F0EA' });
          continue;
        }
        const align = (c === 2 || c === 8 || c === 9) ? 'left' : 'center';
        cell.s = style({ align, bold: c === 10 && cell.v === '是' });
      }
    }
    const lastRow = aoa.length;
    ws['!ref'] = `A1:K${lastRow}`;
    XLSX.utils.book_append_sheet(wb, ws, NOTE_SHEET);

    const meta = [
      ['字段', '值'],
      ['包版本', '1'],
      ['任务ID', text(task.id)],
      ['地点码', text(task.locationCode)],
      ['地点名称', text(task.locationName)],
      ['操作员', text(task.operator)],
      ['单据编号', text(task.noteNo)],
      ['送货日期', text(task.date)],
      ['客户', text(task.customer)],
      ['公司名称', text(task.company)],
      ['收货开始时间', text(task.startedAt)],
      ['提交时间', text(task.submittedAt)],
      ['验收确认时间', text(task.confirmedAt)],
      ['照片总数', String(photoCount || 0)],
      ['缺送项数', String(sorted.filter((i) => i.short).length)],
      ['源文件SHA256', text(task.sourceHash)],
    ];
    const ms = XLSX.utils.aoa_to_sheet(meta);
    ms['!cols'] = [{ wch: 18 }, { wch: 60 }];
    for (let r = 0; r < meta.length; r++) {
      for (let c = 0; c < 2; c++) {
        const cell = ms[XLSX.utils.encode_cell({ r, c })];
        if (cell) cell.s = style({ align: 'left', bold: r === 0 });
      }
    }
    XLSX.utils.book_append_sheet(wb, ms, META_SHEET);
    return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  }

  function metaMap(rows) {
    const map = {};
    for (const row of rows || []) {
      const key = text(row[0]);
      if (!key || key === '字段') continue;
      map[key] = text(row[1]);
    }
    return map;
  }

  function parseModifiedWorkbook(input) {
    let wb;
    try {
      wb = XLSX.read(input, { type: typeof input === 'string' ? 'binary' : 'array', cellDates: false, raw: true });
    } catch (err) {
      const e = new Error('无法读取修改后的送货单。');
      e.code = 'BAD_WORKBOOK';
      throw e;
    }
    const noteName = wb.SheetNames.includes(NOTE_SHEET) ? NOTE_SHEET : wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[noteName], { header: 1, defval: '', raw: true });
    let headerIndex = -1;
    let map = null;
    for (let i = 0; i < rows.length; i++) {
      const cells = (rows[i] || []).map(text);
      const line = cells.indexOf('序号');
      const name = cells.findIndex((v) => v === '品名及规格' || v === '品名');
      if (line >= 0 && name >= 0) {
        headerIndex = i;
        map = {
          line,
          code: cells.indexOf('编号'),
          name,
          ordered: cells.indexOf('订购数'),
          unit: cells.indexOf('单位'),
          received: cells.indexOf('实送数'),
          price: cells.indexOf('单价'),
          amount: cells.findIndex((v) => v.startsWith('金额')),
          remark: cells.indexOf('备注'),
          receiveRemark: cells.indexOf('收货备注'),
          short: cells.indexOf('缺送'),
        };
        break;
      }
    }
    if (headerIndex < 0) {
      const e = new Error('修改后的送货单缺少货品表头。');
      e.code = 'BAD_TABLE';
      throw e;
    }
    const company = text((rows[0] || [])[0]);
    const items = [];
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const lineNo = text(row[map.line]);
      if (!lineNo || !/^\d+$/.test(lineNo)) continue;
      const name = text(row[map.name]);
      if (!name) continue;
      const qtyReceived = map.received >= 0 ? num(row[map.received]) : '';
      const price = map.price >= 0 ? num(row[map.price]) : '';
      const amount = map.amount >= 0 ? num(row[map.amount]) : '';
      const short = map.short >= 0 && text(row[map.short]) === '是';
      const auto = Math.round((Number(qtyReceived || 0) * Number(price || 0) + Number.EPSILON) * 100) / 100;
      items.push({
        lineNo,
        lineKey: String(Number(lineNo)),
        code: map.code >= 0 ? text(row[map.code]) : '',
        name,
        qtyOrdered: map.ordered >= 0 ? num(row[map.ordered]) : '',
        unit: map.unit >= 0 ? text(row[map.unit]) : '',
        qtyReceived: qtyReceived === '' ? 0 : Number(qtyReceived),
        price: price === '' ? 0 : Number(price),
        amount: amount === '' ? auto : Number(amount),
        amountManual: amount !== '' && Math.abs(Number(amount) - auto) > 0.005,
        remark: map.remark >= 0 ? text(row[map.remark]) : '',
        receiveRemark: map.receiveRemark >= 0 ? text(row[map.receiveRemark]) : '',
        short,
        done: short,
      });
    }
    if (!items.length) {
      const e = new Error('修改后的送货单没有货品行。');
      e.code = 'NO_ITEMS';
      throw e;
    }
    const metaRows = wb.Sheets[META_SHEET]
      ? XLSX.utils.sheet_to_json(wb.Sheets[META_SHEET], { header: 1, defval: '', raw: true })
      : [];
    const meta = metaMap(metaRows);
    if (!meta['单据编号'] && !meta['任务ID']) {
      const e = new Error('回传包缺少收货信息，无法恢复。');
      e.code = 'NO_METADATA';
      throw e;
    }
    const task = {
      id: meta['任务ID'] || '',
      company: company || meta['公司名称'] || '',
      noteNo: meta['单据编号'] || '',
      date: meta['送货日期'] || '',
      customer: meta['客户'] || '',
      locationCode: meta['地点码'] || '',
      locationName: meta['地点名称'] || '',
      operator: meta['操作员'] || '',
      startedAt: meta['收货开始时间'] || '',
      submittedAt: meta['提交时间'] || '',
      confirmedAt: meta['验收确认时间'] || '',
      sourceHash: meta['源文件SHA256'] || '',
      status: 'draft',
    };
    if (!task.company) {
      const e = new Error('修改后的送货单缺少公司名称。');
      e.code = 'NO_COMPANY';
      throw e;
    }
    return { task, items, meta };
  }

  return {
    HEADERS,
    buildWorkbook,
    parseModifiedWorkbook,
    _internals: { text, num, style },
  };
});
