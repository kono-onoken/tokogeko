/**
 * 照合の動作確認用（手動実行）。テスト用の出席簿「出席_テスト」の 2611 に、人が数セルを入力し、
 * アプリ側の記録シートにテスト用の記録を入れて、①〜⑤が期待どおり出るかを、自動で採点する。
 *
 * ■ 守ること
 *  - 出席簿には、このファイルからも一切書き込まない（出席簿のオブジェクトは触らない。値を読むのは readAttendanceMonth のみ）。
 *  - 書き込むのは、アプリ用スプレッドシートの「記録」と「例外日」だけ。テスト用の行は、記録ID が TEST- で始まる／メモが TEST。
 *  - ログに、児童の名前は出さない（児童IDだけ）。
 *
 * ■ 手順
 *  1. printReconcileTestPlan を実行 → ログの表のとおりに、出席簿（出席_テスト）の 2611 に入力する
 *     （児童は、出席簿のどの行でもよい。同じ日の入力は、表の順に、上から下へ並べる）
 *  2. insertReconcileTestData を実行（記録シートと例外日にテスト用の行が入る）
 *  3. verifyReconcileTest を実行 → 各シナリオが OK になるか見る
 *  4. removeReconcileTestData を実行（テスト用の行を消す）。出席簿に入力したセルも、手で消す
 *
 * ■ 児童の割り当て
 *  出席簿の「その日に記号が入っている児童」を、上から順に、シナリオの順に割り当てる（名簿には依存しない）。
 *  出席簿に入力しないシナリオには、その日が空欄の児童を、出席簿の末尾から割り当てる。
 *  テスト用の記録の名前は「（テスト）」にする（実名をテスト行に入れない）。
 */

var RECONCILE_TEST_YYMM = '2611';
var RECONCILE_TEST_YEAR = 2026;
var RECONCILE_TEST_MONTH = 11;

/**
 * シナリオ。児童は、名簿（在籍）の学年・並び順で先頭から順に1人ずつ割り当てる。
 * book：出席簿に入力する [出欠, 入所, 出所]（null なら入力しない＝空欄のまま）
 * app：アプリのテスト記録 [登校, 下校]（null なら記録なし。下校だけ null なら登校のみ）
 * expect：期待する不一致の種類（①〜⑤の番号）
 */
var RECONCILE_TEST_SCENARIOS = [
  { label: '8:31に登校・出席簿○', day: 2, book: ['○'], app: ['8:31', '15:50'], expect: [1] },
  { label: '水曜（プール日）の9:50に登校・出席簿○', day: 4, book: ['○'], app: ['9:50', '15:50'], expect: [] },
  { label: '木曜（行事メモに「プール」なし）の9:50に登校・出席簿○', day: 12, book: ['○'], app: ['9:50', '15:50'], expect: [1] },
  { label: '15:30に下校・出席簿○', day: 2, book: ['○'], app: ['8:10', '15:30'], expect: [1] },
  { label: '出席簿▲（入所8:45）・アプリは9:20に登校', day: 2, book: ['▲', '8:45'], app: ['9:20', '15:50'], expect: [2] },
  { label: '出席簿▲（入所8:45）・アプリは8:55に登校', day: 2, book: ['▲', '8:45'], app: ['8:55', '15:50'], expect: [] },
  { label: 'アプリに記録あり・出席簿は空欄', day: 2, book: null, app: ['8:10', '15:50'], expect: [3] },
  { label: '出席簿○・アプリに記録なし', day: 2, book: ['○'], app: null, expect: [4] },
  { label: '出席簿公・アプリに記録なし', day: 2, book: ['公'], app: null, expect: [] },
  { label: '登校のみ（下校なし）・出席簿○', day: 2, book: ['○'], app: ['8:10', null], expect: [5] },
  { label: '出席簿▼（出所14:00）・アプリは15:50に下校', day: 2, book: ['▼', '', '14:00'], app: ['8:10', '15:50'], expect: [1, 2] },
  { label: '出席簿●・8:10に登校、15:50に下校', day: 2, book: ['●'], app: ['8:10', '15:50'], expect: [] },
  { label: '例外日（照合しない）・出席簿○・記録なし', day: 9, book: ['○'], app: null, expect: [], skipDay: true },
  { label: '土曜日の記録（出席簿は空欄）', day: 7, book: null, app: ['8:10', '15:50'], expect: [], weekend: true }
];
var RECONCILE_TEST_EXCEPTION_DAY = 9;

