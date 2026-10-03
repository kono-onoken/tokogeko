#!/usr/bin/env node
// 段階7（照合結果の書き込み・Slack下書き・投稿・メニュー）のテスト。
//   node tools/test-stage7.js
// 偽のシート・偽の Slack・偽のダイアログを使う。本物のスプレッドシート・出席簿・Slack には、一切さわらない。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// ───── 偽のシート ─────
class FakeSheet {
  constructor(name, rows = []) { this.name = name; this.rows = rows.map((r) => r.slice()); this.formats = {}; this.activeRanges = null; }
  getName() { return this.name; }
  getLastRow() { let n = this.rows.length; while (n > 0 && this.rows[n - 1].every((v) => v === '' || v === undefined)) n--; return n; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  deleteRow(i) { this.rows.splice(i - 1, 1); }
  setActiveSelection(ranges) { this.activeRanges = ranges.map(([r, nr]) => this.getRange(r, 1, nr, 1)); }
  getActiveRangeList() { return this.activeRanges ? { getRanges: () => this.activeRanges } : null; }
  getActiveRange() { return this.activeRanges ? this.activeRanges[0] : null; }
  getRange(r, c, nr = 1, nc = 1) {
    const sheet = this;
    const get = () => { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (sheet.rows[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; };
    const rng = {
      getValues: get,
      getDisplayValues: () => get().map((row) => row.map((v) => String(v))),
      setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => { const rr = r - 1 + i; while (sheet.rows.length <= rr) sheet.rows.push([]); sheet.rows[rr][c - 1 + j] = v; })); return rng; },
      setValue(v) { return rng.setValues([[v]]); },
      setNumberFormat(f) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sheet.formats[`${r + i},${c + j}`] = f; return rng; },
      getRow: () => r, getNumRows: () => nr,
    };
    return rng;
  }
  getParent() { return { getSpreadsheetTimeZone: () => 'Asia/Tokyo' }; }
}

function fmt(date, tz, pattern) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date)) p[x.type] = x.value;
  return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
}

