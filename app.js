/* 食堂手机收货端：单任务、拍照、修改送货单、ZIP 导出与回传恢复。 */
(function () {
  'use strict';

  const BRAND_ORG = '武汉大功率机车检修段';
  const BRAND_PRODUCT = '食堂收货管理系统M1';
  const APP_NAME = BRAND_ORG + BRAND_PRODUCT;
  const APP_VERSION = '20261114105506-ae9e0c27';
  const VERSION_URL = 'version.json';
  const DB_NAME = 'canteen_mobile';
  const DB_VERSION = 2;
  const MAX_PHOTOS = 5;
  const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
  const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
  const ZIP_WARN_BYTES = 220 * 1024 * 1024;
  const ZIP_MAX_BYTES = 600 * 1024 * 1024;
  const ZIP_COMPRESS_EDGE = 3000;
  const ZIP_COMPRESS_QUALITY = 0.92;

  const state = {
    task: null,
    items: [],
    photos: [],
    settings: { locationCode: '', operator: '' },
    view: 'home',
    selectedId: null,
    search: '',
    lastZip: null,
    zipName: '',
    urls: [],
    db: null,
    cameraStream: null,
    imageCapture: null,
    photoSelection: new Set(),
    swReg: null,
    swController: false,
    updateChecking: false,
    updateLastCheck: 0,
    updateDismissed: false,
    updateReloading: false,
    updateTimer: null,
  };
  const mem = { kv: {}, photos: [], originals: new Map() };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  function round3(n) { return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000; }
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtNum(value) {
    if (value === '' || value === null || value === undefined) return '';
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : '';
  }
  function nowToken(d) {
    const x = d || new Date();
    return `${x.getFullYear()}${pad2(x.getMonth() + 1)}${pad2(x.getDate())}-${pad2(x.getHours())}${pad2(x.getMinutes())}${pad2(x.getSeconds())}`;
  }
  function nowText(d) {
    const x = d || new Date();
    return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())} ${pad2(x.getHours())}:${pad2(x.getMinutes())}:${pad2(x.getSeconds())}`;
  }
  function tokenFromText(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    return m ? `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}` : nowToken();
  }
  function toast(message, ms) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { el.hidden = true; }, ms || 2400);
  }
  function busy(text) { $('#busy-text').textContent = text || '处理中…'; $('#busy').hidden = false; }
  function unbusy() { $('#busy').hidden = true; }

  /* ---------------- IndexedDB ---------------- */
  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      const waitMs = location.protocol === 'file:' ? 1500 : 8000;
      const timer = setTimeout(() => reject(new Error('indexedDB open timeout')), waitMs);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('originals')) db.createObjectStore('originals', { keyPath: 'id' });
        if (event && event.oldVersion < 2) {
          const photosStore = tx.objectStore('photos');
          const originalsStore = tx.objectStore('originals');
          photosStore.openCursor().onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;
            const photo = cursor.value;
            if (photo.blob) {
              originalsStore.put({ id: photo.id, blob: photo.blob });
              delete photo.blob;
              photo.legacyCompressed = true;
              cursor.update(photo);
            }
            cursor.continue();
          };
        }
      };
      req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
      req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('indexedDB open failed')); };
      req.onblocked = () => { clearTimeout(timer); reject(new Error('indexedDB blocked')); };
    });
  }
  function idbRequest(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(store, mode);
      const os = tx.objectStore(store);
      let result;
      try { result = fn(os); } catch (err) { reject(err); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('idb failed'));
      tx.onabort = () => reject(tx.error || new Error('idb aborted'));
    });
  }
  async function getKV(key) {
    if (!state.db) return mem.kv[key];
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
      req.onerror = () => reject(req.error);
    });
  }
  async function setKV(key, value) {
    mem.kv[key] = value;
    if (!state.db) return;
    await idbRequest('kv', 'readwrite', (os) => os.put({ key, value }));
  }
  async function delKV(key) {
    delete mem.kv[key];
    if (!state.db) return;
    await idbRequest('kv', 'readwrite', (os) => os.delete(key));
  }
  async function allPhotos() {
    if (!state.db) return mem.photos.slice();
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction('photos', 'readonly');
      const req = tx.objectStore('photos').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  async function putPhoto(photo, original) {
    const clean = Object.assign({}, photo);
    if (!original && clean.blob) original = clean.blob;
    delete clean.blob;
    const idx = mem.photos.findIndex((p) => p.id === clean.id);
    if (idx >= 0) mem.photos[idx] = clean; else mem.photos.push(clean);
    if (original) mem.originals.set(clean.id, original);
    if (!state.db) return;
    await new Promise((resolve, reject) => {
      const tx = state.db.transaction(['photos', 'originals'], 'readwrite');
      tx.objectStore('photos').put(clean);
      if (original) tx.objectStore('originals').put({ id: clean.id, blob: original });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('idb photo put failed'));
      tx.onabort = () => reject(tx.error || new Error('idb photo put aborted'));
    });
  }
  async function getOriginal(id) {
    const photo = mem.photos.find((p) => p.id === id) || state.photos.find((p) => p.id === id);
    if (!state.db) return mem.originals.get(id) || (photo && photo.blob) || (photo && photo.thumb) || null;
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(['photos', 'originals'], 'readonly');
      const req = tx.objectStore('originals').get(id);
      const photoReq = tx.objectStore('photos').get(id);
      tx.oncomplete = () => resolve((req.result && req.result.blob) || (photoReq.result && photoReq.result.blob) || (photoReq.result && photoReq.result.thumb) || null);
      tx.onerror = () => reject(tx.error || new Error('idb original read failed'));
      tx.onabort = () => reject(tx.error || new Error('idb original read aborted'));
    });
  }
  async function delPhoto(id) {
    mem.photos = mem.photos.filter((p) => p.id !== id);
    mem.originals.delete(id);
    if (!state.db) return;
    await new Promise((resolve, reject) => {
      const tx = state.db.transaction(['photos', 'originals'], 'readwrite');
      tx.objectStore('photos').delete(id);
      tx.objectStore('originals').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('idb photo delete failed'));
      tx.onabort = () => reject(tx.error || new Error('idb photo delete aborted'));
    });
  }
  async function clearPhotos() {
    mem.photos = [];
    mem.originals.clear();
    if (!state.db) return;
    await new Promise((resolve, reject) => {
      const tx = state.db.transaction(['photos', 'originals'], 'readwrite');
      tx.objectStore('photos').clear();
      tx.objectStore('originals').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('idb photo clear failed'));
      tx.onabort = () => reject(tx.error || new Error('idb photo clear aborted'));
    });
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { persist().catch((err) => console.error(err)); }, 180);
  }
  async function persist() {
    if (!state.task) return;
    await setKV('task', state.task);
    await setKV('items', state.items);
  }

  /* ---------------- Data helpers ---------------- */
  function itemDone(item) {
    return !!(item.short || (item.photoCount || 0) > 0);
  }
  function refreshItem(item) {
    item.done = itemDone(item);
    return item;
  }
  function normalizeLocation(value) {
    const raw = String(value || '').trim().replace(/\s+/g, '');
    if (!raw) return '';
    return /^\d+$/.test(raw) ? (raw.length < 2 ? raw.padStart(2, '0') : raw) : raw.slice(0, 20);
  }
  function settingsReady() {
    return !!(normalizeLocation(state.settings.locationCode) && String(state.settings.operator || '').trim());
  }
  function recalcAmount(item) {
    if (item.short) { item.amount = 0; return; }
    const importedQty = item.importedQty;
    const unchanged = importedQty !== undefined && Math.abs(Number(item.qtyReceived || 0) - Number(importedQty || 0)) < 1e-9;
    item.amount = unchanged
      ? Number(item.importedAmount || 0)
      : round2(Number(item.qtyReceived || 0) * Number(item.price || 0));
  }
  function refreshItemAmounts() {
    for (const item of state.items) {
      if (item.importedQty === undefined) {
        item.importedQty = Number(item.qtyReceived || 0);
        item.importedAmount = Number(item.amount || 0);
      }
      recalcAmount(item);
    }
  }
  function photosFor(itemId) {
    return state.photos.filter((p) => p.itemId === itemId).sort((a, b) => a.order - b.order);
  }
  function allDone() {
    return state.items.length > 0 && state.items.every((i) => itemDone(i));
  }
  function doneCount() {
    return state.items.filter((i) => itemDone(i)).length;
  }
  function shortCount() {
    return state.items.filter((i) => i.short).length;
  }
  function remarkCount() {
    return state.items.filter((i) => (i.receiveRemark || '').trim()).length;
  }
  function getItem(id) { return state.items.find((i) => i.id === id) || null; }
  function sortItems() {
    state.items.sort((a, b) => Number(a.lineNo) - Number(b.lineNo));
  }
  function taskProgress() {
    const total = state.items.length;
    const done = doneCount();
    return { total, done, pct: total ? Math.round(done * 100 / total) : 0 };
  }
  function allPhotosCount() {
    return state.items.reduce((sum, i) => sum + (i.photoCount || 0), 0);
  }
  function makeTask(parsed, fileName, sourceHash) {
    const d = new Date();
    return {
      id: uid(),
      status: 'draft',
      company: parsed.company,
      noteNo: parsed.noteNo,
      date: parsed.date,
      customer: parsed.customer,
      fileName: fileName || parsed.fileName || '',
      sourceHash: sourceHash || '',
      locationCode: state.settings.locationCode || '01',
      locationName: '',
      operator: state.settings.operator || '',
      timeToken: nowToken(d),
      startedAt: nowText(d),
      submittedAt: '',
      confirmedAt: '',
      pageCount: parsed.pageCount || 1,
    };
  }
  function makeItems(parsed, taskId) {
    return parsed.items.map((x) => ({
      id: uid(),
      taskId,
      lineNo: String(x.lineNo),
      lineKey: x.lineKey || String(Number(x.lineNo)),
      code: x.code || '',
      name: x.name || '',
      qtyOrdered: x.qtyOrdered === '' ? '' : Number(x.qtyOrdered),
      unit: x.unit || '',
      qtyReceived: Number(x.qtyReceived || 0),
      price: x.price === '' ? 0 : Number(x.price),
      amount: Number(x.amount || 0),
      importedQty: Number(x.qtyReceived || 0),
      importedAmount: Number(x.amount || 0),
      remark: x.remark || '',
      receiveRemark: '',
      short: false,
      preShortQty: null,
      preShortAmount: null,
      photoCount: 0,
      done: false,
    }));
  }

  /* ---------------- Image ---------------- */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法解码')); };
      img.src = url;
    });
  }
  async function decodeImage(file) {
    try {
      if ('createImageBitmap' in window) {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      }
    } catch (e) { /* fallback */ }
    return loadImage(file);
  }
  async function imageInfo(blob) {
    const img = await decodeImage(blob);
    const width = img.width || img.naturalWidth || 0;
    const height = img.height || img.naturalHeight || 0;
    if (img.close) img.close();
    return { width, height };
  }
  async function compressImage(file) {
    const img = await decodeImage(file);
    const w = img.width || img.naturalWidth;
    const h = img.height || img.naturalHeight;
    if (!w || !h) throw new Error('图片尺寸无效');
    const max = 2000;
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (img.close) img.close();
    let quality = 0.82;
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    while (blob && blob.size > MAX_PHOTO_BYTES && quality > 0.48) {
      quality -= 0.08;
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    }
    if (!blob) throw new Error('图片压缩失败');
    return blob;
  }
  function fileExt(file) {
    const name = String((file && file.name) || '');
    const m = name.match(/\.([a-z0-9]+)$/i);
    return (m ? m[1] : 'jpg').toLowerCase().replace('jpeg', 'jpg');
  }
  function isHeicFile(file) {
    const type = String((file && file.type) || '').toLowerCase();
    const ext = fileExt(file);
    return type.includes('heic') || type.includes('heif') || ext === 'heic' || ext === 'heif';
  }
  async function preparePhoto(file) {
    if (!file) throw new Error('没有选择照片');
    if (file.size > MAX_ORIGINAL_BYTES) throw new Error('单张照片超过 25MB，请先压缩');
    const type = String(file.type || '').toLowerCase();
    if (type && !type.startsWith('image/') && !isHeicFile(file)) throw new Error('不是可识别的图片文件');
    let original = file;
    let heicConverted = false;
    let width = 0;
    let height = 0;
    if (isHeicFile(file)) {
      let img;
      try { img = await decodeImage(file); } catch (err) {
        throw new Error('HEIC 照片无法在此浏览器解码，请在相册中导出为 JPG 后再选');
      }
      width = img.width || img.naturalWidth;
      height = img.height || img.naturalHeight;
      if (!width || !height) throw new Error('HEIC 照片尺寸无效');
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      if (img.close) img.close();
      const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
      if (!jpeg) throw new Error('HEIC 转换失败');
      if (jpeg.size > MAX_ORIGINAL_BYTES) throw new Error('HEIC 转换后超过 25MB，请先压缩');
      const base = String(file.name || 'photo').replace(/\.[^.]+$/, '');
      original = new File([jpeg], `${base}.jpg`, { type: 'image/jpeg' });
      heicConverted = true;
    } else {
      const img = await decodeImage(original);
      width = img.width || img.naturalWidth;
      height = img.height || img.naturalHeight;
      if (img.close) img.close();
    }
    if (!width || !height) throw new Error('图片尺寸无效');
    const thumb = await makeThumb(original);
    const mime = original.type || (fileExt(original) === 'png' ? 'image/png' : 'image/jpeg');
    const ext = fileExt(original);
    return { original, thumb, width, height, mime, ext: ext === 'jpeg' ? 'jpg' : ext, heicConverted };
  }
  async function compressForPackage(blob) {
    const img = await decodeImage(blob);
    const w = img.width || img.naturalWidth;
    const h = img.height || img.naturalHeight;
    if (!w || !h) throw new Error('图片尺寸无效');
    const scale = Math.min(1, ZIP_COMPRESS_EDGE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    if (img.close) img.close();
    let quality = ZIP_COMPRESS_QUALITY;
    let out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    while (out && out.size > MAX_PHOTO_BYTES && quality > 0.72) {
      quality -= 0.04;
      out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    }
    if (!out) throw new Error('高清压缩失败');
    return out;
  }
  async function makeThumb(blob) {
    try {
      const img = await decodeImage(blob);
      const w = img.width || img.naturalWidth;
      const h = img.height || img.naturalHeight;
      const scale = Math.min(1, 360 / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      if (img.close) img.close();
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7));
    } catch (e) {
      return blob;
    }
  }

  /* ---------------- URL cleanup ---------------- */
  function revokeUrls() {
    for (const url of state.urls) URL.revokeObjectURL(url);
    state.urls = [];
  }
  function blobUrl(blob) {
    const url = URL.createObjectURL(blob);
    state.urls.push(url);
    return url;
  }

  /* ---------------- Render shell ---------------- */
  function setHeader(title, sub) {
    const t = $('#top-title');
    const s = $('#top-sub');
    if (t) t.textContent = title;
    if (s) s.textContent = sub || '';
  }
  function render() {
    revokeUrls();
    const view = $('#view');
    $('#back-btn').hidden = state.view === 'home' || state.view === 'setup';
    const loc = $('#top-location-code');
    if (loc) loc.textContent = state.settings.locationCode || '未设置';
    if (state.view === 'setup') renderSetup(view);
    else if (state.view === 'home') renderHome(view);
    else if (state.view === 'list') renderList(view);
    else if (state.view === 'photos') renderPhotos(view);
    else if (state.view === 'export') renderExport(view);
    else { state.view = 'home'; renderHome(view); }
    if (!$('#update-bar')?.hidden && canAutoReload()) scheduleUpdateReload();
  }

  function renderSetup(view) {
    setHeader('收货前设置', '先设置收货地点和验收人员');
    view.innerHTML = `
      <section class="card">
        <h2>收货前设置</h2>
        <p class="muted">地点和验收人员会写入每一条导出的货品记录，也用于照片编号。</p>
        <div class="field">
          <label for="setup-location">收货地点 / 地点码</label>
          <input id="setup-location" maxlength="20" value="${esc(state.settings.locationCode)}" placeholder="如 食堂、065">
        </div>
        <div class="field">
          <label for="setup-operator">验收人员</label>
          <input id="setup-operator" maxlength="30" value="${esc(state.settings.operator)}" placeholder="姓名或工号">
        </div>
        <div class="notice green">两项都必须填写；设置后仍可在右上角修改。</div>
        <button class="btn primary block" data-action="save-setup" style="margin-top:14px">保存并开始</button>
      </section>`;
  }

  function renderHome(view) {
    setHeader(APP_NAME, state.settings.locationCode ? `地点 ${state.settings.locationCode}` : '未设置地点');
    const isFile = location.protocol === 'file:';
    const storageIssue = !state.db && !isFile;
    const t = state.task;
    const p = taskProgress();
    let current = '';
    if (t) {
      const submitted = t.status === 'submitted';
      current = `
        <div class="card">
          <div class="btn-row" style="justify-content:space-between">
            <span class="badge ${submitted ? 'amber' : ''}">${submitted ? '已提交' : '进行中'}</span>
            <span class="muted small mono">${esc(t.noteNo)}</span>
          </div>
          <h2 style="margin-top:10px">${esc(t.company)}</h2>
          <p class="muted">${esc(t.date || '')} · ${esc(t.customer || '')}</p>
          <div class="progress-label"><span>已完成 ${p.done} / ${p.total}</span><span>${p.pct}%</span></div>
          <div class="progress"><i style="width:${p.pct}%"></i></div>
          <div class="stat-row">
            <button class="stat stat-btn" type="button" data-action="all-photos"><b>${allPhotosCount()}</b><span>照片</span></button>
            <button class="stat stat-btn" type="button" data-action="short-list"><b>${shortCount()}</b><span>缺送</span></button>
            <button class="stat stat-btn" type="button" data-action="remark-list"><b>${remarkCount()}</b><span>备注信息</span></button>
          </div>
          <div class="btn-row">
            ${submitted
              ? `<button class="btn primary block" data-action="open-export">查看 / 下载收货包</button>`
              : `<button class="btn primary block" data-action="resume">${p.done ? '继续收货' : '开始收货'}</button>`}
          </div>
        </div>`;
    }
    view.innerHTML = `
      <section class="hero card">
        <img class="hero-logo" src="icons/logo-192.png" alt="${esc(APP_NAME)}">
        <h1><span class="line">${esc(BRAND_ORG)}</span><span class="line">${esc(BRAND_PRODUCT)}</span></h1>
        <p>导入当天送货单 · 逐项拍照 · 导出收货包</p>
        <div class="stack">
          <button class="btn primary block" data-action="import-note">导入送货单</button>
          <button class="btn secondary block" data-action="import-zip">导入回传包</button>
        </div>
        <p class="small muted" style="margin-top:14px">所有数据在本地运行，不上传，不产生流量</p>
      </section>
      ${isFile ? `<div class="card" style="border-color:#d9a441;background:#fff8e8">
        <b>离线单文件模式</b>
        <p class="small" style="margin-top:6px;overflow-wrap:anywhere">部分手机浏览器不允许本地网页长期保存数据。<br>请在同一轮内完成：导入 → 拍照 → 导出；<br>导出后立即保存 ZIP，再关闭页面。</p>
      </div>` : storageIssue ? `<div class="card" style="border-color:#d9a441;background:#fff8e8">
        <b>本地存储不可用</b>
        <p class="small" style="margin-top:6px;overflow-wrap:anywhere">浏览器未允许本地保存。<br>请保持本页面打开，完成导入 → 拍照 → 导出；<br>不要在导出前刷新或关闭。</p>
      </div>` : ''}
      ${current}
      <div class="card">
        <div class="settings-row"><span>收货地点</span><span class="mono">${esc(state.settings.locationCode || '未设置')}</span></div>
        <div class="settings-row"><span>验收人员</span><span>${esc(state.settings.operator || '未设置')}</span></div>
        <button class="btn ghost small" data-action="settings" style="margin-top:8px">修改设置</button>
      </div>
      <p class="small muted" style="text-align:center">${isFile ? '离线单文件版：不需要网站，也不需要联网；请及时导出收货包。' : storageIssue ? '本地存储未启用：请保持页面打开，导出后再关闭。' : 'iPhone 可“添加到主屏幕”。'}</p>`;
  }

  function renderList(view) {
    const t = state.task;
    if (!t) { state.view = 'home'; render(); return; }
    setHeader('收货', '');
    const p = taskProgress();
    const keyword = state.search.trim().toLowerCase();
    const match = (i) => {
      if (!keyword) return true;
      return (i.name + ' ' + i.code + ' ' + i.lineNo).toLowerCase().includes(keyword);
    };
    const visible = state.items.filter(match);
    const pending = visible.filter((i) => !itemDone(i));
    const done = visible.filter((i) => itemDone(i));
    const itemHtml = (i) => {
      const photos = i.photoCount || 0;
      return `
        <article class="item ${itemDone(i) ? 'done' : ''} ${i.short ? 'short' : ''}" data-id="${i.id}">
          <div class="item-head">
            <div class="line-no">${esc(i.lineNo)}</div>
            <div class="item-title">
              <div class="title-line">
                <span class="name">${esc(i.name)}</span>
                <span class="inline-meta">订购 ${fmtNum(i.qtyOrdered)} ${esc(i.unit || '')}</span>
              </div>
            </div>
            ${i.short ? '<span class="badge amber">缺送</span>' : (itemDone(i) ? '<span class="badge">已完成</span>' : `<span class="badge gray">${photos ? photos + ' 张' : '待拍照'}</span>`)}
          </div>
          <div class="item-grid">
            <label class="mini-field qty-field"><span>实送数</span><input inputmode="decimal" data-field="qty" data-id="${i.id}" value="${fmtNum(i.qtyReceived)}" ${i.short ? 'disabled' : ''}></label>
            <button class="photo-trigger ${photos ? 'has-photo' : ''}" data-action="open-photos" data-id="${i.id}" data-camera="1" ${i.short ? 'disabled' : ''}>
              <span class="photo-trigger-main">${i.short ? '缺送免拍' : (photos ? '继续拍照' : '拍照')}</span>
              <span class="photo-trigger-sub">${i.short ? '—' : photos + ' / 5'}</span>
            </button>
          </div>
          ${i.receiveRemark ? `<div class="remark-preview ${i.short ? 'amber' : ''}">${esc(i.receiveRemark)}</div>` : ''}
          <div class="item-actions">
            <button class="btn small secondary" data-action="remark" data-id="${i.id}">备注${i.receiveRemark ? ' ✓' : ''}</button>
          </div>
        </article>`;
    };
    view.innerHTML = `
      <div class="card">
        <div class="btn-row" style="justify-content:flex-end">
          <span class="muted small mono">${esc(t.noteNo)}</span>
        </div>
        <p class="muted" style="margin:7px 0 0">${esc(t.date || '')} · ${esc(t.customer || '')}</p>
        <div class="progress-label"><span>已完成 ${p.done} / ${p.total}</span><span>${p.pct}%</span></div>
        <div class="progress"><i style="width:${p.pct}%"></i></div>
      </div>
      <div class="toolbar">
        <div class="search"><span>⌕</span><input id="search" type="search" placeholder="搜索品名 / 编号" value="${esc(state.search)}"></div>
      </div>
      ${pending.length ? `<div class="group-title">待处理 ${pending.length}</div><div class="list">${pending.map(itemHtml).join('')}</div>` : ''}
      ${done.length ? `<div class="group-title">已完成 ${done.length}</div><div class="list">${done.map(itemHtml).join('')}</div>` : ''}
      ${!visible.length ? '<div class="empty"><div class="big">⌕</div>没有匹配的货品</div>' : ''}
      <div class="bottom-bar"><div class="bottom-inner">
        <button class="btn primary block" data-action="submit" ${allDone() ? '' : 'disabled'}>完成收货${allDone() ? '' : `（还差 ${state.items.length - doneCount()} 项）`}</button>
      </div></div>`;
  }

  function renderPhotos(view) {
    const item = getItem(state.selectedId);
    if (!item) { state.view = 'list'; render(); return; }
    setHeader(item.name, `序号 ${item.lineNo} · ${item.code || ''}`);
    const photos = photosFor(item.id);
    const cards = photos.map((p, idx) => `
      <div class="photo-card">
        <img src="${blobUrl(p.thumb || p.blob)}" alt="照片 ${idx + 1}" data-action="view-photo" data-id="${p.id}">
        <span class="seq">${idx + 1}</span>
        <button class="del" data-action="delete-photo" data-id="${p.id}" aria-label="删除照片">×</button>
      </div>`).join('');
    const canAdd = !item.short && photos.length < MAX_PHOTOS;
    view.innerHTML = `
      <div class="card">
        <div class="photo-head">
          <div class="line-no">${esc(item.lineNo)}</div>
          <div class="item-title"><div class="name">${esc(item.name)}</div><div class="meta">${esc(item.unit || '')} · 实送 ${fmtNum(item.qtyReceived)}</div></div>
          ${item.short ? '<span class="badge amber">缺送</span>' : ''}
        </div>
        ${item.receiveRemark ? `<div class="remark-preview ${item.short ? 'amber' : ''}">${esc(item.receiveRemark)}</div>` : ''}
        <div class="photo-grid" style="margin-top:12px">
          ${cards}
          ${canAdd ? `<button class="add-photo" data-action="add-photo" type="button"><span>＋<br>拍照<br><span class="small">${photos.length}/5</span></span></button>` : ''}
        </div>
        ${canAdd ? `<button class="btn secondary block" data-action="album-photo" type="button" style="margin-top:10px">从相册选择（可多选，最多 5 张）</button>
        <p class="small muted" style="margin-top:6px">如果系统相册只允许选 1 张，可以重复添加，最多 5 张。</p>` : ''}
        ${item.short ? '<div class="notice" style="margin-top:12px">该货品已标记缺送，无需拍照。</div>' : ''}
        ${!item.short && photos.length >= MAX_PHOTOS ? '<p class="small muted" style="margin-top:10px">已达到 5 张上限。</p>' : ''}
        ${!item.short && !photos.length ? '<p class="small muted" style="margin-top:10px">至少拍 1 张；可拍 1–5 张。</p>' : ''}
        <button class="btn primary block" data-action="finish-photos" data-id="${item.id}" ${item.short || photos.length ? '' : 'disabled'} style="margin-top:14px">完成本项</button>
      </div>
      <div class="bottom-bar"><div class="bottom-inner">
        <button class="btn secondary" data-action="back-list">返回列表</button>
        <button class="btn primary" data-action="finish-photos" data-id="${item.id}" ${item.short || photos.length ? '' : 'disabled'}>完成</button>
      </div></div>`;
  }

  function renderExport(view) {
    const t = state.task;
    if (!t) { state.view = 'home'; render(); return; }
    setHeader('收货包', t.noteNo || '');
    const p = taskProgress();
    const ready = !!state.lastZip;
    view.innerHTML = `
      <div class="card export-box">
        <div class="big-icon">${ready ? '📦' : '⏳'}</div>
        <h2>${ready ? '收货包已生成' : '准备生成收货包'}</h2>
        <p class="muted">${esc(t.company)} · ${esc(t.noteNo)}</p>
        <div class="stat-row">
          <div class="stat"><b>${p.total}</b><span>货品</span></div>
          <div class="stat"><b>${allPhotosCount()}</b><span>照片</span></div>
          <div class="stat"><b>${shortCount()}</b><span>缺送</span></div>
        </div>
        <div class="btn-row" style="flex-direction:column">
          <button class="btn primary block" data-action="download-zip" ${ready ? '' : 'disabled'}>下载收货包 ZIP</button>
          ${!ready ? '<button class="btn secondary block" data-action="regenerate-zip">生成收货包</button>' : ''}
          <button class="btn danger block" data-action="clear-task">我已保存，清空手机数据</button>
        </div>
        <p class="small muted" style="margin-top:12px">先保存 ZIP，再清空；清空后只能靠回传包恢复。</p>
      </div>
      <div class="card">
        <h3>收货信息</h3>
        <div class="meta-list">
          <div class="meta-row"><span>收货地点</span><span>${esc(t.locationCode)}</span></div>
          <div class="meta-row"><span>验收人员</span><span>${esc(t.operator || '未设置')}</span></div>
          <div class="meta-row"><span>开始时间</span><span>${esc(t.startedAt)}</span></div>
          <div class="meta-row"><span>提交时间</span><span>${esc(t.submittedAt || '')}</span></div>
          <div class="meta-row"><span>文件</span><span>${esc(state.zipName || '')}</span></div>
        </div>
      </div>`;
  }

  /* ---------------- Modals ---------------- */
  function stopCameraStream() {
    if (state.cameraStream) {
      try { state.cameraStream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
      state.cameraStream = null;
    }
    state.imageCapture = null;
  }
  function showModal(html) {
    stopCameraStream();
    $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    return $('.modal');
  }
  function closeModal() {
    stopCameraStream();
    $('#modal-root').innerHTML = '';
  }
  function showError(title, err) {
    const details = err && err.details && err.details.noteIds
      ? `<p class="small">检测到 ${err.details.noteIds.length} 张单：${esc(err.details.noteIds.slice(0, 4).join('、'))}…</p>`
      : '';
    showModal(`<h2>${esc(title)}</h2><div class="notice red">${esc(err && err.message || String(err))}</div>${details}<div class="modal-actions"><button class="btn primary" data-action="close-modal">知道了</button></div>`);
  }
  function openSettings() {
    showModal(`
      <h2>设置</h2>
      <p class="muted">收货地点用于照片编号；验收人员会写入导出的每一条货品记录。</p>
      <div class="field"><label>收货地点 / 地点码</label><input id="set-location" maxlength="20" value="${esc(state.settings.locationCode)}" placeholder="如 食堂、065"></div>
      <div class="field"><label>验收人员</label><input id="set-operator" maxlength="30" value="${esc(state.settings.operator)}" placeholder="姓名或工号"></div>
      <div class="modal-actions">
        <button class="btn secondary" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="save-settings">保存</button>
      </div>`);
  }
  function applySettings(codeInput, operatorInput) {
    const code = normalizeLocation(codeInput);
    const operator = String(operatorInput || '').trim();
    if (!code) { toast('请填写收货地点'); return false; }
    if (!operator) { toast('请填写验收人员'); return false; }
    state.settings.locationCode = code;
    state.settings.operator = operator;
    try { localStorage.setItem('canteen.settings', JSON.stringify(state.settings)); } catch (e) { /* file:// may block */ }
    return true;
  }
  function openRemark(itemId) {
    const item = getItem(itemId);
    if (!item) return;
    showModal(`
      <h2>收货备注</h2>
      <p class="muted">${esc(item.name)} · 序号 ${esc(item.lineNo)}</p>
      <div class="field"><textarea id="remark-text" maxlength="200" placeholder="可不填，最多 200 字">${esc(item.receiveRemark)}</textarea><div class="count"><span id="remark-count">${item.receiveRemark.length}</span>/200</div></div>
      <div class="modal-actions">
        <button class="btn ${item.short ? 'secondary' : 'danger'}" data-action="toggle-short" data-id="${item.id}">${item.short ? '取消缺送' : '缺送'}</button>
        <button class="btn primary" data-action="save-remark" data-id="${item.id}">提交</button>
      </div>
      <p class="small muted" style="margin-top:10px">缺送会让实送数和金额归零，并免拍照。</p>`);
    const ta = $('#remark-text');
    ta.addEventListener('input', () => { $('#remark-count').textContent = ta.value.length; });
    setTimeout(() => ta.focus(), 80);
  }
  function openShortList() {
    const list = state.items.filter((i) => i.short);
    const rows = list.map((i) => `<div class="mini-row"><span class="mini-line">${esc(i.lineNo)}</span><div><div class="mini-name">${esc(i.name)}</div></div></div>`).join('');
    showModal(`
      <h2>缺送货品</h2>
      <p class="muted">共 ${list.length} 项</p>
      ${list.length ? `<div class="mini-list">${rows}</div>` : '<p class="small muted" style="margin-top:12px">暂无缺送货品。</p>'}
      <div class="modal-actions"><button class="btn secondary" data-action="close-modal">关闭</button></div>`);
  }

  function openRemarkList() {
    const list = state.items.filter((i) => (i.receiveRemark || '').trim());
    const rows = list.map((i) => `<div class="mini-row"><span class="mini-line">${esc(i.lineNo)}</span><div><div class="mini-name">${esc(i.name)}</div><div class="mini-note">${esc(i.receiveRemark)}</div></div></div>`).join('');
    showModal(`
      <h2>已备注货品</h2>
      <p class="muted">共 ${list.length} 项</p>
      ${list.length ? `<div class="mini-list">${rows}</div>` : '<p class="small muted" style="margin-top:12px">暂无备注信息。</p>'}
      <div class="modal-actions"><button class="btn secondary" data-action="close-modal">关闭</button></div>`);
  }

  function syncPhotoSelection() {
    const boxes = Array.from(document.querySelectorAll('[data-photo-select]'));
    state.photoSelection = new Set(boxes.filter((x) => x.checked).map((x) => x.value));
    const n = state.photoSelection.size;
    const count = $('#photo-sel-count');
    if (count) count.textContent = String(n);
    const del = $('#photo-delete-selected');
    if (del) del.disabled = n === 0;
    const allBtn = $('#photo-select-all');
    if (allBtn) allBtn.textContent = boxes.length && boxes.every((x) => x.checked) ? '取消全选' : '全选';
  }

  function openPhotoGallery() {
    const photos = state.photos.slice().sort((a, b) => {
      const ia = getItem(a.itemId);
      const ib = getItem(b.itemId);
      return (Number(ia?.lineNo || 0) - Number(ib?.lineNo || 0)) || (a.order - b.order);
    });
    state.photoSelection = new Set();
    if (!photos.length) { closeModal(); toast('还没有已拍照片'); return; }
    const cards = photos.map((p) => {
      const item = getItem(p.itemId);
      return `<label class="photo-pick">
        <input type="checkbox" data-photo-select value="${p.id}">
        <img src="${blobUrl(p.thumb || p.blob)}" alt="" data-action="view-photo" data-id="${p.id}">
        <span class="pmeta">${esc(item?.lineNo || '')} ${esc(item?.name || '')} · ${p.order}</span>
      </label>`;
    }).join('');
    showModal(`
      <h2>全部照片</h2>
      <p class="muted">共 ${photos.length} 张，可多选删除</p>
      <div class="modal-actions">
        <button class="btn secondary" id="photo-select-all" type="button" data-action="photo-select-all">全选</button>
        <button class="btn danger" id="photo-delete-selected" type="button" data-action="photo-delete-selected" disabled>删除选中（<span id="photo-sel-count">0</span>）</button>
      </div>
      <div class="photo-gallery">${cards}</div>
      <div class="modal-actions"><button class="btn secondary" data-action="close-modal">关闭</button></div>`);
    syncPhotoSelection();
  }

  async function viewPhoto(id) {
    const photo = state.photos.find((p) => p.id === id);
    if (!photo) return;
    const item = getItem(photo.itemId);
    const blob = await getOriginal(id);
    if (!blob) { toast('原图已不在本机，只能查看缩略图'); return; }
    const url = blobUrl(blob);
    const dims = photo.width && photo.height ? `${photo.width} × ${photo.height}` : '原图';
    const size = blob.size ? `${(blob.size / (1024 * 1024)).toFixed(2)} MB` : '';
    showModal(`
      <h2>${esc(item?.name || '照片')} · ${esc(photo.order)}</h2>
      <p class="muted">${esc(item?.lineNo || '')} · ${esc(dims)} ${size ? '· ' + esc(size) : ''}${photo.legacyCompressed ? ' · 旧版压缩图' : ''}</p>
      <div class="photo-viewer"><img src="${url}" alt="${esc(item?.name || '收货照片')}"></div>
      <div class="modal-actions"><button class="btn secondary" data-action="close-modal">关闭</button></div>
      <p class="small muted" style="margin-top:8px">可双指缩放查看细节。</p>`);
  }

  async function deleteSelectedPhotos(ids) {
    const affected = new Set();
    for (const photoId of ids) {
      const photo = state.photos.find((p) => p.id === photoId);
      if (!photo) continue;
      affected.add(photo.itemId);
      await delPhoto(photoId);
      state.photos = state.photos.filter((p) => p.id !== photoId);
    }
    for (const itemId of affected) {
      const item = getItem(itemId);
      const list = photosFor(itemId);
      for (let i = 0; i < list.length; i++) {
        list[i].order = i + 1;
        await putPhoto(list[i]);
      }
      if (item) {
        item.photoCount = list.length;
        refreshItem(item);
      }
    }
    await persist();
    render();
  }

  function openSubmit() {
    if (!allDone()) { toast(`还有 ${state.items.length - doneCount()} 项未完成`); return; }
    showModal(`
      <h2>提交收货</h2>
      <div class="notice green"><strong>所有收货信息验收人员已确认</strong></div>
      <label class="checkline"><input type="checkbox" id="submit-check"><span>我确认以上收货信息已由验收人员确认，数量、金额、备注和缺送情况无误。</span></label>
      <div class="modal-actions">
        <button class="btn secondary" data-action="close-modal">再检查一下</button>
        <button class="btn primary" data-action="confirm-submit" id="confirm-submit" disabled>确认提交</button>
      </div>`);
    const check = $('#submit-check');
    check.addEventListener('change', () => { $('#confirm-submit').disabled = !check.checked; });
  }

  /* ---------------- Import / restore ---------------- */
  async function sha256(buffer) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return ''; }
  }

  async function importNoteFile(file) {
    if (!file) return;
    busy('正在解析送货单…');
    try {
      const buffer = await file.arrayBuffer();
      const parsed = CanteenParser.parseWorkbook(buffer, file.name);
      const hash = await sha256(buffer);
      if (state.task && !window.confirm('当前已有收货任务，导入新单会替换它。继续？')) { unbusy(); return; }
      if (state.task) await clearTaskData();
      const task = makeTask(parsed, file.name, hash);
      const items = makeItems(parsed, task.id);
      state.task = task;
      state.items = items;
      state.photos = [];
      state.view = 'list';
      state.search = '';
      state.lastZip = null;
      state.zipName = '';
      await persist();
      unbusy();
      render();
      toast(`已导入 ${items.length} 项，共 ${parsed.pageCount} 页`);
    } catch (err) {
      unbusy();
      showError('导入失败', err);
    }
  }

  function mimeFromName(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    return 'image/jpeg';
  }
  function photoLineFromName(name) {
    const base = name.split('/').pop();
    const m = base.match(/^(.+)-(\d{2,5})(?:-(\d+))?\.(jpg|jpeg|png|webp)$/i);
    if (!m) return null;
    return { lineKey: String(Number(m[2])), seq: m[3] ? Number(m[3]) : 1 };
  }

  async function restoreZip(file) {
    if (!file) return;
    busy('正在恢复回传包…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const entries = fflate.unzipSync(bytes);
      const names = Object.keys(entries);
      const wbName = names.find((n) => /修改后送货单.*\.xlsx$/i.test(n)) || names.find((n) => /\.xlsx$/i.test(n) && !n.includes('~$'));
      if (!wbName) throw new Error('ZIP 里没有修改后的送货单 .xlsx');
      const parsed = CanteenWorkbook.parseModifiedWorkbook(entries[wbName]);
      if (state.task && !window.confirm('当前已有收货任务，恢复回传包会替换它。继续？')) { unbusy(); return; }
      if (state.task) await clearTaskData();
      const now = new Date();
      const task = {
        id: parsed.task.id || uid(),
        status: 'draft',
        company: parsed.task.company,
        noteNo: parsed.task.noteNo || '',
        date: parsed.task.date || '',
        customer: parsed.task.customer || '',
        fileName: file.name,
        sourceHash: parsed.task.sourceHash || '',
        locationCode: parsed.task.locationCode || state.settings.locationCode || '01',
        locationName: parsed.task.locationName || '',
        operator: parsed.task.operator || state.settings.operator || '',
        timeToken: tokenFromText(parsed.task.startedAt || nowText(now)),
        startedAt: parsed.task.startedAt || nowText(now),
        submittedAt: parsed.task.submittedAt || '',
        confirmedAt: parsed.task.confirmedAt || '',
        pageCount: 1,
      };
      const items = parsed.items.map((x) => ({
        id: uid(), taskId: task.id,
        lineNo: x.lineNo, lineKey: x.lineKey, code: x.code, name: x.name,
        qtyOrdered: x.qtyOrdered, unit: x.unit, qtyReceived: x.qtyReceived,
        price: x.price, amount: x.amount,
        importedQty: Number(x.qtyReceived || 0), importedAmount: Number(x.amount || 0),
        remark: x.remark || '', receiveRemark: x.receiveRemark || '',
        short: !!x.short, preShortQty: null, preShortAmount: null,
        photoCount: 0, done: !!x.short,
      }));
      const byLine = new Map(items.map((i) => [i.lineKey, i]));
      const photos = [];
      const originals = new Map();
      for (const name of names) {
        if (!/^照片\/.*\.(jpg|jpeg|png|webp)$/i.test(name)) continue;
        if (entries[name].length === 0) continue;
        const info = photoLineFromName(name);
        if (!info) continue;
        const item = byLine.get(info.lineKey);
        if (!item) continue;
        const blob = new Blob([entries[name]], { type: mimeFromName(name) });
        const thumb = await makeThumb(blob);
        const dims = await imageInfo(blob).catch(() => ({ width: 0, height: 0 }));
        const lower = name.toLowerCase();
        const ext = lower.endsWith('.png') ? 'png' : lower.endsWith('.webp') ? 'webp' : 'jpg';
        const photo = {
          id: uid(), taskId: task.id, itemId: item.id, order: info.seq || 1,
          thumb, width: dims.width, height: dims.height, bytes: blob.size,
          mime: blob.type || mimeFromName(name), ext, source: 'restore',
          heicConverted: false, legacyCompressed: false, createdAt: nowText(now),
        };
        photos.push(photo);
        originals.set(photo.id, blob);
      }
      const counts = {};
      for (const p of photos) counts[p.itemId] = (counts[p.itemId] || 0) + 1;
      for (const item of items) {
        item.photoCount = counts[item.id] || 0;
        item.done = itemDone(item);
      }
      state.task = task;
      state.items = items;
      state.photos = photos;
      state.view = 'list';
      state.search = '';
      state.lastZip = null;
      state.zipName = '';
      await persist();
      for (const p of photos) await putPhoto(p, originals.get(p.id));
      unbusy();
      render();
      toast(`已恢复 ${items.length} 项、${photos.length} 张照片`);
    } catch (err) {
      unbusy();
      showError('恢复失败', err);
    }
  }

  async function clearTaskData() {
    if (state.task) {
      for (const p of state.photos.slice()) await delPhoto(p.id);
    }
    state.task = null;
    state.items = [];
    state.photos = [];
    state.lastZip = null;
    state.zipName = '';
    await delKV('task');
    await delKV('items');
    await clearPhotos();
  }

  /* ---------------- Zip ---------------- */
  function estimatedOriginalBytes() {
    return state.photos.reduce((sum, p) => sum + Number(p.bytes || 2 * 1024 * 1024), 0);
  }

  async function buildZip(compress) {
    if (!state.task) throw new Error('没有任务');
    if (!allDone()) throw new Error('还有货品未完成');
    refreshItemAmounts();
    const items = state.items.slice().sort((a, b) => Number(a.lineNo) - Number(b.lineNo));
    const totalPhotos = allPhotosCount();
    const xlsx = CanteenWorkbook.buildWorkbook(state.task, items, totalPhotos);
    const noteName = `修改后送货单_${state.task.noteNo || '送货单'}.xlsx`;
    const chunks = [];
    let resolveZip;
    let rejectZip;
    const done = new Promise((resolve, reject) => { resolveZip = resolve; rejectZip = reject; });
    const zip = new fflate.Zip((err, chunk, final) => {
      if (err) { rejectZip(err); return; }
      if (chunk) chunks.push(chunk);
      if (final) resolveZip(new Blob(chunks, { type: 'application/zip' }));
    });
    function addZipFile(name, bytes) {
      if (!bytes || !bytes.length) return;
      const entry = new fflate.ZipPassThrough(name);
      zip.add(entry);
      entry.push(bytes, true);
    }
    addZipFile(noteName, new Uint8Array(xlsx));
    const photos = state.photos.slice().sort((a, b) => {
      const ia = getItem(a.itemId), ib = getItem(b.itemId);
      return (Number(ia && ia.lineNo) - Number(ib && ib.lineNo)) || (a.order - b.order);
    });
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const item = getItem(p.itemId);
      if (!item) continue;
      $('#busy-text').textContent = `正在打包照片 ${i + 1}/${photos.length}…`;
      const original = await getOriginal(p.id);
      if (!original) continue;
      let blob = original;
      if (compress) blob = await compressForPackage(original);
      const line = String(item.lineNo).padStart(2, '0');
      const base = `${state.task.locationCode}-${state.task.timeToken}-${line}`;
      const ext = compress ? 'jpg' : (p.ext || 'jpg');
      const name = `照片/${base}${p.order > 1 ? '-' + p.order : ''}.${ext}`;
      addZipFile(name, new Uint8Array(await blob.arrayBuffer()));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    zip.end();
    state.lastZip = await done;
    state.zipName = `收货包_${state.task.locationCode}_${state.task.noteNo || '送货单'}_${state.task.timeToken}${compress ? '_高清压缩' : '_原图'}.zip`;
    return state.lastZip;
  }

  async function generateZip() {
    busy('正在生成收货包…');
    try {
      const total = estimatedOriginalBytes();
      let compress = false;
      if (total > ZIP_MAX_BYTES) {
        compress = true;
        toast('照片总量超过 600MB，将生成高清压缩包');
      } else if (total > ZIP_WARN_BYTES) {
        const mb = Math.round(total / (1024 * 1024));
        compress = !window.confirm(`原图包约 ${mb}MB，旧手机可能导出失败。\n\n点“确定”继续原图；点“取消”生成高清压缩版（长边3000px，通常更小）。`);
      }
      await buildZip(compress);
      unbusy();
      render();
      toast(compress ? '高清压缩收货包已生成' : '原图收货包已生成');
    } catch (err) {
      unbusy();
      showError('生成失败', err);
    }
  }
  async function downloadZip() {
    if (!state.lastZip) { toast('请先生成收货包'); return; }
    const name = state.zipName || '收货包.zip';
    // file:// 在 iPhone 上通常不能直接触发下载，优先走系统分享/“存储到文件”。
    if (location.protocol === 'file:' && navigator.canShare && typeof File !== 'undefined') {
      try {
        const file = new File([state.lastZip], name, { type: 'application/zip' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: '收货包' });
          toast('已打开保存/分享面板');
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(state.lastZip);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('已开始下载；请在“文件”App 中确认');
  }

  /* ---------------- Actions ---------------- */
  async function addPhotos(files) {
    const item = getItem(state.selectedId);
    if (!item || item.short) return;
    const remaining = MAX_PHOTOS - photosFor(item.id).length;
    const picked = Array.from(files || []);
    const list = picked.slice(0, Math.max(0, remaining));
    if (!list.length) { toast('已达到 5 张上限'); return; }
    if (picked.length > list.length) toast(`最多 5 张，只保留前 ${list.length} 张`);
    busy(`正在处理照片 1/${list.length}…`);
    let added = 0;
    for (let idx = 0; idx < list.length; idx++) {
      const file = list[idx];
      $('#busy-text').textContent = `正在处理照片 ${idx + 1}/${list.length}…`;
      try {
        const prepared = await preparePhoto(file);
        const order = photosFor(item.id).length + 1;
        const photo = {
          id: uid(), taskId: item.taskId, itemId: item.id, order,
          thumb: prepared.thumb, width: prepared.width, height: prepared.height,
          bytes: prepared.original.size, mime: prepared.mime, ext: prepared.ext,
          source: file.name && file.name.startsWith('camera-') ? 'camera' : 'album',
          heicConverted: prepared.heicConverted,
          legacyCompressed: false,
          createdAt: nowText(),
        };
        state.photos.push(photo);
        await putPhoto(photo, prepared.original);
        item.photoCount = photosFor(item.id).length;
        refreshItem(item);
        added++;
      } catch (err) {
        toast(`${file.name}：${err.message}`, 3200);
      }
    }
    await persist();
    unbusy();
    render();
    if (added) toast(`已添加 ${added} 张照片`);
  }

  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#file-camera').click();
      return;
    }
    showModal(`
      <h2>拍照</h2>
      <p class="muted">相机保持开启，可连续拍 1–5 张；离开时自动关闭。</p>
      <div class="camera-stage">
        <video id="camera-video" class="camera-video" autoplay playsinline muted></video>
        <button class="torch-btn" id="torch-btn" type="button" data-action="toggle-torch" hidden>手电筒</button>
      </div>
      <div id="camera-count" class="camera-count">已拍 0 / 5</div>
      <div id="camera-error" class="notice red" hidden></div>
      <div class="modal-actions">
        <button class="btn secondary" data-action="camera-album" type="button">从相册选择</button>
        <button class="btn primary" data-action="capture-camera" id="capture-camera" type="button" disabled>拍照</button>
      </div>
      <button class="btn ghost block" data-action="camera-native" type="button" style="margin-top:8px">用系统相机拍原图</button>
      <button class="btn ghost block" data-action="camera-done" type="button" style="margin-top:6px">完成拍照</button>`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: false,
      });
      const video = $('#camera-video');
      if (!video || !document.body.contains(video)) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      state.cameraStream = stream;
      video.srcObject = stream;
      await video.play().catch(() => {});
      const btn = $('#capture-camera');
      if (btn) btn.disabled = false;
      const track = stream.getVideoTracks()[0];
      state.imageCapture = null;
      if (window.ImageCapture && track) {
        try { state.imageCapture = new window.ImageCapture(track); } catch (e) { state.imageCapture = null; }
      }
      const caps = track && track.getCapabilities ? track.getCapabilities() : {};
      const torch = $('#torch-btn');
      if (torch && caps && caps.torch) {
        torch.hidden = false;
        torch.dataset.on = '0';
        torch.classList.remove('on');
        torch.textContent = '手电筒';
      }
      const item = getItem(state.selectedId);
      const count = item ? photosFor(item.id).length : 0;
      const counter = $('#camera-count');
      if (counter) counter.textContent = `已拍 ${count} / 5`;
    } catch (err) {
      const box = $('#camera-error');
      if (box) {
        box.hidden = false;
        box.textContent = err && err.name === 'NotAllowedError'
          ? '相机权限被拒绝。请在浏览器设置中允许相机，或点“从相册选择”。'
          : '无法打开相机。请检查设备相机，或点“从相册选择”。';
      }
    }
  }

  async function pickAlbum() {
    if (window.showOpenFilePicker) {
      try {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          types: [{
            description: '图片',
            accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.bmp'] },
          }],
        });
        const files = await Promise.all(handles.map((h) => h.getFile()));
        await addPhotos(files);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        /* 浏览器不支持这种选择器时，回退到 input[type=file] */
      }
    }
    $('#file-photo').click();
  }

  async function captureCamera() {
    const video = $('#camera-video');
    let blob = null;
    if (state.imageCapture && state.imageCapture.takePhoto) {
      try { blob = await state.imageCapture.takePhoto(); } catch (e) { blob = null; }
    }
    if (!blob) {
      if (!video || !video.videoWidth || !video.videoHeight) { toast('相机还没有准备好'); return; }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    }
    if (!blob) { toast('拍照失败，请重试'); return; }
    const file = new File([blob], `camera-${Date.now()}.${blob.type === 'image/png' ? 'png' : 'jpg'}`, { type: blob.type || 'image/jpeg' });
    await addPhotos([file]);
    const item = getItem(state.selectedId);
    const count = item ? photosFor(item.id).length : 0;
    if (count >= MAX_PHOTOS) {
      closeModal();
      toast('已拍满 5 张');
      return;
    }
    const counter = $('#camera-count');
    if (counter) counter.textContent = `已拍 ${count} / 5`;
    toast(`已添加，当前 ${count} / 5`);
  }

  async function toggleTorch() {
    const track = state.cameraStream && state.cameraStream.getVideoTracks
      ? state.cameraStream.getVideoTracks()[0]
      : null;
    const btn = $('#torch-btn');
    if (!track || !btn) return;
    const on = btn.dataset.on !== '1';
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      btn.dataset.on = on ? '1' : '0';
      btn.classList.toggle('on', on);
      btn.textContent = on ? '关闭手电筒' : '手电筒';
    } catch (err) {
      toast('当前设备或浏览器不支持手电筒');
    }
  }

  async function deletePhoto(photoId) {
    const photo = state.photos.find((p) => p.id === photoId);
    if (!photo) return;
    if (!window.confirm('删除这张照片？')) return;
    item_deleted: {
      const item = getItem(photo.itemId);
      await delPhoto(photoId);
      state.photos = state.photos.filter((p) => p.id !== photoId);
      if (item) {
        const list = photosFor(item.id);
        for (let i = 0; i < list.length; i++) { list[i].order = i + 1; await putPhoto(list[i]); }
        item.photoCount = list.length;
        refreshItem(item);
        await persist();
      }
    }
    render();
    toast('照片已删除');
  }

  async function markShort(item, on) {
    if (on) {
      if (!window.confirm('确认该货品缺送？\n\n确认后实送数和金额归零，且不需要拍照。')) return false;
      if (!item.short) {
        item.preShortQty = item.qtyReceived;
        item.preShortAmount = item.amount;
      }
      item.short = true;
      item.qtyReceived = 0;
      item.amount = 0;
      refreshItem(item);
    } else {
      if (!window.confirm('取消缺送？')) return false;
      item.short = false;
      item.qtyReceived = item.preShortQty === null ? Number(item.qtyOrdered || 0) : item.preShortQty;
      recalcAmount(item);
      item.preShortQty = null;
      item.preShortAmount = null;
      refreshItem(item);
    }
    await persist();
    return true;
  }

  /* ---------------- Update manager ---------------- */
  function updateBar(text) {
    const bar = $('#update-bar');
    if (!bar) return;
    const label = $('#update-text');
    if (label && text) label.textContent = text;
    bar.hidden = false;
  }

  function hideUpdateBar() {
    const bar = $('#update-bar');
    if (bar) bar.hidden = true;
  }

  function canAutoReload() {
    if (state.updateReloading) return false;
    if (!(state.view === 'home' || state.view === 'list')) return false;
    if (state.cameraStream || $('#camera-video')) return false;
    if ($('#modal-root').children.length) return false;
    const busy = $('#busy');
    if (busy && !busy.hidden) return false;
    return true;
  }

  function scheduleUpdateReload() {
    if (state.updateTimer || !canAutoReload()) return;
    state.updateTimer = setTimeout(() => {
      state.updateTimer = null;
      if (!canAutoReload()) { scheduleUpdateReload(); return; }
      state.updateReloading = true;
      persist().catch(() => {}).finally(() => location.reload());
    }, 1800);
  }

  function showUpdateFound(text) {
    if (state.updateDismissed) return;
    updateBar(text || '发现新版本，更新后自动刷新');
    scheduleUpdateReload();
  }

  function applyUpdate() {
    if (state.updateReloading) return;
    const reg = state.swReg;
    if (reg && reg.waiting) {
      updateBar('正在更新…');
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      return;
    }
    state.updateReloading = true;
    persist().catch(() => {}).finally(() => location.reload());
  }

  async function checkForUpdate(force) {
    if (!state.swReg || state.updateChecking) return;
    if (!navigator.onLine) return;
    const now = Date.now();
    if (!force && now - state.updateLastCheck < 60000) return;
    state.updateChecking = true;
    state.updateLastCheck = now;
    try {
      const res = await fetch(`version.json?t=${now}`, { cache: 'no-store' });
      if (!res.ok) return;
      const info = await res.json();
      if (info && info.version && info.version !== APP_VERSION) {
        showUpdateFound('发现新版本，正在准备…');
        try { await state.swReg.update(); } catch (e) { /* ignore */ }
      }
      if (state.swReg.waiting) showUpdateFound('新版本已就绪，点“立即更新”');
    } catch (e) { /* 版本文件不存在/离线，不打扰用户 */ }
    finally { state.updateChecking = false; }
  }

  async function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
    try {
      state.swController = !!navigator.serviceWorker.controller;
      const reg = await navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(APP_VERSION)}`, {
        scope: './',
        updateViaCache: 'none',
      });
      state.swReg = reg;
      if (reg.waiting) showUpdateFound('新版本已就绪，点“立即更新”');
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateFound('新版本已下载，点“立即更新”');
          }
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (state.updateReloading) return;
        if (!state.swController) { state.swController = true; return; }
        if (!canAutoReload()) { showUpdateFound(); return; }
        state.updateReloading = true;
        persist().catch(() => {}).finally(() => location.reload());
      });
      if (reg.active) setTimeout(() => checkForUpdate(true), 1200);
    } catch (err) {
      console.warn('SW', err);
    }
  }

  async function handleAction(el) {
    const action = el.dataset.action;
    const id = el.dataset.id;
    if (action === 'apply-update') { applyUpdate(); return; }
    if (action === 'dismiss-update') {
      state.updateDismissed = true;
      if (state.updateTimer) { clearTimeout(state.updateTimer); state.updateTimer = null; }
      hideUpdateBar();
      return;
    }
    if (action === 'import-note') { closeModal(); $('#file-note').click(); return; }
    if (action === 'import-zip') { closeModal(); $('#file-zip').click(); return; }
    if (action === 'settings') { openSettings(); return; }
    if (action === 'all-photos') { openPhotoGallery(); return; }
    if (action === 'view-photo') { await viewPhoto(id); return; }
    if (action === 'short-list') { openShortList(); return; }
    if (action === 'remark-list') { openRemarkList(); return; }
    if (action === 'photo-select-all') {
      const boxes = Array.from(document.querySelectorAll('[data-photo-select]'));
      const all = boxes.length && boxes.every((x) => x.checked);
      boxes.forEach((x) => { x.checked = !all; });
      syncPhotoSelection();
      return;
    }
    if (action === 'photo-delete-selected') {
      const ids = Array.from(state.photoSelection);
      if (!ids.length) { toast('请先选择照片'); return; }
      if (!window.confirm(`删除选中的 ${ids.length} 张照片？`)) return;
      await deleteSelectedPhotos(ids);
      openPhotoGallery();
      toast('已删除选中的照片');
      return;
    }
    if (action === 'toggle-torch') { await toggleTorch(); return; }
    if (action === 'save-setup') {
      if (!applySettings($('#setup-location').value, $('#setup-operator').value)) return;
      state.view = 'home';
      render();
      toast('设置已保存，可以开始收货');
      return;
    }
    if (action === 'save-settings') {
      if (!applySettings($('#set-location').value, $('#set-operator').value)) return;
      closeModal();
      render();
      toast('设置已保存');
      return;
    }
    if (action === 'close-modal' || action === 'modal-backdrop') { closeModal(); return; }
    if (action === 'resume' || action === 'open-export') { state.view = action === 'open-export' ? 'export' : 'list'; render(); return; }
    if (action === 'back-list') { state.view = 'list'; render(); return; }
    if (action === 'open-photos') {
      const startCamera = el.dataset.camera === '1';
      state.selectedId = id || el.dataset.id;
      if (!getItem(state.selectedId)) return;
      state.view = 'photos';
      render();
      if (startCamera) openCamera();
      return;
    }
    if (action === 'remark') {
      const item = getItem(id);
      if (item) openRemark(id);
      return;
    }
    if (action === 'save-remark') {
      const item = getItem(id);
      if (!item) return;
      const value = ($('#remark-text').value || '').trim().slice(0, 200);
      item.receiveRemark = value;
      await persist();
      closeModal();
      render();
      toast('备注已保存');
      return;
    }
    if (action === 'toggle-short') {
      const item = getItem(id);
      if (!item) return;
      const changed = await markShort(item, !item.short);
      if (changed) { closeModal(); render(); toast(item.short ? '已标记缺送' : '已取消缺送'); }
      return;
    }
    if (action === 'add-photo') { await openCamera(); return; }
    if (action === 'album-photo') { await pickAlbum(); return; }
    if (action === 'camera-album') { closeModal(); await pickAlbum(); return; }
    if (action === 'camera-native') { closeModal(); $('#file-camera').click(); return; }
    if (action === 'camera-done') { closeModal(); render(); return; }
    if (action === 'capture-camera') { await captureCamera(); return; }
    if (action === 'delete-photo') { await deletePhoto(id); return; }
    if (action === 'finish-photos') {
      const item = getItem(id);
      if (!item) return;
      if (!item.short && !photosFor(item.id).length) { toast('至少拍 1 张照片'); return; }
      refreshItem(item);
      state.view = 'list';
      render();
      return;
    }
    if (action === 'submit') { openSubmit(); return; }
    if (action === 'confirm-submit') {
      if (!$('#submit-check').checked) { toast('请先勾选确认'); return; }
      closeModal();
      state.task.status = 'submitted';
      state.task.submittedAt = nowText();
      state.task.confirmedAt = state.task.submittedAt;
      state.task.operator = state.settings.operator || state.task.operator || '';
      await persist();
      await generateZip();
      state.view = 'export';
      render();
      return;
    }
    if (action === 'download-zip') { downloadZip(); return; }
    if (action === 'regenerate-zip') { await generateZip(); return; }
    if (action === 'clear-task') {
      if (!window.confirm('确认 ZIP 已保存？\n\n清空后手机端将删除本次任务和照片，只能靠回传包恢复。')) return;
      await clearTaskData();
      state.view = 'home';
      render();
      toast('已清空本次手机数据');
      return;
    }
  }

  /* ---------------- Events ---------------- */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'modal-backdrop') {
      if (e.target === el) closeModal();
      return;
    }
    if (el.dataset.action === 'open-photos' && el.tagName !== 'BUTTON' &&
        e.target.closest('input,textarea,select,button,a,label')) return;
    e.preventDefault();
    handleAction(el).catch((err) => { unbusy(); showError('操作失败', err); });
  });

  document.addEventListener('change', (e) => {
    const input = e.target.closest('[data-field]');
    if (!input) return;
    const item = getItem(input.dataset.id);
    if (!item) return;
    const field = input.dataset.field;
    if (field === 'qty') {
      const n = Number(input.value);
      if (!Number.isFinite(n) || n < 0 || n > 99999) { toast('实送数必须是 0–99999 的数字'); input.value = fmtNum(item.qtyReceived); return; }
      item.qtyReceived = round3(n);
      recalcAmount(item);
    }
    refreshItem(item);
    persist().catch((err) => console.error(err));
    render();
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-photo-select]')) syncPhotoSelection();
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') {
      state.search = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const s = $('#search');
      if (s) { s.focus(); s.setSelectionRange(pos, pos); }
    }
  });

  $('#back-btn').addEventListener('click', () => {
    if (state.view === 'photos') state.view = 'list';
    else if (state.view === 'export') state.view = state.task && state.task.status === 'submitted' ? 'home' : 'list';
    else state.view = 'home';
    render();
  });
  $('#file-note').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; importNoteFile(f); });
  $('#file-zip').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; restoreZip(f); });
  $('#file-photo').addEventListener('change', (e) => { const files = Array.from(e.target.files); e.target.value = ''; addPhotos(files); });
  $('#file-camera').addEventListener('change', (e) => { const files = Array.from(e.target.files); e.target.value = ''; addPhotos(files); });
  window.addEventListener('pagehide', () => { persist().catch(() => {}); stopCameraStream(); });
  window.addEventListener('online', () => { checkForUpdate(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      persist().catch(() => {});
      stopCameraStream();
      if ($('#camera-video')) closeModal();
    } else {
      checkForUpdate(false);
    }
  });

  /* ---------------- Init ---------------- */
  async function init() {
    document.documentElement.dataset.appVersion = APP_VERSION;
    let saved = null;
    try { saved = localStorage.getItem('canteen.settings'); } catch (e) { /* file:// may block */ }
    if (saved) {
      try {
        const s = JSON.parse(saved);
        if (s.locationCode) state.settings.locationCode = String(s.locationCode);
        if (typeof s.operator === 'string') state.settings.operator = s.operator;
      } catch (e) { /* ignore */ }
    }
    try {
      state.db = await openDB();
    } catch (e) {
      state.db = null;
      setTimeout(() => toast('浏览器未开放本地存储，关闭页面后数据可能丢失', 4200), 500);
    }
    const task = await getKV('task');
    const items = await getKV('items');
    if (task && Array.isArray(items)) {
      state.task = task;
      state.items = items.map((i) => ({ ...i, done: itemDone(i) }));
      state.photos = (await allPhotos()).filter((p) => p.taskId === task.id);
      for (const item of state.items) item.photoCount = photosFor(item.id).length;
      refreshItemAmounts();
    }
    state.view = settingsReady() ? 'home' : 'setup';
    render();
    await setupServiceWorker();
    setTimeout(() => checkForUpdate(true), 1800);
    setInterval(() => {
      if (document.visibilityState === 'visible') checkForUpdate(false);
    }, 5 * 60 * 1000);
  }

  init().catch((err) => {
    console.error(err);
    showError('启动失败', err);
  });
})();