function reconcileTestDate_(day) {
  return RECONCILE_TEST_YEAR + '-' + ('0' + RECONCILE_TEST_MONTH).slice(-2) + '-' + ('0' + day).slice(-2);
}

function reconcileTestWeekday_(day) {
  return WEEKDAYS[new Date(Date.UTC(RECONCILE_TEST_YEAR, RECONCILE_TEST_MONTH - 1, day)).getUTCDay()];
}

/**
 * シナリオに児童を割り当てる。
 *  - 出席簿に入力するシナリオ：その日に記号が入っている児童を、出席簿の並び順に、シナリオの順で割り当てる
 *  - 入力しないシナリオ：その日が空欄の児童を、出席簿の末尾から、まだ使っていない順に割り当てる
 * @return {Array} [{n, sc, child:{id,name,grade,homeroom,sort,row}, inputNote}]
 */
function reconcileTestAssignments_() {
  var book = readAttendanceMonth(RECONCILE_TEST_YYMM);
  var used = {};
  var typed = {}; // 日 → その日に記号が入っている児童ID（出席簿の並び順）
  book.children.forEach(function (c) {
    book.days.forEach(function (d) {
      if (c.cells[d.day].mark) (typed[d.day] = typed[d.day] || []).push(c.id);
    });
  });
  var next = {};
  var out = RECONCILE_TEST_SCENARIOS.map(function (sc, i) {
    return { n: i + 1, sc: sc, child: null, inputNote: '' };
  });
  out.forEach(function (a) {
    if (!a.sc.book) return;
    var list = typed[a.sc.day] || [];
    var k = next[a.sc.day] || 0;
    next[a.sc.day] = k + 1;
    var id = list[k];
    if (!id) { a.inputNote = '（入力が足りません：' + RECONCILE_TEST_MONTH + '月' + a.sc.day + '日に、記号が' + (k + 1) + '件目まで必要です）'; return; }
    used[id] = true;
    a.child = { id: id };
    var cell = book.children.filter(function (c) { return c.id === id; })[0].cells[a.sc.day];
    if (cell.mark !== a.sc.book[0]) a.inputNote = '（入力が想定と違います：想定「' + a.sc.book[0] + '」、実際「' + cell.mark + '」）';
  });
  var tail = book.children.slice().reverse();
  out.forEach(function (a) {
    if (a.sc.book) return;
    var pick = tail.filter(function (c) { return !used[c.id] && !c.cells[a.sc.day].mark; })[0];
    if (!pick) { a.inputNote = '（割り当てられる児童がいません）'; return; }
    used[pick.id] = true;
    a.child = { id: pick.id };
  });
  out.forEach(function (a, i) {
    if (!a.child) return;
    a.child = { id: a.child.id, name: '（テスト）', grade: 1, homeroom: '', sort: i, row: i };
  });
  return out;
}

function formatTypes_(arr) {
  return arr.length ? arr.map(function (t) { return MISMATCH_CIRCLED[t]; }).join('') : 'なし';
}

/** 1. 出席簿（出席_テスト）に入力する内容を、ログに表示する。 */
function printReconcileTestPlan() {
  var month = RECONCILE_TEST_MONTH;
  Logger.log('【1】出席簿（出席_テスト）の ' + RECONCILE_TEST_YYMM + ' シートに、次のセルを入力してください。');
  Logger.log('    児童は、出席簿のどの行でも構いません。同じ日の入力は、表の順に、上から下へ並べてください（表の順＝上から順）。');
  Logger.log('    場所：その児童の行 × その日の「出欠」列（時刻は同じ日の「入所」「出所」列）。入力は、あなたが手で行います。');
  RECONCILE_TEST_SCENARIOS.forEach(function (sc, i) {
    if (!sc.book) return;
    var b = sc.book;
    Logger.log('  シナリオ' + (i + 1) + '：' + month + '月' + sc.day + '日(' + reconcileTestWeekday_(sc.day) + ') → 出欠=' + b[0] +
      (b[1] ? ' 入所=' + b[1] : '') + (b[2] ? ' 出所=' + b[2] : '') + '   ← ' + sc.label);
  });
  var blanks = [];
  RECONCILE_TEST_SCENARIOS.forEach(function (sc, i) { if (!sc.book) blanks.push(i + 1); });
  Logger.log('  （シナリオ ' + blanks.join('・') + ' は、出席簿に入力しません＝空欄のまま）');
  Logger.log('【2】insertReconcileTestData を実行すると、記録シートにアプリのテスト記録（記録ID が TEST- で始まる）と、' +
    '例外日シートに ' + month + '/' + RECONCILE_TEST_EXCEPTION_DAY + ' の「照合しない」の行（メモ TEST）が入ります。');
  Logger.log('【3】verifyReconcileTest で採点します。【4】removeReconcileTestData でテスト用の行を消します（出席簿に入力したセルは、手で消してください）。');
  Logger.log('  ※ 照合設定は、初期値（8:30 / 9:45〜10:10 / 水 / 15:45 / 15分）のままであることを前提にしています。');
}

