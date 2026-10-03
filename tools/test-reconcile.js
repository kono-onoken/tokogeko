#!/usr/bin/env node
// 出席簿の読み取り（AttendanceBook.gs）と照合ロジック（Reconcile.gs）を、偽の出席簿で確認するテスト。
//   node tools/test-reconcile.js
// 本物のスプレッドシート・出席簿には、一切さわらない。出席簿の構造は CLAUDE.md の 8-3 のとおり。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = { console, Logger: { log() {} } };
vm.createContext(ctx);
for (const f of ['Setup.gs', 'Api.gs', 'AttendanceBook.gs', 'Reconcile.gs', 'ReconcileTest.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
const run = (code) => vm.runInContext(code, ctx);
const parse = (values, yymm = '2611') => JSON.parse(run(`JSON.stringify(parseAttendanceValues_(${JSON.stringify(values)}, '${yymm}'))`));

// ───── 偽の出席簿を作る（2026年11月。1日は日曜） ─────
// 行1：B1に年月、各日の先頭（出欠）列に日の数字（結合セルの2〜4列目は空）／行2：曜日／行3：出欠・入所・（空）・出所
// 4行目〜：児童（A列＝6桁ID）／【記入方法】の行（行事メモ）／その下に「留学」「体験」の行
const DAYS = 30;
const col = (d) => 2 + (d - 1) * 4; // d日の「出欠」列（0始まり）
function makeBook({ kids, marks = {}, events = {}, extraRowsBelow = true, yearMonth = '2026/11' }) {
  const width = 2 + DAYS * 4 + 6;
  const blank = () => new Array(width).fill('');
  const r0 = blank(), r1 = blank(), r2 = blank();
  r0[1] = yearMonth;
  const wk = ['日', '月', '火', '水', '木', '金', '土'];
  for (let d = 1; d <= DAYS; d++) {
    r0[col(d)] = String(d);
    r1[col(d)] = wk[new Date(Date.UTC(2026, 10, d)).getUTCDay()];
    r2[col(d)] = '出欠'; r2[col(d) + 1] = '入所'; r2[col(d) + 2] = ''; r2[col(d) + 3] = '出所';
  }
  ['授業日数', '出席日数', '公欠日数', '欠席日数', '遅刻日数', '早退日数'].forEach((h, i) => { r2[2 + DAYS * 4 + i] = h; });
  const rows = [r0, r1, r2];
  for (const id of kids) {
    const r = blank();
    r[0] = id; r[1] = '（名前）';
    for (const [d, v] of Object.entries(marks[id] || {})) { const [m, i = '', o = ''] = v; r[col(d)] = m; r[col(d) + 1] = i; r[col(d) + 3] = o; }
    rows.push(r);
  }
  const memo = blank();
  memo[0] = '【記入方法】○…出席 ●…中抜け ▲…遅刻 ▼…早退';
  for (const [d, t] of Object.entries(events)) memo[col(d)] = t;
  rows.push(memo);
  if (extraRowsBelow) {
    const a = blank(); a[0] = '留学'; rows.push(a);
    const b = blank(); b[0] = '体験'; rows.push(b);
    const c = blank(); c[0] = '999999'; c[col(2)] = '○'; rows.push(c); // 体験の下に6桁IDがあっても、読まない
  }
  return rows;
}

// ───── 照合を実行するための部品 ─────
const DEFAULT_SETTINGS = { arriveDeadline: 510, poolStart: 585, poolEnd: 610, poolWeekday: '水', poolWord: 'プール', leaveStart: 945, tolerance: 15 };
const t = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function reconcile({ kids, marks, events = {}, app = {}, exceptions = {}, settings = {}, rosterOnly }) {
  const book = parse(makeBook({ kids, marks, events }));
  const roster = (rosterOnly || kids).map((id, i) => ({ id, name: 'N' + id, grade: 1, homeroom: 'T', sort: i, row: i }));
  const appRec = {};
  for (const [id, days] of Object.entries(app)) {
    appRec[id] = {};
    for (const [d, [i, o]] of Object.entries(days)) appRec[id][d] = { inMin: i ? t(i) : null, outMin: o ? t(o) : null };
  }
  const p = { yymm: '2611', book, app: appRec, roster, settings: Object.assign({}, DEFAULT_SETTINGS, settings), exceptions };
  vm.runInContext('globalThis.__p = ' + JSON.stringify(p), ctx);
  return JSON.parse(run('JSON.stringify(reconcileCore_(__p))'));
}
const types = (res, id, day) => res.mismatches.filter((m) => m.childId === id && Number(m.date.slice(-2)) === day).map((m) => m.type).sort();

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  NG  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

console.log('出席簿の読み取り（8-3）');
test('日付の列・曜日・児童の行・行事メモを、見出しから読む', () => {
  const b = parse(makeBook({ kids: ['900101', '900102'], marks: { 900101: { 2: ['○'], 4: ['▲', '8:45'] } }, events: { 3: '文化の日', 5: 'プール' } }));
  assert.strictEqual(b.days.length, 30);
  assert.deepStrictEqual(b.days.map((d) => d.day).slice(0, 3), [1, 2, 3]);
  assert.deepStrictEqual(b.children.map((c) => c.id), ['900101', '900102']); // 「留学」「体験」の行・その下の6桁IDは読まない
  assert.deepStrictEqual(b.events, { 3: '文化の日', 5: 'プール' });
  assert.strictEqual(b.children[0].cells[2].mark, '○');
  assert.deepStrictEqual([b.children[0].cells[4].mark, b.children[0].cells[4].inStr], ['▲', '8:45']);
  assert.deepStrictEqual(b.warnings, []);
});
test('右端の集計列（授業日数など）を日付と取り違えない', () => assert.strictEqual(parse(makeBook({ kids: ['900101'] })).days.length, 30));
test('記号の表記ゆれ（〇・◯・x）を正しい記号にそろえる', () => {
  const b = parse(makeBook({ kids: ['900101'], marks: { 900101: { 2: ['〇'], 3: ['◯'], 4: ['x'], 5: ['✕'] } } }));
  assert.deepStrictEqual([2, 3, 4, 5].map((d) => b.children[0].cells[d].mark), ['○', '○', '×', '×']);
});
test('絵文字の黒丸（⚫︎）・⭕・❌・全角Ｘも、仕様の記号にそろえる', () => {
  const b = parse(makeBook({ kids: ['900101'], marks: { 900101: { 2: ['\u26AB\uFE0E'], 3: ['⭕'], 4: ['❌'], 5: ['Ｘ'], 6: ['○\u200B'] } } }));
  assert.deepStrictEqual([2, 3, 4, 5, 6].map((d) => b.children[0].cells[d].mark), ['●', '○', '×', '×', '○']);
});
test('シート名と1行目の年月が違うと警告する', () => assert.ok(parse(makeBook({ kids: ['900101'], yearMonth: '2026/10' })).warnings.length >= 1));
test('見出しが読めないシートは、警告を出す（落ちない）', () => assert.ok(parse([['x'], ['y'], ['z']]).warnings.length >= 1));

test('右端の集計に、日付のない「出欠」の見出しがあっても、警告しない（実物の出席簿と同じ）', () => {
  const v = makeBook({ kids: ['900101'] });
  v[2][2 + DAYS * 4] = '出欠'; // 30日分の列のすぐ右に、日付のない「出欠」
  const b = parse(v);
  assert.strictEqual(b.days.length, 30);
  assert.deepStrictEqual(b.warnings, []);
});
test('日の列のあいだに、日付のない「出欠」があれば、警告する', () => {
  const v = makeBook({ kids: ['900101'] });
  v[0][col(10)] = ''; // 10日の日付を消す（結合セルの崩れなど）
  const b = parse(v);
  assert.strictEqual(b.days.length, 29);
  assert.ok(b.warnings.some((w) => w.includes('日付を読めない列')));
});
test('行事メモの改行は、空白1つにそろえる', () => {
  const b = parse(makeBook({ kids: ['900101'], events: { 18: 'テスト行事の\n続き' } }));
  assert.strictEqual(b.events[18], 'テスト行事の 続き');
});

console.log('照合ロジック（8-5・チェックリスト）');
const KIDS = ['900101', '900102', '900103', '900104', '900105', '900106', '900107', '900108', '900109', '900110', '900111', '900112', '900113', '900114', '900115', '900116', '900117', '900118', '900119'];
const marks = {
  900101: { 2: ['○'] },                       // 8:31登校
  900102: { 4: ['○'] },                       // 水曜 9:50登校（プール）
  900103: { 5: ['○'] },                       // 行事メモ「プール」の木曜 9:50登校
  900104: { 12: ['○'] },                      // 行事メモのない木曜 9:50登校
  900105: { 2: ['○'] },                       // 15:30下校
  900106: { 2: ['▲', '8:45'] },               // アプリ9:20登校
  900107: { 2: ['▲', '8:45'] },               // アプリ8:55登校
  900108: {},                                 // 出席簿は空欄・アプリに記録
  900109: { 2: ['○'] },                       // 出席簿○・アプリに記録なし
  900110: { 2: ['公'] },                      // 公・記録なし
  900111: { 2: ['○'] },                       // 登校のみ
  900112: { 2: ['▼', '', '14:00'] },          // 出所14:00・アプリ15:50下校
  900113: { 2: ['●'] },
  900114: { 2: ['×'] },
  900115: { 13: ['○'], 16: ['○'] },           // 13日は例外日（締切9:00）
  900116: { 2: ['○'] },                       // 名簿にいるが、出席簿にいない（下で除く）
  900117: { 2: ['◆', '8:40', '15:00'] },      // ◆：入所・出所の両方がずれる
  900118: { 2: ['休'] },                      // 想定外の記号
  900119: { 2: ['▲', '8:45'], 3: ['▲', '8:45'] }, // ずれがちょうど15分／16分
};
const app = {
  900101: { 2: ['8:31', '15:50'] },
  900102: { 4: ['9:50', '15:50'] },
  900103: { 5: ['9:50', '15:50'] },
  900104: { 12: ['9:50', '15:50'] },
  900105: { 2: ['8:10', '15:30'] },
  900106: { 2: ['9:20', '15:50'] },
  900107: { 2: ['8:55', '15:50'] },
  900108: { 2: ['8:10', '15:50'] },
  900111: { 2: ['8:10', null] },
  900112: { 2: ['8:10', '15:50'] },
  900113: { 2: ['8:10', '15:50'] },
  900115: { 13: ['8:45', '15:50'], 16: ['8:45', '15:50'] },
  900117: { 2: ['9:00', '14:00'] },
  900118: { 2: ['8:10', '15:50'] },
  900119: { 2: ['9:00', '15:50'], 3: ['9:01', '15:50'] },
};
const events = { 5: 'プール' };
const exceptions = { '2026-11-10': { skip: true, arriveDeadline: null, leaveStart: null }, '2026-11-13': { skip: false, arriveDeadline: t('9:00'), leaveStart: null } };
const bookKids = KIDS.filter((id) => id !== '900116');
const res = reconcile({ kids: bookKids, rosterOnly: KIDS, marks, events, app, exceptions });

test('8:31登校・出席簿○ → ①', () => assert.deepStrictEqual(types(res, '900101', 2), [1]));
test('水曜9:50登校・出席簿○ → 何も出ない（プール）', () => assert.deepStrictEqual(types(res, '900102', 4), []));
test('行事メモに「プール」がある木曜の9:50登校・出席簿○ → 何も出ない', () => assert.deepStrictEqual(types(res, '900103', 5), []));
test('行事メモのない木曜の9:50登校・出席簿○ → ①', () => assert.deepStrictEqual(types(res, '900104', 12), [1]));
test('15:30下校・出席簿○ → ①（本来は▼）', () => {
  assert.deepStrictEqual(types(res, '900105', 2), [1]);
  assert.strictEqual(res.mismatches.find((m) => m.childId === '900105').natural, '▼');
});
test('出席簿▲8:45・アプリ9:20登校 → ②（①は出ない）', () => assert.deepStrictEqual(types(res, '900106', 2), [2]));
test('出席簿▲8:45・アプリ8:55登校 → 何も出ない', () => assert.deepStrictEqual(types(res, '900107', 2), []));
test('アプリに記録あり・出席簿の出欠欄が空 → ③', () => assert.deepStrictEqual(types(res, '900108', 2), [3]));
test('出席簿○・アプリに記録なし → ④（①は出ない）', () => assert.deepStrictEqual(types(res, '900109', 2), [4]));
test('出席簿公・アプリに記録なし → 何も出ない', () => assert.deepStrictEqual(types(res, '900110', 2), []));
test('登校のみ・下校なし・出席簿○ → ⑤', () => assert.deepStrictEqual(types(res, '900111', 2), [5]));
test('出席簿▼14:00・アプリ15:50下校 → ①と②', () => assert.deepStrictEqual(types(res, '900112', 2), [1, 2]));
test('出席簿●・8:10登校15:50下校 → 何も出ない（○と同じ「出席」）', () => assert.deepStrictEqual(types(res, '900113', 2), []));
test('出席簿×・アプリに記録なし → 何も出ない', () => assert.deepStrictEqual(types(res, '900114', 2), []));
test('例外日：締切9:00の日は8:45登校が通常／通常の日は①', () => {
  assert.deepStrictEqual(types(res, '900115', 13), []);
  assert.deepStrictEqual(types(res, '900115', 16), [1]);
});
test('◆で入所・出所の両方がずれても、②は1行（説明は両方）', () => {
  const m = res.mismatches.filter((x) => x.childId === '900117');
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].type, 2);
  assert.ok(m[0].description.includes('入所') && m[0].description.includes('出所'));
});
test('時刻のずれは、15分ちょうどは出ず、16分は出る', () => {
  assert.deepStrictEqual(types(res, '900119', 2), []); // 9:00 と 8:45 = 15分
  assert.deepStrictEqual(types(res, '900119', 3), [2]); // 9:01 と 8:45 = 16分
});
test('想定外の記号は比較せず、件数を数える', () => {
  assert.deepStrictEqual(types(res, '900118', 2), []);
  assert.strictEqual(res.summary.unknownMarks['休'], 1);
});
test('土日・「照合しない」の例外日は対象外', () => {
  assert.ok(!res.summary.targetDays.includes(7) && !res.summary.targetDays.includes(8));
  assert.deepStrictEqual(res.summary.skippedDays, [10]);
});
test('対象日は、誰かの記号か記録がある月〜金だけ', () => assert.deepStrictEqual(res.summary.targetDays, [2, 3, 4, 5, 12, 13, 16]));
test('名簿にいるが出席簿にいない児童は、照合せず、一覧にする', () => {
  assert.deepStrictEqual(res.summary.notInBook, ['900116']);
  assert.strictEqual(res.mismatches.filter((m) => m.childId === '900116').length, 0);
});
test('「留学」「体験」の下の行（6桁ID）は照合されない', () => assert.strictEqual(res.mismatches.filter((m) => m.childId === '999999').length, 0));
test('在籍外の児童（名簿に渡さない児童）は照合されない', () => {
  const r2 = reconcile({ kids: ['900101', '900102'], rosterOnly: ['900102'], marks: { 900101: { 2: ['○'] }, 900102: {} }, app: { 900101: { 2: ['8:31', '15:50'] } } });
  assert.strictEqual(r2.mismatches.filter((m) => m.childId === '900101').length, 0);
});
test('8:30ちょうどの登校・15:45ちょうどの下校は「通常」', () => {
  const r3 = reconcile({ kids: ['900101'], marks: { 900101: { 2: ['○'] } }, app: { 900101: { 2: ['8:30', '15:45'] } } });
  assert.deepStrictEqual(r3.mismatches, []);
});
test('出席簿の時刻の欄には、意味のある時刻だけを出す（○の既定の時刻8:30・15:45は出さない／「記入」は読み飛ばす）', () => {
  const r = reconcile({
    kids: ['900101', '900102', '900103'],
    marks: { 900101: { 2: ['○', '8:30', '15:45'] }, 900102: { 2: ['▲', '8:45', '15:45'] }, 900103: { 2: ['●', '記入', '記入'] } },
    app: { 900101: { 2: ['8:31', '15:50'] }, 900102: { 2: ['9:20', '15:50'] }, 900103: { 2: ['8:10', '15:50'] } },
  });
  const by = (id) => r.mismatches.filter((m) => m.childId === id).map((m) => m.bookTimes);
  assert.deepStrictEqual(by('900101'), ['']);   // ○：既定の時刻は出さない（①は出る）
  assert.deepStrictEqual(by('900102'), ['入所8:45']); // ▲：入所だけ（②）
  assert.deepStrictEqual(by('900103'), []);     // ●：何も出ない（「記入」は時刻として読まない）
});
test('キーは「yymm|日付|児童ID|種類」', () => assert.strictEqual(res.mismatches.find((m) => m.childId === '900101').key, '2611|2026/11/02|900101|①'));
test('説明は、人が読める1文（アプリの時刻と出席簿の記号が入る）', () => {
  const d = res.mismatches.find((m) => m.childId === '900101').description;
  assert.ok(d.includes('8:31に登校') && d.includes('出席簿は○'));
});


