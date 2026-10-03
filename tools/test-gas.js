#!/usr/bin/env node
// GAS（gas/*.gs）のロジックを、シート・ドライブの偽物で動かして確認するテスト。
//   node tools/test-gas.js
// 本物のスプレッドシート・ドライブ・出席簿には、一切さわらない。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// ───── 偽物の Google サービス ─────
class FakeSheet {
  constructor(name, rows, tz) { this.name = name; this.rows = rows; this.tz = tz; this.formats = {}; }
  getName() { return this.name; }
  getLastRow() { let n = this.rows.length; while (n > 0 && this.rows[n - 1].every((v) => v === '' || v === undefined)) n--; return n; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getParent() { return { getSpreadsheetTimeZone: () => this.tz }; }
  getRange(r, c, nr = 1, nc = 1) {
    const sheet = this;
    return {
      getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (sheet.rows[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; },
      setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => { const rr = r - 1 + i; while (sheet.rows.length <= rr) sheet.rows.push([]); sheet.rows[rr][c - 1 + j] = v; })); return this; },
      setNumberFormat(f) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sheet.formats[`${r + i},${c + j}`] = f; return this; },
      createTextFinder(text) {
        return { matchEntireCell() { return this; }, findNext() { for (let i = 0; i < nr; i++) if (String((sheet.rows[r - 1 + i] || [])[c - 1]) === text) return {}; return null; } };
      },
    };
  }
}
function fmt(date, tz, pattern) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date)) p[x.type] = x.value;
  return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
}