/** 2. アプリ側（記録・例外日）に、テスト用のデータを入れる。 */
function insertReconcileTestData() {
  var ss = getAppSpreadsheet_();
  var sheet = getSheet_(SHEET_LOG);
  if (countTestRecords_(sheet) > 0) throw new Error('すでにテスト用の記録が入っています。先に removeReconcileTestData を実行してください。');
  var as = reconcileTestAssignments_();
  var missing = as.filter(function (a) { return !a.child; });
  if (missing.length) {
    missing.forEach(function (a) { Logger.log('シナリオ' + a.n + '：児童を割り当てられません ' + a.inputNote); });
    throw new Error('出席簿への入力が足りません。printReconcileTestPlan の表のとおりに入力してから、もう一度実行してください。');
  }
  var received = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  var rows = [];
  as.forEach(function (a) {
    if (!a.sc.app) return;
    var grade = a.child.grade;
    var group = grade <= 2 ? '12' : grade <= 4 ? '34' : '56';
    [['登校', a.sc.app[0]], ['下校', a.sc.app[1]]].forEach(function (x) {
      if (!x[1]) return;
      var hhmm = ('0' + x[1].split(':')[0]).slice(-2) + ':' + x[1].split(':')[1];
      rows.push(['TEST-' + a.n + '-' + x[0], a.child.id, a.child.name, grade, x[0],
        reconcileTestDate_(a.sc.day) + ' ' + hhmm + ':00', received, '（テスト）', group, false]);
    });
  });
  var start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, 2).setNumberFormat('@');
  sheet.getRange(start, 6, rows.length, 2).setNumberFormat('@');
  sheet.getRange(start, 1, rows.length, LOG_HEADERS.length).setValues(rows);

  var ex = ss.getSheetByName(SHEET_EXCEPTIONS);
  var r = ex.getLastRow() + 1;
  ex.getRange(r, 1, 1, 5).setValues([[RECONCILE_TEST_YEAR + '/' + ('0' + RECONCILE_TEST_MONTH).slice(-2) + '/' + ('0' + RECONCILE_TEST_EXCEPTION_DAY).slice(-2), '', '', true, 'TEST']]);
  Logger.log('テスト用の記録を ' + rows.length + '行、例外日を1行、入れました。次は verifyReconcileTest を実行してください。');
}