function world({ webhook = 'https://hooks.slack.com/services/T0000/B0000/SECRETSECRET', confirmOk = true, fetchCode = 200, fetchThrows = false, fetchBody = 'ok' } = {}) {
  const props = { APP_SHEET_ID: 'x', FOLDER_ID: 'f', API_TOKEN: 't' };
  if (webhook) props.SLACK_WEBHOOK_URL = webhook;
  const HEAD_RESULT = ['キー', '対象月', '日付', '曜日', '児童ID', '名前', '学年', '担任', '行事メモ', 'アプリ登校', 'アプリ下校', '本来の記号', '出席簿の記号', '出席簿の時刻', '不一致の種類', '説明', '対応', '担任の回答', 'メモ', 'Slack送信日時'];
  const HEAD_DRAFT = ['対象月', '担任', 'SlackメンバーID', '件数', '下書き', '状態', '送信日時', '対象のキー'];
  const sheets = {
    照合結果: new FakeSheet('照合結果', [HEAD_RESULT]),
    Slack下書き: new FakeSheet('Slack下書き', [HEAD_DRAFT]),
    担任: new FakeSheet('担任', [['担任名', 'SlackメンバーID', '備考'], ['小野', 'U0AAAA111', ''], ['田中', '', '']]),
    記録: new FakeSheet('記録'),
  };
  const alerts = [], fetches = [], active = { sheet: null };
  const ctx = {
    console, Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { formatDate: (d, z, p) => fmt(d, z, p), sleep() {} },
    UrlFetchApp: {
      fetch(url, opt) {
        fetches.push({ url, payload: JSON.parse(opt.payload) });
        if (fetchThrows) throw new Error('Exception: could not reach ' + url);
        return { getResponseCode: () => fetchCode, getContentText: () => fetchBody };
      },
    },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: (n) => sheets[n] || null, getSpreadsheetTimeZone: () => 'Asia/Tokyo', setActiveSheet() {} }),
      flush() {},
      getActiveSheet: () => active.sheet,
      getUi: () => ({
        ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' }, Button: { OK: 'OK', CANCEL: 'CANCEL' },
        alert: (title, msg) => { alerts.push({ title, msg }); return confirmOk ? 'OK' : 'CANCEL'; },
      }),
    },
  };
  vm.createContext(ctx);
  for (const f of ['Setup.gs', 'Api.gs', 'AttendanceBook.gs', 'Reconcile.gs', 'Slack.gs', 'Menu.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, sheets, alerts, fetches, props, active, run: (code) => vm.runInContext(code, ctx), json: (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, ctx)) };
}

// 照合の結果（不一致）の作り方
const mm = (id, date, type, extra = {}) => Object.assign({
  key: `2611|${date}|${id}|${'①②③④⑤'[type - 1]}`, yymm: '2611', date, weekday: '月', childId: id, name: '名前' + id, grade: 1,
  homeroom: '小野', event: '', appIn: '8:31', appOut: '15:50', natural: '▲', bookMark: '○', bookTimes: '', type,
  typeLabel: ['① 記号の食い違い', '② 時刻のずれ', '③ 出席簿の未入力', '④ 登校の押し忘れ', '⑤ 下校の押し忘れ'][type - 1],
  description: `説明${id}-${type}`,
}, extra);

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  NG  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const row20 = (m, tail = ['未確認', '', '', '']) => JSON.parse(JSON.stringify(require_(m))).concat(tail);
function require_(m) { return [m.key, m.yymm, m.date, m.weekday, m.childId, m.name, m.grade, m.homeroom, m.event, m.appIn, m.appOut, m.natural, m.bookMark, m.bookTimes, m.typeLabel, m.description]; }

console.log('照合結果の再実行（8-6）');
test('新しい不一致は、行を追加（対応は「未確認」）', () => {
  const w = world();
  const r = w.json(`mergeResultRows_([], ${JSON.stringify([mm('900001', '2026/11/02', 1)])}, '2611')`);
  assert.strictEqual(r.appended.length, 1);
  assert.deepStrictEqual(r.appended[0].slice(16), ['未確認', '', '', '']);
  assert.strictEqual(r.stats.added, 1);
});
test('同じキーの再実行では、A〜Pだけ更新し、Q〜T（対応・回答・メモ・送信日時）は残す', () => {
  const w = world();
  const old = row20(mm('900001', '2026/11/02', 1), ['担任に確認', '回答あり', 'メモです', '2026-12-01 10:00:00']);
  const changed = mm('900001', '2026/11/02', 1, { description: '説明が変わった', appIn: '8:40' });
  const r = w.json(`mergeResultRows_(${JSON.stringify([old])}, ${JSON.stringify([changed])}, '2611')`);
  assert.deepStrictEqual(r.updated[0].slice(16), ['担任に確認', '回答あり', 'メモです', '2026-12-01 10:00:00']);
  assert.strictEqual(r.updated[0][15], '説明が変わった');
  assert.strictEqual(r.updated[0][9], '8:40');
  assert.strictEqual(r.appended.length, 0);
  assert.deepStrictEqual(r.actionChanges, {});
});
test('出なくなった不一致は、削除せず、「（解消）」を付けて、対応を「完了」にする', () => {
  const w = world();
  const a = row20(mm('900001', '2026/11/02', 1), ['未確認', '', '', '']);
  const b = row20(mm('900002', '2026/11/03', 3), ['担任に確認', '回答', 'メモ', '']);
  const r = w.json(`mergeResultRows_(${JSON.stringify([a, b])}, ${JSON.stringify([mm('900001', '2026/11/02', 1)])}, '2611')`);
  assert.strictEqual(r.updated.length, 2); // 削除しない
  assert.ok(r.updated[1][15].startsWith('（解消）'));
  assert.deepStrictEqual([r.updated[1][16], r.updated[1][17], r.updated[1][18]], ['完了', '回答', 'メモ']); // 回答・メモは残る
  assert.strictEqual(r.stats.resolved, 1);
});
test('「（解消）」を二重に付けない', () => {
  const w = world();
  const b = row20(mm('900002', '2026/11/03', 3), ['完了', '', '', '']); b[15] = '（解消）説明';
  const r = w.json(`mergeResultRows_(${JSON.stringify([b])}, [], '2611')`);
  assert.strictEqual(r.updated[0][15], '（解消）説明');
  assert.strictEqual(r.stats.resolved, 0);
});
test('「（解消）」にした不一致が再び出たら、説明を更新し、対応を「未確認」に戻す', () => {
  const w = world();
  const b = row20(mm('900002', '2026/11/03', 3), ['完了', '', 'メモ', '']); b[15] = '（解消）古い説明';
  const r = w.json(`mergeResultRows_(${JSON.stringify([b])}, ${JSON.stringify([mm('900002', '2026/11/03', 3)])}, '2611')`);
  assert.ok(!r.updated[0][15].startsWith('（解消）'));
  assert.strictEqual(r.updated[0][16], '未確認');
  assert.strictEqual(r.updated[0][18], 'メモ');
  assert.strictEqual(r.stats.reopened, 1);
});
test('ほかの月の行は、触らない', () => {
  const w = world();
  const other = row20(mm('900001', '2026/10/05', 1, { key: '2610|2026/10/05|900001|①', yymm: '2610' }), ['担任に確認', '', '', '']);
  const r = w.json(`mergeResultRows_(${JSON.stringify([other])}, [], '2611')`);
  assert.deepStrictEqual(r.updated[0], other);
});
test('前月以前の「未確認」「担任に確認」の件数を数える', () => {
  const w = world();
  const rows = [
    row20(mm('1', 'a', 1, { key: '2610|a|1|①' }), ['未確認', '', '', '']),
    row20(mm('2', 'a', 1, { key: '2610|a|2|①' }), ['担任に確認', '', '', '']),
    row20(mm('3', 'a', 1, { key: '2610|a|3|①' }), ['完了', '', '', '']),
    row20(mm('4', 'a', 1, { key: '2611|a|4|①' }), ['未確認', '', '', '']), // 同じ月は数えない
    row20(mm('5', 'a', 1, { key: '2612|a|5|①' }), ['未確認', '', '', '']), // 後の月は数えない
    row20(mm('6', 'a', 1, { key: '2512|a|6|①' }), ['未確認', '', '', '']), // 前の年
  ];
  assert.deepStrictEqual(w.json(`countOpenBefore_(${JSON.stringify(rows)}, '2611')`), { unconfirmed: 2, askTeacher: 1 });
});
test('シートへの書き込み：再実行・解消・再発のとおりに動き、手入力が消えない', () => {
  const w = world();
  const first = [mm('900001', '2026/11/02', 1), mm('900002', '2026/11/03', 3)];
  const res = (list) => ({ mismatches: list, summary: { counts: {}, targetDays: [], skippedDays: [], notInBook: [], unknownMarks: {}, childrenChecked: 2 }, warnings: [] });
  const runWith = (list) => { w.ctx.reconcileMonth_ = () => JSON.parse(JSON.stringify(res(list))); w.ctx.__list = list; return w.json(`(function(){ var o = runReconcileAndWrite_('2611'); return o.stats; })()`); };
  assert.strictEqual(runWith(first).added, 2);
  const sheet = w.sheets['照合結果'];
  assert.strictEqual(sheet.rows.length, 3); // 見出し＋2件
  // 人が書く
  sheet.rows[1][16] = '担任に確認'; sheet.rows[1][17] = '回答A'; sheet.rows[2][18] = 'メモB';
  // 再実行（同じ内容）
  const s2 = runWith(first);
  assert.strictEqual(s2.added, 0);
  assert.deepStrictEqual([sheet.rows[1][16], sheet.rows[1][17], sheet.rows[2][18]], ['担任に確認', '回答A', 'メモB']);
  assert.strictEqual(sheet.rows.length, 3);
  // 2件目が出なくなる → 解消
  const s3 = runWith([first[0]]);
  assert.strictEqual(s3.resolved, 1);
  assert.ok(sheet.rows[2][15].startsWith('（解消）'));
  assert.strictEqual(sheet.rows[2][16], '完了');
  assert.strictEqual(sheet.rows[2][18], 'メモB');
  // 再発
  const s4 = runWith(first);
  assert.strictEqual(s4.reopened, 1);
  assert.strictEqual(sheet.rows[2][16], '未確認');
  assert.strictEqual(sheet.rows[1][17], '回答A');
});

console.log('Slack下書き（8-7）');
const R = (id, date, wd, name, desc, action = '担任に確認', room = '小野', sent = '') => {
  const m = mm(id, date, 1, { weekday: wd, name, description: desc, homeroom: room });
  return require_(m).concat([action, '', '', sent]);
};
test('担任ごとにまとまり、文面は仕様の形（メンション・件数・日付(曜日)・名前・説明・結び）', () => {
  const w = world();
  const rows = [R('900002', '2026/11/12', '木', '山田 太郎', 'アプリでは9:20に登校、出席簿は○（出席）'), R('900001', '2026/11/05', '木', '佐藤 花', '出席簿は▼14:00、アプリでは15:50に下校'), R('900003', '2026/11/06', '金', '鈴木 次郎', '説明3', '担任に確認', '田中')];
  const d = w.json(`buildDrafts_(${JSON.stringify(rows)}, { 小野: 'U0AAAA111', 田中: '' }, '2611')`);
  assert.strictEqual(d.length, 2);
  assert.deepStrictEqual(d.map((x) => [x.teacher, x.count]), [['小野', 2], ['田中', 1]]);
  assert.strictEqual(d[0].text, '<@U0AAAA111>\n【11月の登下校の確認依頼】\n下記の登下校記録について、確認してください。\n' +
    '・11/5(木) 佐藤 花さん：出席簿は▼14:00、アプリでは15:50に下校\n' +
    '・11/12(木) 山田 太郎さん：アプリでは9:20に登校、出席簿は○（出席）\n' +
    'このスレッドで、正しい記録を教えてください。'); // 日付順
  assert.ok(d[1].text.startsWith('田中先生\n【11月の登下校の確認依頼】')); // メンバーIDがない担任は、メンションの代わりに担任名
  assert.ok(!d[0].text.includes('件あります')); // 件数の文は入れない
});
test('対象外の行（対応が違う・送信済み・別の月・担任なし以外）は入らない', () => {
  const w = world();
  const rows = [R('1', '2026/11/02', '月', 'A', 'a', '未確認'), R('2', '2026/11/02', '月', 'B', 'b', '完了'), R('3', '2026/11/02', '月', 'C', 'c', '担任に確認', '小野', '2026-12-01 10:00:00'),
    R('4', '2026/11/02', '月', 'D', 'd', '担任に確認'), R('5', '2026/11/02', '月', 'E', 'e', '担任に確認', '')];
  rows.push(require_(mm('6', '2026/10/02', 1, { key: '2610|2026/10/02|6|①' })).concat(['担任に確認', '', '', '']));
  const d = w.json(`buildDrafts_(${JSON.stringify(rows)}, { 小野: 'U0AAAA111' }, '2611')`);
  assert.deepStrictEqual(d.map((x) => [x.teacher, x.count]), [['小野', 1], ['（担任未設定）', 1]]);
  assert.ok(d[1].text.startsWith('（担任未設定）\n【11月の登下校の確認依頼】'));
});
test('文面に、写真・写真URLを入れない（名前・日付・時刻・記号だけ）', () => {
  const w = world();
  const d = w.json(`buildDrafts_(${JSON.stringify([R('1', '2026/11/02', '月', '山田 太郎', 'アプリでは8:31に登校、出席簿は○（出席）')])}, {}, '2611')`);
  assert.ok(!/https?:|drive|写真/.test(d[0].text));
});
test('下書きの作成：同じ月・同じ担任の「下書き」は上書き、「送信済み」は触らず別の行にする', () => {
  const w = world();
  const drafts = [{ teacher: '小野', memberId: 'U1', count: 2, text: '新しい文面', keys: ['k1', 'k2'] }];
  const existing = [
    ['2611', '小野', 'U1', 1, '古い文面（手で直した）', '下書き', '', 'k1'],
    ['2611', '田中', '', 1, '田中の下書き', '下書き', '', 'k9'],
  ];
  let p = w.json(`planDraftUpserts_(${JSON.stringify(existing)}, ${JSON.stringify(drafts)}, '2611')`);
  assert.strictEqual(p.updates.length, 1); assert.strictEqual(p.updates[0].index, 0); assert.strictEqual(p.appends.length, 0);
  assert.strictEqual(p.updates[0].values[4], '新しい文面');
  existing[0][5] = '送信済み';
  p = w.json(`planDraftUpserts_(${JSON.stringify(existing)}, ${JSON.stringify(drafts)}, '2611')`);
  assert.strictEqual(p.updates.length, 0); assert.strictEqual(p.appends.length, 1);
});
test('メニュー相当：下書きを作成 → もう一度作成しても、行は増えない（上書き）', () => {
  const w = world();
  w.sheets['照合結果'].rows.push(R('900001', '2026/11/02', '月', '山田 太郎', 'a'), R('900002', '2026/11/03', '火', '佐藤 花', 'b', '担任に確認', '田中'));
  const o1 = w.json(`(function(){ var o = createSlackDrafts_('2611'); return { created: o.created, overwritten: o.overwritten, noId: o.noMemberId }; })()`);
  assert.deepStrictEqual([o1.created, o1.overwritten], [2, 0]);
  assert.deepStrictEqual(o1.noId, ['田中']);
  const d = w.sheets['Slack下書き'];
  assert.strictEqual(d.getLastRow(), 3); // 見出し＋2人分
  assert.deepStrictEqual([d.rows[1][5], d.rows[1][6]], ['下書き', '']);
  const o2 = w.json(`(function(){ var o = createSlackDrafts_('2611'); return { created: o.created, overwritten: o.overwritten }; })()`);
  assert.deepStrictEqual([o2.created, o2.overwritten], [0, 2]);
  assert.strictEqual(d.getLastRow(), 3);
});

console.log('Slackへの投稿（8-7）');
function withDraft(w, text) {
  w.sheets['照合結果'].rows.push(R('900001', '2026/11/02', '月', '山田 太郎', 'a').slice(0, 16).concat(['担任に確認', '', '', '']));
  const key = w.sheets['照合結果'].rows[1][0];
  w.sheets['Slack下書き'].rows.push(
    ['2611', '小野', 'U0AAAA111', 1, text, '下書き', '', key],      // 2行目
    ['2611', '田中', '', 1, '田中の文面', '送信済み', '2026-12-01 10:00:00', 'kx'] // 3行目
  );
  w.active.sheet = w.sheets['Slack下書き'];
}
test('Webhook未設定：投稿せず、「コピーして貼り付け」を促す。状態も変えない', () => {
  const w = world({ webhook: null });
  withDraft(w, '文面');
  w.sheets['Slack下書き'].setActiveSelection([[2, 1]]);
  w.ctx.menuPostSelectedDrafts();
  assert.strictEqual(w.fetches.length, 0);
  assert.ok(w.alerts.some((a) => /コピー/.test(a.msg) && /貼り付け/.test(a.msg)));
  assert.strictEqual(w.sheets['Slack下書き'].rows[1][5], '下書き');
});
test('確認ダイアログで「キャンセル」なら、投稿しない', () => {
  const w = world({ confirmOk: false });
  withDraft(w, '文面');
  w.sheets['Slack下書き'].setActiveSelection([[2, 1]]);
  w.ctx.menuPostSelectedDrafts();
  assert.strictEqual(w.fetches.length, 0);
  assert.strictEqual(w.sheets['Slack下書き'].rows[1][5], '下書き');
  assert.ok(w.alerts[0].msg.includes('小野') && w.alerts[0].msg.includes('1件')); // 宛先と件数を表示
});
test('投稿：セルで直した文面が、そのまま投稿され、状態が「送信済み」・照合結果にも送信日時が入る', () => {
  const w = world();
  const edited = '<@U0AAAA111> 事務局が直した文面です\n・11/2(月) 山田 太郎さん：a';
  withDraft(w, edited);
  w.sheets['Slack下書き'].setActiveSelection([[2, 1]]);
  w.ctx.menuPostSelectedDrafts();
  assert.strictEqual(w.fetches.length, 1);
  assert.strictEqual(w.fetches[0].payload.text, edited);
  const row = w.sheets['Slack下書き'].rows[1];
  assert.strictEqual(row[5], '送信済み');
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row[6]));
  assert.strictEqual(w.sheets['照合結果'].rows[1][19], row[6]);
});
test('投稿に成功したら、チャンネルを確認するよう案内する', () => {
  const w = world();
  withDraft(w, '文面');
  w.sheets['Slack下書き'].setActiveSelection([[2, 1]]);
  w.ctx.menuPostSelectedDrafts();
  const msg = w.alerts[w.alerts.length - 1].msg;
  assert.ok(msg.includes('1件を投稿しました') && msg.includes('チャンネル'));
});
test('「送信済み」の行は、選択しても投稿しない', () => {
  const w = world();
  withDraft(w, '文面');
  w.sheets['Slack下書き'].setActiveSelection([[3, 1]]);
  w.ctx.menuPostSelectedDrafts();
  assert.strictEqual(w.fetches.length, 0);
});
test('複数の行を選ぶと、順に投稿される', () => {
  const w = world();
  withDraft(w, 'A');
  w.sheets['Slack下書き'].rows.splice(2, 1, ['2611', '佐藤', 'U2', 1, 'B', '下書き', '', 'k2']); // 3行目を、2つ目の「下書き」に差し替える
  w.sheets['Slack下書き'].setActiveSelection([[2, 2]]);
  w.ctx.menuPostSelectedDrafts();
  assert.deepStrictEqual(w.fetches.map((f) => f.payload.text), ['A', 'B']);
});
test('投稿に失敗したら、状態は「下書き」のまま。Webhook の URL は、メッセージに出ない', () => {
  const w = world({ fetchCode: 500 });
  withDraft(w, '文面');
  w.sheets['Slack下書き'].setActiveSelection([[2, 1]]);
  w.ctx.menuPostSelectedDrafts();
  assert.strictEqual(w.sheets['Slack下書き'].rows[1][5], '下書き');
  assert.ok(w.alerts.some((a) => /投稿できませんでした/.test(a.msg)));
  assert.ok(!w.alerts.some((a) => a.msg.includes('hooks.slack.com') || a.msg.includes('SECRET')));
});
test('403のとき、Slackが返した理由（invalid_token など）をメッセージに出し、原因のヒントも出す。URLは出さない', () => {
  const w = world({ fetchCode: 403, fetchBody: 'invalid_token' });
  withDraft(w, '文面');
  w.sheets['Slack下書き'].setActiveSelection([[2, 1]]);
  w.ctx.menuPostSelectedDrafts();
  const msg = w.alerts[w.alerts.length - 1].msg;
  assert.ok(msg.includes('HTTP 403') && msg.includes('invalid_token'));
  assert.ok(msg.includes('考えられる原因') && msg.includes('URL が正しくない'));
  assert.ok(!msg.includes('hooks.slack.com') && !msg.includes('SECRET'));
  assert.strictEqual(w.sheets['Slack下書き'].rows[1][5], '下書き');
});
test('理由に応じたヒント：action_prohibited／no_service／本文なしの403', () => {
  const w = world();
  assert.ok(w.run(`slackErrorHint_(403, 'action_prohibited')`).includes('禁止'));
  assert.ok(w.run(`slackErrorHint_(404, 'no_service')`).includes('無効'));
  assert.ok(w.run(`slackErrorHint_(403, '')`).includes('URL'));
  assert.strictEqual(w.run(`slackErrorHint_(500, 'x')`), '');
});
test('Slackの返事の本文にURLが入っていても、理由の欄には出ない', () => {
  const w = world({ fetchCode: 403, fetchBody: 'bad https://hooks.slack.com/services/T0000/B0000/SECRETSECRET' });
  const r = w.json(`postToSlack_('https://hooks.slack.com/services/T0000/B0000/SECRETSECRET', 'x')`);
  assert.ok(!r.error.includes('SECRET') && !r.reason.includes('SECRET'));
});
test('Webhook の URL に、空白・改行・引用符が混ざっていても取り除く', () => {
  const w = world();
  assert.strictEqual(w.run('cleanWebhookUrl_("  \\"https://hooks.slack.com/services/AB\\nCD\\"  ")'), 'https://hooks.slack.com/services/ABCD');
});
test('Webhook ではない URL（チャンネルの URL など）が設定されていたら、投稿せず、案内する（URL 全体は出さない）', () => {
  const w = world({ webhook: 'https://example.slack.com/archives/C0123456789?secret=ZZZ' });
  withDraft(w, '文面');
  w.sheets['Slack下書き'].setActiveSelection([[2, 1]]);
  w.ctx.menuPostSelectedDrafts();
  assert.strictEqual(w.fetches.length, 0);
  const msg = w.alerts[w.alerts.length - 1].msg;
  assert.ok(msg.includes('Incoming Webhook の URL ではありません') && msg.includes('example.slack.com'));
  assert.ok(!msg.includes('ZZZ') && !msg.includes('C0123456789'));
  assert.strictEqual(w.sheets['Slack下書き'].rows[1][5], '下書き');
});
test('Webhook の URL の形の判定', () => {
  const w = world();
  const ok = (u) => w.run(`isSlackWebhookUrl_(${JSON.stringify(u)})`);
  assert.strictEqual(ok('https://hooks.slack.com/services/T0AAA/B0BBB/abcDEF123'), true);
  assert.strictEqual(ok('https://hooks.slack.com/services/T0AAA/B0BBB'), false);          // 末尾が欠けている
  assert.strictEqual(ok('https://example.slack.com/archives/C01'), false);                // チャンネルの URL
  assert.strictEqual(ok('http://hooks.slack.com/services/T0AAA/B0BBB/abc'), false);       // https ではない
  assert.strictEqual(ok('https://evil.example/hooks.slack.com/services/T0/B0/x'), false); // 別のドメイン
});
test('通信エラーの文にURLが入っていても、結果には出ない', () => {
  const w = world({ fetchThrows: true });
  const r = w.json(`postToSlack_('https://hooks.slack.com/services/T0000/B0000/SECRETSECRET', 'x')`);
  assert.strictEqual(r.ok, false);
  assert.ok(!r.error.includes('SECRET') && !r.error.includes('hooks.slack.com'));
});
test('Slack下書きシート以外では、投稿しない', () => {
  const w = world();
  withDraft(w, '文面');
  w.active.sheet = w.sheets['照合結果'];
  w.ctx.menuPostSelectedDrafts();
  assert.strictEqual(w.fetches.length, 0);
});

