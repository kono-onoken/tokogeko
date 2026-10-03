/**
 * 出席簿（スタッフが手入力しているスプレッドシート）の読み取り。**読み取り専用**。
 *
 * ■ 守ること（CLAUDE.md 0章・8-2）
 *  - 出席簿へのアクセスは、このファイルの readAttendanceMonth() の1か所だけ。
 *  - その関数の中で使うのは、SpreadsheetApp.openById() / getSheetByName() / getDataRange() / getDisplayValues() のみ。
 *  - 出席簿に対して、値の書き込み・行や列の挿入や削除・クリア・並べ替え・名前の変更・書式の変更など、
 *    変更を伴うメソッドは一切呼ばない。他のファイルから、出席簿のオブジェクトを触らない。
 *  - 出席簿のオブジェクトは、関数の外に出さない（返すのは、読み取った値から作った、ただのデータだけ）。
 *
 * ■ 出席簿の構造（CLAUDE.md 8-3）。セルの位置は決め打ちせず、見出しから探す。
 *  - シート名：月ごとに yymm（例：2026年11月 → 2611）
 *  - 1行目：日付（各日の先頭列に日の数字）。2行目：曜日。3行目：各日について「出欠」「入所」「（空）」「出所」
 *  - 4行目以降：児童1人1行（A列＝6桁の児童ID）。A列が6桁の数字でない行が出たら、児童の行は終わり
 *  - 児童の行の下に「【記入方法】」で始まる行があり、各日の「出欠」列の位置に、その日の行事メモが入る
 *  - その下の「留学」「体験」などの行は、照合の対象外（読まない）
 */

// 見た目が似ている別の文字（変換候補や絵文字から入力されたもの）を、仕様の記号にそろえる
var BOOK_ALIASES = {
  '〇': '○', '◯': '○', '⭕': '○',
  '⚫': '●', '⬤': '●',
  'x': '×', 'X': '×', 'ｘ': '×', 'Ｘ': '×', '✕': '×', '✖': '×', '❌': '×'
};
var BOOK_KNOWN_MARKS = ['○', '●', '公', '▲', '▼', '◆', '×'];

/**
 * 出席簿の、指定した月（yymm、例 '2611'）のシートを読む。
 * @return {Object} parseAttendanceValues_ の結果（年・月、日の列、児童ごとの記号と時刻、行事メモ、警告）
 */
function readAttendanceMonth(yymm) {
  var id = prop_('ATTENDANCE_BOOK_ID');
  var name = String(yymm);
  var values;
  try {
    var book = SpreadsheetApp.openById(id);
    var sheet = book.getSheetByName(name);
    if (!sheet) throw new Error('出席簿にシート「' + name + '」がありません。');
    values = sheet.getDataRange().getDisplayValues();
  } catch (e) {
    if (/シート「/.test(String(e.message))) throw e;
    throw new Error('出席簿を開けません。ATTENDANCE_BOOK_ID と、共有（閲覧権限）を確認してください。');
  }
  return parseAttendanceValues_(values, name);
}

// ───────────────────────── ここから下は、表示値の2次元配列だけを扱う（純粋な関数） ─────────────────────────

function parseAttendanceValues_(values, yymm) {
  var warnings = [];
  var year = 2000 + Number(String(yymm).slice(0, 2));
  var month = Number(String(yymm).slice(2, 4));
  var norm = function (v) { return String(v === undefined || v === null ? '' : v).replace(/\s/g, ''); };

  // 年月の確認（B1付近の「2026/11」など。シート名と食い違えば警告）
  var top = values[0] || [];
  for (var t = 0; t < Math.min(top.length, 8); t++) {
    var ym = /(\d{4})\s*[\/\-年.]\s*(\d{1,2})/.exec(String(top[t]));
    if (ym) {
      if (Number(ym[1]) !== year || Number(ym[2]) !== month) warnings.push('1行目の年月（' + ym[1] + '/' + ym[2] + '）が、シート名（' + yymm + '）と違います。');
      break;
    }
  }

  // 3行目から「出欠」の列を探し、各日の列（出欠・入所・出所）を決める
  var head = values[2] || [];
  var starts = [];
  for (var c = 0; c < head.length; c++) if (norm(head[c]) === '出欠') starts.push(c);
  var days = [];
  var seen = {};
  var undated = []; // 日付がない「出欠」の列。日の列のあいだにあれば警告、右端（集計の見出しなど）なら読み飛ばす
  starts.forEach(function (col, k) {
    var next = k + 1 < starts.length ? starts[k + 1] : head.length;
    var day = parseDayNumber_(values[0] || [], col);
    if (!day) { undated.push(col); return; }
    undated.forEach(function (u) { warnings.push('日付を読めない列があります（' + (u + 1) + '列目）。'); });
    undated = [];
    if (seen[day]) { warnings.push(day + '日の列が重複しています。'); return; }
    seen[day] = true;
    var inCol = -1, outCol = -1;
    for (var j = col + 1; j < next; j++) {
      var h = norm(head[j]);
      if (h === '入所' && inCol < 0) inCol = j;
      if (h === '出所' && outCol < 0) outCol = j;
    }
    days.push({ day: day, col: col, inCol: inCol, outCol: outCol });
  });
  if (!days.length) warnings.push('3行目に「出欠」の列が見つかりません。');

  // 児童の行：A列が6桁の数字である間
  var children = [];
  var r = 3;
  for (; r < values.length; r++) {
    var id = String((values[r] || [])[0] === undefined ? '' : values[r][0]).trim();
    if (!/^\d{6}$/.test(id)) break;
    var cells = {};
    days.forEach(function (d) {
      var row = values[r];
      cells[d.day] = {
        mark: normalizeBookMark_(row[d.col]),
        inStr: d.inCol >= 0 ? String(row[d.inCol] === undefined ? '' : row[d.inCol]).trim() : '',
        outStr: d.outCol >= 0 ? String(row[d.outCol] === undefined ? '' : row[d.outCol]).trim() : ''
      };
    });
    children.push({ id: id, cells: cells });
  }

  // 行事メモの行：児童の行の下で、A列が「【記入方法】」で始まる行
  var events = {};
  var memoRow = -1;
  for (var q = r; q < Math.min(values.length, r + 12); q++) {
    if (/^【記入方法】/.test(norm((values[q] || [])[0]))) { memoRow = q; break; }
  }
  if (memoRow < 0) {
    warnings.push('行事メモの行（A列が「【記入方法】」で始まる行）が見つかりません。');
  } else {
    days.forEach(function (d) {
      var memo = String((values[memoRow] || [])[d.col] === undefined ? '' : values[memoRow][d.col]).trim();
      if (memo) events[d.day] = memo.replace(/\s+/g, ' ');
    });
  }

  return { yymm: String(yymm), year: year, month: month, days: days, children: children, events: events, warnings: warnings };
}

