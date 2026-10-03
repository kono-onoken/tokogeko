/**
 * 出席簿とアプリの記録の照合（CLAUDE.md 8-5）。
 *
 * 食い違いの「候補」を挙げるだけ。最終的な判断と、出席簿の修正は人が行う。
 * このファイルは出席簿のオブジェクトを触らない（読み取った値のデータだけを受け取る）。
 */

var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
var PRESENT_MARKS = ['○', '●', '▲', '▼', '◆']; // 出席簿が「出席系」の記号（公は含めない）
var MISMATCH_LABELS = {
  1: '① 記号の食い違い', 2: '② 時刻のずれ', 3: '③ 出席簿の未入力', 4: '④ 登校の押し忘れ', 5: '⑤ 下校の押し忘れ'
};
var MISMATCH_CIRCLED = { 1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤' };
var BOOK_MARK_MEANING = { '○': '出席', '●': '出席（中抜け）', '公': '出席（公欠）', '▲': '遅刻', '▼': '早退', '◆': '遅刻＆早退', '×': '欠席' };

var RECONCILE_DEFAULTS = {
  arriveDeadline: 8 * 60 + 30, poolStart: 9 * 60 + 45, poolEnd: 10 * 60 + 10,
  poolWeekday: '水', poolWord: 'プール', leaveStart: 15 * 60 + 45, tolerance: 15
};
var RECONCILE_SETTING_LABELS = {
  '通常登校の締切': 'arriveDeadline', 'プール登校の開始': 'poolStart', 'プール登校の終了': 'poolEnd',
  'プールの曜日': 'poolWeekday', 'プール日と判定する行事メモの語': 'poolWord',
  '通常下校の開始': 'leaveStart', '時刻ずれの許容（分）': 'tolerance'
};

// ───────────────────────── データの読み込み（アプリ側のシートだけ） ─────────────────────────

/** 照合設定シートを読む。読めない項目は初期値を使う（理由は warnings に入れる）。 */
function loadReconcileSettings_() {
  var s = {};
  Object.keys(RECONCILE_DEFAULTS).forEach(function (k) { s[k] = RECONCILE_DEFAULTS[k]; });
  var warnings = [];
  var sheet = getAppSpreadsheet_().getSheetByName(SHEET_SETTINGS);
  if (!sheet || sheet.getLastRow() < 2) return { settings: s, warnings: ['照合設定シートが空です。初期値を使います。'] };
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues();
  rows.forEach(function (r) {
    var key = RECONCILE_SETTING_LABELS[String(r[0]).trim()];
    var raw = String(r[1]).trim();
    if (!key || raw === '') return;
    if (key === 'poolWeekday' || key === 'poolWord') { s[key] = raw; return; }
    var v = key === 'tolerance' ? Number(raw) : parseTimeToMinutes_(raw);
    if (v === null || isNaN(v)) { warnings.push('照合設定「' + String(r[0]).trim() + '」を読めません（' + raw + '）。初期値を使います。'); return; }
    s[key] = v;
  });
  return { settings: s, warnings: warnings };
}

/** 例外日シートを読む。{ 'yyyy-MM-dd': { skip, arriveDeadline|null, leaveStart|null } } */
function loadExceptionDays_() {
  var out = {};
  var ss = getAppSpreadsheet_();
  var sheet = ss.getSheetByName(SHEET_EXCEPTIONS);
  if (!sheet || sheet.getLastRow() < 2) return out;
  var tz = ss.getSpreadsheetTimeZone();
  var n = sheet.getLastRow() - 1;
  var vals = sheet.getRange(2, 1, n, 5).getValues();
  var shown = sheet.getRange(2, 1, n, 5).getDisplayValues();
  for (var i = 0; i < n; i++) {
    var d = vals[i][0];
    var key = d instanceof Date ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : normalizeDateString_(shown[i][0]);
    if (!key) continue;
    var b = parseTimeToMinutes_(shown[i][1]), c = parseTimeToMinutes_(shown[i][2]);
    out[key] = {
      skip: vals[i][3] === true || String(vals[i][3]).trim().toUpperCase() === 'TRUE',
      arriveDeadline: b, leaveStart: c
    };
  }
  return out;
}

/** '2026/11/5'・'2026-11-05' などを 'yyyy-MM-dd' にそろえる。読めなければ ''。 */
function normalizeDateString_(s) {
  var m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(String(s).trim());
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : '';
}

/** 記録シートから、指定した月の、児童ごと・日ごとの「最初の登校」「最後の下校」を求める。 */
function loadAppRecords_(yymm) {
  var prefix = (2000 + Number(String(yymm).slice(0, 2))) + '-' + String(yymm).slice(2, 4);
  var sheet = getSheet_(SHEET_LOG);
  var tz = sheet.getParent().getSpreadsheetTimeZone();
  var app = {};
  var last = sheet.getLastRow();
  if (last < 2) return app;
  sheet.getRange(2, 1, last - 1, 6).getValues().forEach(function (r) {
    var at = cellToDateTime_(r[5], tz);
    if (at.substring(0, 7) !== prefix) return;
    var min = parseTimeToMinutes_(at.substring(11, 16));
    if (min === null) return;
    var id = String(r[1]).trim();
    var day = Number(at.substring(8, 10));
    app[id] = app[id] || {};
    var cell = app[id][day] = app[id][day] || { inMin: null, outMin: null };
    if (r[4] === '登校') { if (cell.inMin === null || min < cell.inMin) cell.inMin = min; }
    else if (r[4] === '下校') { if (cell.outMin === null || min > cell.outMin) cell.outMin = min; }
  });
  return app;
}

// ───────────────────────── 照合の実行 ─────────────────────────

/**
 * 指定した月（yymm）を照合して、不一致の一覧を返す。出席簿は読み取りだけ。
 * @param {string} yymm
 * @param {Array=} rosterOverride 動作確認用。省略すると、名簿（在籍）の児童を照合する。
 * @return {{mismatches: Array, summary: Object, warnings: Array}}
 */
function reconcileMonth_(yymm, rosterOverride) {
  var book = readAttendanceMonth(yymm);
  var cfg = loadReconcileSettings_();
  var res = reconcileCore_({
    yymm: String(yymm),
    book: book,
    app: loadAppRecords_(yymm),
    // 名簿（在籍）の児童が対象。rosterOverride は、動作確認（ReconcileTest.gs）だけが使う
    roster: rosterOverride || readRosterRows_().filter(function (c) { return c.enrolled; }).sort(function (a, b) { return a.grade - b.grade || a.sort - b.sort || a.row - b.row; }),
    settings: cfg.settings,
    exceptions: loadExceptionDays_()
  });
  res.warnings = book.warnings.concat(cfg.warnings);
  return res;
}

/**
 * 照合の本体（純粋な関数。シートや出席簿は触らない）。
 * @param {Object} p {yymm, book, app, roster, settings, exceptions}
 */
function reconcileCore_(p) {
  var s = p.settings, book = p.book;
  var mismatches = [];
  var summary = { counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, targetDays: [], skippedDays: [], notInBook: [], unknownMarks: {}, childrenChecked: 0 };

  var daysInMonth = new Date(Date.UTC(book.year, book.month, 0)).getUTCDate();
  var bookChild = {};
  book.children.forEach(function (c) { bookChild[c.id] = c; });

  // 対象日：月〜金のうち、出席簿の誰かの出欠欄に記号がある日、またはアプリに誰かの記録がある日（例外日で「照合しない」の日は除く）
  var targetDays = [];
  for (var d = 1; d <= daysInMonth; d++) {
    var wd = new Date(Date.UTC(book.year, book.month - 1, d)).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    var ex = p.exceptions[dateKey_(book, d)];
    if (ex && ex.skip) { summary.skippedDays.push(d); continue; }
    var hasBook = book.children.some(function (c) { return c.cells[d] && c.cells[d].mark !== ''; });
    var hasApp = p.roster.some(function (r) { return p.app[r.id] && p.app[r.id][d]; });
    if (hasBook || hasApp) targetDays.push(d);
  }
  summary.targetDays = targetDays;

  p.roster.forEach(function (child) {
    var bc = bookChild[child.id];
    if (!bc) { summary.notInBook.push(child.id); return; }
    summary.childrenChecked++;
    targetDays.forEach(function (d) {
      var cell = bc.cells[d] || { mark: '', inStr: '', outStr: '' };
      var a = (p.app[child.id] || {})[d] || { inMin: null, outMin: null };
      var wd = new Date(Date.UTC(book.year, book.month - 1, d)).getUTCDay();
      var ex = p.exceptions[dateKey_(book, d)] || {};
      var memo = book.events[d] || '';
      var deadline = ex.arriveDeadline !== null && ex.arriveDeadline !== undefined ? ex.arriveDeadline : s.arriveDeadline;
      var leaveStart = ex.leaveStart !== null && ex.leaveStart !== undefined ? ex.leaveStart : s.leaveStart;
      var poolDay = WEEKDAYS[wd] === s.poolWeekday || (s.poolWord && memo.indexOf(s.poolWord) >= 0);

      var hasIn = a.inMin !== null, hasOut = a.outMin !== null;
      // アプリの記録の判定
      var inState = !hasIn ? 'none'
        : (a.inMin <= deadline || (poolDay && a.inMin >= s.poolStart && a.inMin <= s.poolEnd)) ? 'normal' : 'late';
      var outState = !hasIn ? null : !hasOut ? 'noleave' : (a.outMin >= leaveStart ? 'normal' : 'early');
      // アプリから求める「本来の記号」
      var natural = inState === 'none' ? '×'
        : inState === 'normal' ? (outState === 'early' ? '▼' : '○')
          : (outState === 'early' ? '◆' : '▲');

      var mark = cell.mark;
      if (mark && BOOK_KNOWN_MARKS.indexOf(mark) < 0) { summary.unknownMarks[mark] = (summary.unknownMarks[mark] || 0) + 1; return; } // 想定外の記号は比較しない

      var found = {};
      // ④ 登校の押し忘れ：出席簿が出席系なのに、アプリに登校の記録がない
      if (PRESENT_MARKS.indexOf(mark) >= 0 && inState === 'none') found[4] = true;
      // ① 記号の食い違い（○・●・公は「出席」として同じ扱い。④のときは重ねない。公で登校なしは不一致にしない）
      if (mark && !found[4] && !(mark === '公' && natural === '×') && markGroup_(mark) !== markGroup_(natural)) found[1] = true;
      // ② 時刻のずれ
      var timeNotes = [];
      if ((mark === '▲' || mark === '◆') && hasIn) {
        var bi = parseTimeToMinutes_(cell.inStr);
        if (bi !== null && Math.abs(a.inMin - bi) > s.tolerance) timeNotes.push('出席簿は' + mark + '入所' + minutesToStr_(bi) + '、アプリでは' + minutesToStr_(a.inMin) + 'に登校（' + Math.abs(a.inMin - bi) + '分のずれ）');
      }
      if ((mark === '▼' || mark === '◆') && hasOut) {
        var bo = parseTimeToMinutes_(cell.outStr);
        if (bo !== null && Math.abs(a.outMin - bo) > s.tolerance) timeNotes.push('出席簿は' + mark + '出所' + minutesToStr_(bo) + '、アプリでは' + minutesToStr_(a.outMin) + 'に下校（' + Math.abs(a.outMin - bo) + '分のずれ）');
      }
      if (timeNotes.length) found[2] = true;
      // ③ 出席簿の未入力：アプリに記録があるのに、出欠欄が空
      if (!mark && (hasIn || hasOut)) found[3] = true;
      // ⑤ 下校の押し忘れ：登校の記録はあるが下校の記録がない（出席簿が▼・◆でないとき）
      if (hasIn && !hasOut && mark !== '▼' && mark !== '◆') found[5] = true;

      var appIn = hasIn ? minutesToStr_(a.inMin) : 'なし';
      var appOut = hasOut ? minutesToStr_(a.outMin) : 'なし';
      var appDesc = (hasIn ? appIn + 'に登校' : '登校の記録なし') + '、' + (hasOut ? appOut + 'に下校' : '下校の記録なし');
      var bookDesc = mark ? mark + '（' + (BOOK_MARK_MEANING[mark] || '') + '）' : '空欄';
      // 出席簿は、記号を入れると入所8:30・出所15:45が自動で入る。意味のある時刻だけを出す（▲・◆の入所、▼・◆の出所）
      var bookTimes = [
        (mark === '▲' || mark === '◆') && cell.inStr ? '入所' + cell.inStr : '',
        (mark === '▼' || mark === '◆') && cell.outStr ? '出所' + cell.outStr : ''
      ].filter(Boolean).join(' ');

      Object.keys(found).forEach(function (t) {
        t = Number(t);
        var text = t === 1 ? 'アプリでは' + appDesc + '（本来の記号：' + natural + '）。出席簿は' + bookDesc
          : t === 2 ? timeNotes.join('。')
            : t === 3 ? 'アプリでは' + appDesc + '。出席簿の出欠欄は空欄'
              : t === 4 ? '出席簿は' + bookDesc + 'だが、アプリに登校の記録がない'
                : 'アプリでは' + appIn + 'に登校したが、下校の記録がない（出席簿は' + bookDesc + '）';
        var dateStr = book.year + '/' + ('0' + book.month).slice(-2) + '/' + ('0' + d).slice(-2);
        mismatches.push({
          key: [p.yymm, dateStr, child.id, MISMATCH_CIRCLED[t]].join('|'),
          yymm: p.yymm, date: dateStr, weekday: WEEKDAYS[wd], childId: child.id, name: child.name, grade: child.grade,
          homeroom: child.homeroom, event: memo, appIn: appIn, appOut: appOut, natural: natural,
          bookMark: mark, bookTimes: bookTimes, type: t, typeLabel: MISMATCH_LABELS[t], description: text
        });
        summary.counts[t]++;
      });
    });
  });
  return { mismatches: mismatches, summary: summary, warnings: [] };
}

/** 数字（または数字の文字列）の配列を、小さい順に並べた新しい配列にする。 */
function sortedNumbers_(arr) {
  return arr.map(Number).sort(function (a, b) { return a - b; });
}

/** [内容, 件数] の配列を、件数の多い順（同数なら内容の順）に並べた新しい配列にする。 */
function sortedPairsByCount_(pairs) {
  return pairs.slice().sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); });
}