console.log('そのほか');
test('月の候補：20日以降はその月、19日までは前の月（1月は前年の12月）', () => {
  const w = world();
  const f = (iso) => w.run(`suggestYymm_(new Date('${iso}'))`);
  assert.strictEqual(f('2026-11-25T03:00:00Z'), '2611');
  assert.strictEqual(f('2026-12-03T03:00:00Z'), '2611');
  assert.strictEqual(f('2027-01-05T03:00:00Z'), '2612');
});
test('Webhook の URL を、ログ・コンソールに出さない（Slack.gs・Menu.gs）', () => {
  const dir = path.join(__dirname, '..', 'gas');
  for (const f of ['Slack.gs', 'Menu.gs']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/console\./.test(src), f + ' に、console 出力があります');
    // Logger.log は、画面がないときの代替表示（Menu.gs の alert_・confirm_ の2か所）だけ。Slack.gs には無い
    assert.strictEqual((src.match(/Logger\.log/g) || []).length, f === 'Menu.gs' ? 2 : 0, f + ' の Logger.log の数');
    assert.ok(!/['"]\s*\+\s*webhook|webhook\s*\+\s*['"]/i.test(src), f + ' で、webhook を文字列に連結しています');
  }
});
test('Slack.gs・Menu.gs は、出席簿を直接は開かない', () => {
  const dir = path.join(__dirname, '..', 'gas');
  for (const f of ['Slack.gs', 'Menu.gs']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/ATTENDANCE_BOOK_ID|openById\(/.test(src), f);
  }
});

console.log(`\n${passed} 件 OK${process.exitCode ? '、失敗あり' : ''}`);