/** 1行目から、その日の列（出欠）の日付の数字を読む。結合セルで、左の列に値があることがあるので、左へ最大3列さがす。 */
function parseDayNumber_(row, col) {
  for (var c = col; c >= Math.max(0, col - 3); c--) {
    var s = String(row[c] === undefined ? '' : row[c]).trim();
    if (!s) continue;
    var m = /^(\d{1,2})(?:日)?$/.exec(s);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31) return Number(m[1]);
    return 0;
  }
  return 0;
}

function normalizeBookMark_(v) {
  // 絵文字の異体字セレクタ（U+FE0E / U+FE0F）や、見えない文字（U+200B など）を取り除いてから、そろえる
  var s = String(v === undefined || v === null ? '' : v).replace(/[\uFE0E\uFE0F\u200B-\u200D\uFEFF]/g, '').trim();
  return BOOK_ALIASES[s] || s;
}

/** '8:45'・'08:45'・'8時45分' などを、0時からの分に変える。読めなければ null。 */
function parseTimeToMinutes_(v) {
  var m = /(\d{1,2})\s*[:：時]\s*(\d{1,2})/.exec(String(v));
  if (!m) return null;
  var h = Number(m[1]), mi = Number(m[2]);
  if (h > 47 || mi > 59) return null;
  return h * 60 + mi;
}

function minutesToStr_(min) {
  return Math.floor(min / 60) + ':' + ('0' + (min % 60)).slice(-2);
}

// ───────────────────────── 構造チェック（件数だけをログに出す。児童の名前・出欠の中身は出さない） ─────────────────────────

/** 試し実行・構造チェックで使う月（yymm）。スクリプトプロパティ CHECK_YYMM、なければ 2611。 */
function defaultYymm_() {
  return PropertiesService.getScriptProperties().getProperty('CHECK_YYMM') || '2611';
}

/**
 * 出席簿の構造を読み取れているか確認する。本物の出席簿でも安全に実行できる（人数と件数だけを出す）。
 * エディタから実行する場合は、引数なしで実行する。確認する月は、スクリプトプロパティ CHECK_YYMM（なければ 2611）。
 */