function dateKey_(book, d) {
  return book.year + '-' + ('0' + book.month).slice(-2) + '-' + ('0' + d).slice(-2);
}

/** ○・●・公は「出席」として同じグループにする。 */
function markGroup_(m) {
  return m === '○' || m === '●' || m === '公' ? '出席' : m;
}

// ───────────────────────── 試し実行（エディタから。件数だけをログに出す） ─────────────────────────

/**
 * 照合を試しに実行して、結果の件数をログに出す。シートには何も書かない。出席簿は読み取りだけ。
 * ログには、児童ID・日付・種類だけを出し、名前は出さない。引数なしで実行すると、スクリプトプロパティ CHECK_YYMM（なければ 2611）を照合する。
 */
function reconcileDryRun(yymm) {
  yymm = String(yymm || defaultYymm_());
  var res = reconcileMonth_(yymm);
  var sm = res.summary;
  Logger.log('照合（試し実行） ' + yymm);
  Logger.log('  対象日：' + sm.targetDays.length + '日（' + sm.targetDays.join(',') + '）／ 照合しない日：' + (sm.skippedDays.join(',') || 'なし'));
  Logger.log('  照合した児童：' + sm.childrenChecked + '人');
  Logger.log('  不一致：' + [1, 2, 3, 4, 5].map(function (t) { return MISMATCH_CIRCLED[t] + '=' + sm.counts[t]; }).join(' ') + '（合計 ' + res.mismatches.length + '件）');
  if (sm.notInBook.length) Logger.log('  【注意】出席簿にいない児童ID：' + sm.notInBook.join(', '));
  var um = Object.keys(sm.unknownMarks);
  if (um.length) Logger.log('  【注意】想定外の記号（比較しませんでした）：' + um.map(function (m) { return '「' + m + '」' + sm.unknownMarks[m] + '件'; }).join(' '));
  res.warnings.forEach(function (w) { Logger.log('  【警告】' + w); });
  res.mismatches.slice(0, 40).forEach(function (m) {
    Logger.log('  ' + m.date + '(' + m.weekday + ') ' + m.childId + ' ' + MISMATCH_CIRCLED[m.type] + ' アプリ:' + m.appIn + '-' + m.appOut + ' 本来:' + m.natural + ' 出席簿:' + (m.bookMark || '空') + (m.bookTimes ? ' ' + m.bookTimes : ''));
  });
  if (res.mismatches.length > 40) Logger.log('  …ほか ' + (res.mismatches.length - 40) + '件');
}