console.log('実際の出席簿での自己採点（ReconcileTest.gs）');
const SC = JSON.parse(run('JSON.stringify(RECONCILE_TEST_SCENARIOS)'));
// 出席簿の行事メモの例（11日だけ「プール」。実際の出席簿と同じ日付の並び。内容は中立的な名前にしてある）
const REAL_EVENTS = { 3: '祝日', 4: '行事A', 5: '行事B', 7: '説明会', 11: 'プール', 12: '行事C', 13: '行事C', 18: '行事D 続き', 23: '祝日', 25: '記録会' };
// 実際に起きた入力：出席簿の先頭の行から順に入力された（4・9・12日は別の行）
const ALL_KIDS = Array.from({ length: 44 }, (_, i) => String(900200 + i));
function typedBook(rowFor) {
  // rowFor(シナリオ番号) → 入力した行（0始まり）
  const marks = {};
  SC.forEach((sc, i) => { if (!sc.book) return; const id = ALL_KIDS[rowFor(i)]; (marks[id] = marks[id] || {})[sc.day] = sc.book; });
  return marks;
}
function runSelfTest(marks) {
  const book = parse(makeBook({ kids: ALL_KIDS, marks, events: REAL_EVENTS }));
  vm.runInContext('globalThis.__book = ' + JSON.stringify(book) + '; readAttendanceMonth = function () { return __book; };', ctx);
  const as = JSON.parse(run('JSON.stringify(reconcileTestAssignments_())'));
  const app = {};
  as.forEach((a) => {
    if (!a.child || !a.sc.app) return;
    app[a.child.id] = app[a.child.id] || {};
    app[a.child.id][a.sc.day] = { inMin: a.sc.app[0] ? t(a.sc.app[0]) : null, outMin: a.sc.app[1] ? t(a.sc.app[1]) : null };
  });
  const roster = as.filter((a) => a.child).map((a) => a.child);
  vm.runInContext('globalThis.__p = ' + JSON.stringify({ yymm: '2611', book, app, roster, settings: DEFAULT_SETTINGS, exceptions: { '2026-11-09': { skip: true, arriveDeadline: null, leaveStart: null } } }), ctx);
  return { as, res: JSON.parse(run('JSON.stringify(reconcileCore_(__p))')) };
}
// 入力の場所が、実際のログ（先頭の9行）と同じ場合
const userRows = [0, 3, 4, 5, 7, 8, 9, 10, 11];
const inFirstRows = (i) => {
  const sc = SC[i];
  if (sc.day === 2) return userRows[SC.slice(0, i).filter((x) => x.book && x.day === 2).length];
  return 20 + i; // 4・9・12日は、別の行に入力
};
const out1 = runSelfTest(typedBook(inFirstRows));
SC.forEach((sc, i) => {
  test(`シナリオ${i + 1}：${sc.label} → ${sc.expect.length ? sc.expect.map((x) => '①②③④⑤'[x - 1]).join('') : 'なし'}`, () => {
    const a = out1.as[i];
    assert.ok(a.child, '児童を割り当てられていません ' + a.inputNote);
    assert.strictEqual(a.inputNote, '');
    assert.deepStrictEqual(types(out1.res, a.child.id, sc.day), sc.expect);
  });
});
test('児童は、出席簿の入力の順に割り当てられる（名簿に依存しない）', () => {
  const ids = out1.as.filter((a) => a.sc.book && a.sc.day === 2).map((a) => a.child.id);
  assert.deepStrictEqual(ids, userRows.map((r) => ALL_KIDS[r]));
});
test('入力しないシナリオ（7・14）には、その日が空欄の児童を、末尾から割り当てる', () => {
  assert.deepStrictEqual([out1.as[6].child.id, out1.as[13].child.id], [ALL_KIDS[43], ALL_KIDS[42]]);
});
test('例外日の行は読まれ、土日は対象日にならない', () => {
  assert.deepStrictEqual(out1.res.summary.skippedDays, [9]);
  assert.ok(!out1.res.summary.targetDays.includes(7));
});
test('入力が想定と違う（○のはずが▲）と、ログに出る', () => {
  const marks = typedBook(inFirstRows);
  marks[ALL_KIDS[0]][2] = ['▲', '8:45']; // シナリオ1は○のはず
  const o = runSelfTest(marks);
  assert.ok(o.as[0].inputNote.includes('想定と違います'));
});
test('入力が足りないと、割り当てられないシナリオが分かる', () => {
  const marks = typedBook(inFirstRows);
  delete marks[ALL_KIDS[11]]; // 最後の入力を消す
  const o = runSelfTest(marks);
  assert.ok(o.as.some((a) => !a.child && a.inputNote.includes('入力が足りません')));
});
test('シナリオの曜日が想定どおり（2日=月、4日=水、7日=土、9日=月、12日=木）', () => {
  const wd = (d) => run(`reconcileTestWeekday_(${d})`);
  assert.deepStrictEqual([2, 4, 7, 9, 12].map(wd), ['月', '水', '土', '月', '木']);
});
test('シナリオ3の前提：12日の行事メモに「プール」がない', () => assert.ok(!REAL_EVENTS[12].includes('プール')));