/** 3. 照合を実行し、各シナリオの結果を、期待と比べて採点する。 */
function verifyReconcileTest() {
  var as = reconcileTestAssignments_();
  var roster = as.filter(function (a) { return a.child; }).map(function (a) { return a.child; });
  var res = reconcileMonth_(RECONCILE_TEST_YYMM, roster); // 割り当てた児童だけを照合する
  var book = readAttendanceMonth(RECONCILE_TEST_YYMM); // 読み取った値（採点が合わないときの手がかり用）
  var bookById = {};
  book.children.forEach(function (c) { bookById[c.id] = c; });
  var ok = 0, ng = 0;
  var scenarioKeys = {};
  as.forEach(function (a) {
    if (!a.child) { ng++; Logger.log('NG シナリオ' + a.n + ' ' + a.sc.label + ' … 児童を割り当てられません ' + a.inputNote); return; }
    var got = res.mismatches.filter(function (m) { return m.childId === a.child.id && Number(m.date.slice(-2)) === a.sc.day; })
      .map(function (m) { return m.type; });
    got = sortedNumbers_(got);
    scenarioKeys[a.child.id + '|' + a.sc.day] = true;
    var same = got.join(',') === a.sc.expect.join(',');
    var note = '';
    if (a.sc.skipDay && res.summary.skippedDays.indexOf(a.sc.day) < 0) { same = false; note = '（例外日として読まれていません）'; }
    if (a.sc.weekend && res.summary.targetDays.indexOf(a.sc.day) >= 0) { same = false; note = '（土日が対象日になっています）'; }
    if (same) ok++; else ng++;
    // 出席簿から、実際に読み取った中身（記号・入所・出所）
    var bc = bookById[a.child.id];
    var cell = bc && bc.cells[a.sc.day];
    var seen = !bc ? '（出席簿にいない児童）' : '（出席簿の実際：記号=' + (cell && cell.mark ? cell.mark : '空欄') +
      (cell && cell.inStr ? ' 入所=' + cell.inStr : '') + (cell && cell.outStr ? ' 出所=' + cell.outStr : '') + '）';
    Logger.log((same ? 'OK ' : 'NG ') + 'シナリオ' + a.n + '（児童ID ' + a.child.id + '）' + a.sc.label +
      ' … 期待：' + formatTypes_(a.sc.expect) + ' / 実際：' + formatTypes_(got) + note + a.inputNote + (same ? '' : ' ' + seen));
  });
  // 入力の場所のずれを見つける手がかり：シナリオの日ごとに、記号が入っている児童ID（テスト用の出席簿でだけ使う）
  var days = {};
  as.forEach(function (a) { days[a.sc.day] = true; });
  sortedNumbers_(Object.keys(days)).forEach(function (day) {
    var list = book.children.filter(function (c) { return c.cells[day] && c.cells[day].mark; })
      .map(function (c) { return c.id + '=' + c.cells[day].mark; });
    Logger.log('  参考：' + RECONCILE_TEST_MONTH + '月' + day + '日(' + reconcileTestWeekday_(day) + ') に記号が入っている児童ID：' + (list.join(' ') || 'なし'));
  });
  var others = res.mismatches.filter(function (m) { return !scenarioKeys[m.childId + '|' + Number(m.date.slice(-2))]; });
  if (others.length) {
    Logger.log('シナリオ以外の不一致：' + others.length + '件（出席簿に、シナリオ以外の入力があると出ます）');
    others.slice(0, 20).forEach(function (m) { Logger.log('    ' + m.date + ' ' + m.childId + ' ' + MISMATCH_CIRCLED[m.type]); });
  }
  res.warnings.forEach(function (w) { Logger.log('【警告】' + w); });
  Logger.log('採点結果：OK ' + ok + ' / NG ' + ng + '（全 ' + as.length + ' シナリオ）');
}

/** 4. テスト用の行を消す（記録シートの TEST- の行、例外日シートのメモ TEST の行）。出席簿には触らない。 */
function removeReconcileTestData() {
  var ss = getAppSpreadsheet_();
  var sheet = getSheet_(SHEET_LOG);
  var n = 0;
  var last = sheet.getLastRow();
  if (last >= 2) {
    var ids = sheet.getRange(1, 1, last, 1).getValues();
    for (var i = last - 1; i >= 1; i--) {
      if (String(ids[i][0]).indexOf('TEST-') === 0) { sheet.deleteRow(i + 1); n++; }
    }
  }
  var m = 0;
  var ex = ss.getSheetByName(SHEET_EXCEPTIONS);
  if (ex && ex.getLastRow() >= 2) {
    var memos = ex.getRange(1, 5, ex.getLastRow(), 1).getValues();
    for (var j = ex.getLastRow() - 1; j >= 1; j--) {
      if (String(memos[j][0]).trim() === 'TEST') { ex.deleteRow(j + 1); m++; }
    }
  }
  Logger.log('テスト用の記録を ' + n + '行、例外日を ' + m + '行、削除しました。（出席簿に入力したセルは、手で消してください）');
}

function countTestRecords_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  return sheet.getRange(2, 1, last - 1, 1).getValues().filter(function (r) { return String(r[0]).indexOf('TEST-') === 0; }).length;
}