function loadGas(rosterRows, logRows = [], tz = 'Asia/Tokyo') {
  const props = { APP_SHEET_ID: 'sheet-id', FOLDER_ID: 'folder-id', API_TOKEN: 'secret-token-0123456789abcdef' };
  const sheets = { 名簿: new FakeSheet('名簿', rosterRows, tz), 記録: new FakeSheet('記録', logRows, tz) };
  const saved = [];
  const ctx = {
    console, Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: (n) => sheets[n] || null }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
    Utilities: {
      formatDate: (d, z, p) => fmt(d, z, p),
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
    },
    DriveApp: { getFolderById: () => ({ getFoldersByName: () => ({ hasNext: () => false }), createFolder: () => ({ createFile: (b) => { saved.push(b.name); return { getUrl: () => 'https://drive.example/' + b.name }; } }) }) },
  };
  vm.createContext(ctx);
  for (const f of ['Setup.gs', 'Api.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
  const call = (e, kind = 'get') => JSON.parse((kind === 'get' ? ctx.doGet(e) : ctx.doPost(e)).text);
  return { ctx, sheets, saved, call, props };
}

const TOKEN = 'secret-token-0123456789abcdef';
const JPEG = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
const post = (g, body) => g.call({ postData: { contents: JSON.stringify(Object.assign({ token: TOKEN, recordId: 'abcd1234-aaaa', childId: '900001', type: '登校', capturedAt: '2026-11-05 08:12:33', group: '12', resent: false, imageBase64: JPEG }, body)) } }, 'post');
const get = (g, q) => g.call({ parameter: Object.assign({ token: TOKEN }, q) });

// 新しい名簿の並び（担任列あり・児童IDは数値のセルも混ぜる）
const NEW_ROSTER = [
  ['児童ID', '名前', 'よみ', '学年', '担任', '在籍', '並び順'],
  [900001, '小野 健', 'おの けん', 1, '小野', true, 2],
  ['900002', '山田 花', 'やまだ はな', 1, '小野', true, 1],
  ['900003', '佐藤 太郎', 'さとう たろう', 2, '田中', 'TRUE', ''],
  ['900004', '在籍外 子', 'ざいせきがい こ', 2, '田中', false, 3],
  ['900005', '鈴木 三郎', 'すずき さぶろう', 3, '田中', true, 1],
  ['', '', '', '', '', '', ''],
];
// 旧い名簿の並び（担任列なし）
const OLD_ROSTER = [
  ['児童ID', '名前', 'よみ', '学年', '在籍', '並び順'],
  ['S001', '小野 けん', 'おの けん', 1, true, 1],
  ['S002', '山田 はな', 'やまだ はな', 4, true, 1],
];

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  NG  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

console.log('名簿・API');
test('合言葉が違うと unauthorized', () => assert.deepStrictEqual(get(loadGas(NEW_ROSTER), { action: 'roster', group: '12', token: 'x' }), { ok: false, error: 'unauthorized' }));
test('roster：該当学年・在籍TRUEだけ。並び順→行順。児童IDは文字列', () => {
  const r = get(loadGas(NEW_ROSTER), { action: 'roster', group: '12' });
  assert.deepStrictEqual(r.children.map((c) => [c.childId, c.grade, c.order]), [['900002', 1, 1], ['900001', 1, 2], ['900003', 2, 3]]);
  assert.strictEqual(typeof r.children[0].childId, 'string');
  assert.deepStrictEqual(Object.keys(r.children[0]).sort(), ['childId', 'grade', 'name', 'order', 'yomi']); // API の形は旧版と同じ（担任は返さない）
});
test('roster：3・4年グループ', () => assert.deepStrictEqual(get(loadGas(NEW_ROSTER), { action: 'roster', group: '34' }).children.map((c) => c.childId), ['900005']));
test('旧い名簿の並び（担任列なし）でも動く', () => assert.deepStrictEqual(get(loadGas(OLD_ROSTER), { action: 'roster', group: '12' }).children.map((c) => c.childId), ['S001']));
test('列の順番が違っても、見出し名で読める', () => {
  const shuffled = [['在籍', '学年', '名前', '児童ID'], [true, 1, '並替 子', '999999']];
  assert.deepStrictEqual(get(loadGas(shuffled), { action: 'roster', group: '12' }).children.map((c) => c.childId), ['999999']);
});
test('必須の見出しが無いと server_error（空の名簿を返さない）', () => assert.strictEqual(get(loadGas([['児童ID', '名前'], ['1', 'a']]), { action: 'roster', group: '12' }).error, 'server_error'));
test('invalid_group / unknown_action', () => {
  const g = loadGas(NEW_ROSTER);
  assert.strictEqual(get(g, { action: 'roster', group: '99' }).error, 'invalid_group');
  assert.strictEqual(get(g, { action: 'x', group: '12' }).error, 'unknown_action');
});

console.log('記録（POST）');
test('POST：記録される。児童IDは文字列のまま、再送は boolean', () => {
  const g = loadGas(NEW_ROSTER, [['記録ID']]);
  assert.deepStrictEqual(post(g, {}), { ok: true });
  const row = g.sheets['記録'].rows[1];
  assert.deepStrictEqual([row[1], row[2], row[3], row[4], row[5], row[8], row[9]], ['900001', '小野 健', 1, '登校', '2026-11-05 08:12:33', '12', false]);
  assert.deepStrictEqual(g.saved, ['081233_900001_小野 健_登校.jpg']);
  assert.strictEqual(g.sheets['記録'].formats['2,2'], '@'); // 児童ID のセルは文字列書式
});
test('同じ recordId は duplicate（1行のまま）', () => {
  const g = loadGas(NEW_ROSTER, [['記録ID']]);
  post(g, {});
  assert.deepStrictEqual(post(g, { resent: true }), { ok: true, duplicate: true });
  assert.strictEqual(g.sheets['記録'].getLastRow(), 2);
  assert.strictEqual(g.saved.length, 1);
});
test('エラー：名簿にない児童／不正な種別／日時／合言葉', () => {
  const g = loadGas(NEW_ROSTER, [['記録ID']]);
  assert.strictEqual(post(g, { childId: '000000' }).error, 'unknown_child');
  assert.strictEqual(post(g, { type: '欠席' }).error, 'invalid_type');
  assert.strictEqual(post(g, { capturedAt: '2026/11/05 8:12' }).error, 'invalid_captured_at');
  assert.strictEqual(post(g, { token: 'wrong' }).error, 'unauthorized');
  assert.strictEqual(post(g, { imageBase64: 'not an image!' }).error, 'invalid_image');
  assert.strictEqual(g.sheets['記録'].getLastRow(), 1);
});

console.log('今日の状態（today）');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
test('today：登校中／下校済み／未登校', () => {
  const g = loadGas(NEW_ROSTER, [
    ['記録ID', '児童ID', '名前', '学年', '種別', '撮影日時'],
    ['a', '900001', 'x', 1, '登校', today + ' 08:10:00'],
    ['b', '900002', 'y', 1, '登校', today + ' 08:20:00'],
    ['c', '900002', 'y', 1, '下校', today + ' 15:50:00'],
    ['d', '900003', 'z', 2, '登校', '2000-01-01 08:00:00'], // 昨日以前は無視
  ]);
  const s = Object.fromEntries(get(g, { action: 'today', group: '12' }).states.map((x) => [x.childId, x]));
  assert.strictEqual(s['900001'].status, '登校中');
  assert.strictEqual(s['900002'].status, '下校済み');
  assert.strictEqual(s['900002'].departedAt, today + ' 15:50:00');
  assert.strictEqual(s['900003'].status, '未登校');
});
test('today：記録の児童IDが数値でも、撮影日時が日付型でも読める', () => {
  const g = loadGas(NEW_ROSTER, [['記録ID', '児童ID', '名前', '学年', '種別', '撮影日時']], 'UTC');
  // GAS を動かしている実行空間の Date を使う（別の空間の Date だと instanceof が成り立たない）
  // シートのタイムゾーンが UTC のとき、セルの 08:30 は UTC の 08:30
  g.sheets['記録'].rows.push(['a', 900001, 'x', 1, '登校', new (vm.runInContext('Date', g.ctx))(today + 'T08:30:00Z')]);
  assert.strictEqual(get(g, { action: 'today', group: '12' }).states.find((x) => x.childId === '900001').arrivedAt, today + ' 08:30:00');
});

console.log('setup() の部品');
test('既存の名簿の見出し・データは書き換えない', () => {
  const g = loadGas(OLD_ROSTER);
  const before = JSON.stringify(g.sheets['名簿'].rows);
  g.ctx.checkRosterHeaders_(g.sheets['名簿']);
  g.ctx.ensureSheet_({ getSheetByName: () => g.sheets['名簿'], insertSheet() { throw new Error('作らない'); } }, '名簿', g.ctx.ROSTER_HEADERS);
  assert.strictEqual(JSON.stringify(g.sheets['名簿'].rows), before);
});
test('照合設定：足りない項目だけ初期値を入れる（既存の値は変えない）', () => {
  const sheet = new FakeSheet('照合設定', [['項目', '値'], ['通常登校の締切', '8:45']], 'Asia/Tokyo');
  sheet.setColumnWidth = () => {};
  loadGas(NEW_ROSTER).ctx.fillSettingsDefaults_(sheet);
  const m = Object.fromEntries(sheet.rows.slice(1).map((r) => [r[0], r[1]]));
  assert.strictEqual(m['通常登校の締切'], '8:45');
  assert.strictEqual(m['プール登校の開始'], '9:45');
  assert.strictEqual(sheet.rows.length, 8); // 見出し + 7項目
});

console.log(`\n${passed} 件 OK${process.exitCode ? '、失敗あり' : ''}`);