function checkAttendanceBook(yymm) {
  yymm = String(yymm || defaultYymm_());
  var book = readAttendanceMonth(yymm);
  var s = summarizeAttendanceBook_(book);
  Logger.log('出席簿 ' + yymm + '（' + book.year + '年' + book.month + '月）');
  Logger.log('  児童の行：' + s.childCount + '人');
  Logger.log('  日付の列：' + s.dayCount + '日分（' + (s.firstDay || '-') + '日〜' + (s.lastDay || '-') + '日）');
  Logger.log('  時刻の列（入所・出所）が揃っている日：' + s.withTimeCols + '日');
  Logger.log('  行事メモ：' + s.eventCount + '件');
  sortedNumbers_(Object.keys(book.events)).forEach(function (d) {
    Logger.log('    ' + d + '日：' + book.events[d]);
  });
  Logger.log('  記号の件数：' + s.markCounts.map(function (m) { return m[0] + '=' + m[1]; }).join(' ') + ' / 空欄=' + s.blankCount);
  if (s.unknownMarks.length) Logger.log('  【注意】想定外の記号：' + s.unknownMarks.map(function (m) { return '「' + m[0] + '」' + m[1] + '件'; }).join(' '));
  s.timeCount && Logger.log('  入所・出所の時刻が入っているセル：' + s.timeCount + '件');
  // 日ごとの件数（記号・時刻が、どの日の列に入っているか。入力の場所の確認用）
  var perDay = marksPerDay_(book);
  if (perDay.length) Logger.log('  記号か時刻が入っている日（日(曜日)=記号の件数/時刻の件数）：' + perDay.join(' ／ '));
  // 入所・出所のセルの中身（時刻は個人情報ではないので、種類と件数を出す）
  var tv = timeValueCounts_(book);
  if (tv.inValues.length) Logger.log('  入所のセルの中身（内容×件数）：' + tv.inValues.join(' ／ '));
  if (tv.outValues.length) Logger.log('  出所のセルの中身（内容×件数）：' + tv.outValues.join(' ／ '));

  // 名簿との突き合わせ（件数と、6桁の児童IDだけ。名前は出さない）
  var roster = readRosterRows_().filter(function (c) { return c.enrolled; });
  var bookIds = {};
  book.children.forEach(function (c) { bookIds[c.id] = true; });
  var rosterIds = {};
  roster.forEach(function (c) { rosterIds[c.id] = true; });
  var notInBook = roster.filter(function (c) { return !bookIds[c.id]; }).map(function (c) { return c.id; });
  var notInRoster = book.children.filter(function (c) { return !rosterIds[c.id]; }).map(function (c) { return c.id; });
  Logger.log('  名簿（在籍）：' + roster.length + '人 / 出席簿に載っている：' + (roster.length - notInBook.length) + '人');
  if (notInBook.length) Logger.log('  【注意】名簿にいるが、出席簿にいない児童ID：' + notInBook.join(', '));
  if (notInRoster.length) Logger.log('  【注意】出席簿にいるが、名簿（在籍）にいない児童ID：' + notInRoster.join(', '));
  book.warnings.forEach(function (w) { Logger.log('  【警告】' + w); });
  if (!book.warnings.length && !notInBook.length && !notInRoster.length && !s.unknownMarks.length) Logger.log('  → 構造は問題なく読めています。');
}

/** 記号か時刻が入っている日を、「2日(月)=9/1」の形（記号の件数/時刻の件数）で並べる。 */
function marksPerDay_(book) {
  var wd = ['日', '月', '火', '水', '木', '金', '土'];
  var out = [];
  sortedNumbers_(book.days.map(function (d) { return d.day; })).forEach(function (day) {
    var marks = 0, times = 0;
    book.children.forEach(function (c) {
      var cell = c.cells[day];
      if (cell.mark) marks++;
      if (cell.inStr) times++;
      if (cell.outStr) times++;
    });
    if (marks || times) {
      out.push(day + '日(' + wd[new Date(Date.UTC(book.year, book.month - 1, day)).getUTCDay()] + ')=' + marks + '/' + times);
    }
  });
  return out;
}

/** 入所・出所のセルの中身を、「内容×件数」で、件数の多い順に並べる（最大12種類）。 */
function timeValueCounts_(book) {
  var tally = function (key) {
    var counts = {};
    book.children.forEach(function (c) {
      book.days.forEach(function (d) {
        var v = c.cells[d.day][key];
        if (v) counts[v] = (counts[v] || 0) + 1;
      });
    });
    return sortedPairsByCount_(Object.keys(counts).map(function (v) { return [v, counts[v]]; }))
      .slice(0, 12).map(function (p) { return '「' + p[0] + '」×' + p[1]; });
  };
  return { inValues: tally('inStr'), outValues: tally('outStr') };
}

function summarizeAttendanceBook_(book) {
  var counts = {};
  var blank = 0, timeCount = 0;
  book.children.forEach(function (c) {
    book.days.forEach(function (d) {
      var cell = c.cells[d.day];
      if (!cell.mark) blank++; else counts[cell.mark] = (counts[cell.mark] || 0) + 1;
      if (cell.inStr) timeCount++;
      if (cell.outStr) timeCount++;
    });
  });
  var known = BOOK_KNOWN_MARKS.filter(function (m) { return counts[m]; }).map(function (m) { return [m, counts[m]]; });
  var unknown = Object.keys(counts).filter(function (m) { return BOOK_KNOWN_MARKS.indexOf(m) < 0; }).map(function (m) { return [m, counts[m]]; });
  var dayNums = sortedNumbers_(book.days.map(function (d) { return d.day; }));
  return {
    childCount: book.children.length,
    dayCount: book.days.length,
    firstDay: dayNums[0], lastDay: dayNums[dayNums.length - 1],
    withTimeCols: book.days.filter(function (d) { return d.inCol >= 0 && d.outCol >= 0; }).length,
    eventCount: Object.keys(book.events).length,
    markCounts: known, unknownMarks: unknown, blankCount: blank, timeCount: timeCount
  };
}