console.log('出席簿は読み取り専用（8-2）');
test('AttendanceBook.gs に、変更系のメソッドの呼び出しがない', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'gas', 'AttendanceBook.gs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const bad = src.match(/\.(set\w*|insert\w*|delete\w*|clear\w*|sort|append\w*|copyTo|merge\w*|remove\w*|protect|hide\w*|show\w*|move\w*|activate|rename|trash|add\w*|create\w*)\(/g);
  assert.strictEqual(bad, null, '変更系の呼び出しがあります: ' + bad);
});
test('出席簿を開くのは readAttendanceMonth の1か所だけ（他のファイルの openById は、アプリ用スプレッドシートだけ）', () => {
  const dir = path.join(__dirname, '..', 'gas');
  const strip = (f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.gs'));
  // ATTENDANCE_BOOK_ID を読むコード（prop_ / getProperty の直接の呼び出し）は AttendanceBook.gs だけ
  assert.deepStrictEqual(files.filter((f) => /(prop_|getProperty)\(\s*'ATTENDANCE_BOOK_ID'/.test(strip(f))), ['AttendanceBook.gs']);
  // AttendanceBook.gs の openById は1回だけ
  assert.strictEqual((strip('AttendanceBook.gs').match(/openById\(/g) || []).length, 1);
  // それ以外のファイルの openById は、APP_SHEET_ID（アプリ用スプレッドシート）だけ
  for (const f of files.filter((x) => x !== 'AttendanceBook.gs')) {
    for (const line of strip(f).split('\n').filter((l) => /openById\(/.test(l))) assert.ok(/APP_SHEET_ID/.test(line), f + ': ' + line.trim());
  }
  // ReconcileTest.gs は、出席簿のオブジェクトを持たない（readAttendanceMonth が返す値だけを使う）
  assert.ok(!/ATTENDANCE_BOOK_ID|getSheetByName\(\s*RECONCILE_TEST_YYMM/.test(strip('ReconcileTest.gs')));
});

console.log(`\n${passed} 件 OK${process.exitCode ? '、失敗あり' : ''}`);
