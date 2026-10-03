/**
 * Slack への確認の下書きと投稿（CLAUDE.md 8-7）。
 *
 * ■ 守ること
 *  - Slack の文面には、名前・日付・時刻・記号だけを入れる（写真・写真URLは入れない）。
 *  - SLACK_WEBHOOK_URL は、ログにも、メッセージにも出さない。
 *  - 投稿は、事務局が、確認ダイアログで OK したものだけ。下書きのセルを直接直した文面が、そのまま投稿される。
 *  - SLACK_WEBHOOK_URL が未設定のときは投稿しない（下書きのセルをコピーして、Slack に貼り付けてもらう）。
 */

var DRAFT_COL = { month: 0, teacher: 1, memberId: 2, count: 3, text: 4, status: 5, sentAt: 6, keys: 7 };
var DRAFT_STATE_DRAFT = '下書き';
var DRAFT_STATE_SENT = '送信済み';
var NO_HOMEROOM = '（担任未設定）';

// ───────────────────────── 下書きの作成（純粋な関数） ─────────────────────────

/** 'yyyy/MM/dd' を '11/5' の形にする。 */
function monthDayLabel_(dateStr) {
  var m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(dateStr).trim());
  return m ? Number(m[2]) + '/' + Number(m[3]) : String(dateStr);
}

/**
 * 照合結果の行（A〜T）から、担任ごとの下書きを作る。
 * 対象：対象月が yymm で、対応が「担任に確認」で、Slack送信日時が空の行。
 * @param {Array} rows 照合結果の行（A〜T、文字列）
 * @param {Object} homeroomIds 担任名 → SlackメンバーID
 * @return {Array} [{teacher, memberId, count, text, keys}]（担任名の順）
 */
function buildDrafts_(rows, homeroomIds, yymm) {
  var groups = {};
  var order = [];
  rows.forEach(function (r) {
    if (String(r[RC.key]).split('|')[0] !== String(yymm)) return;
    if (String(r[RC.action]) !== '担任に確認') return;
    if (String(r[RC.sentAt]).trim() !== '') return;
    var teacher = String(r[RC.homeroom]).trim() || NO_HOMEROOM;
    if (!groups[teacher]) { groups[teacher] = []; order.push(teacher); }
    groups[teacher].push(r);
  });
  var month = Number(String(yymm).slice(2, 4));
  return order.map(function (teacher) {
    var list = groups[teacher].slice().sort(function (a, b) {
      return String(a[RC.date]) < String(b[RC.date]) ? -1 : String(a[RC.date]) > String(b[RC.date]) ? 1
        : String(a[RC.id]) < String(b[RC.id]) ? -1 : String(a[RC.id]) > String(b[RC.id]) ? 1 : 0;
    });
    var memberId = (homeroomIds[teacher] || '').trim();
    var mention = memberId ? '<@' + memberId + '>' : (teacher === NO_HOMEROOM ? '【担任未設定】' : teacher + '先生');
    var lines = list.map(function (r) {
      var desc = String(r[RC.desc]).replace(RESOLVED_PREFIX, '');
      return '・' + monthDayLabel_(r[RC.date]) + '(' + r[RC.weekday] + ') ' + r[RC.name] + 'さん：' + desc;
    });
    var text = mention + ' ' + month + '月の登下校の照合で、確認したい記録が' + list.length + '件あります。\n' +
      lines.join('\n') + '\nこのスレッドで、正しい記録を教えてください。';
    return { teacher: teacher, memberId: memberId, count: list.length, text: text, keys: list.map(function (r) { return String(r[RC.key]); }) };
  });
}

/**
 * 既存の下書きシートの行（A〜H）に、新しい下書きを反映する計画を作る（純粋な関数）。
 *  - 同じ月・同じ担任の「下書き」の行があれば上書きする。
 *  - 「送信済み」の行は触らない（同じ月・同じ担任でも、新しい下書きは別の行にする）。
 * @return {{updates: Array, appends: Array}} updates: [{index(0始まり), values}], appends: [values]
 */
function planDraftUpserts_(existing, drafts, yymm) {
  var updates = [], appends = [];
  var claimed = {};
  drafts.forEach(function (d) {
    var values = [String(yymm), d.teacher, d.memberId, d.count, d.text, DRAFT_STATE_DRAFT, '', d.keys.join(',')];
    var found = -1;
    for (var i = 0; i < existing.length; i++) {
      var r = existing[i];
      if (!claimed[i] && String(r[DRAFT_COL.month]) === String(yymm) && String(r[DRAFT_COL.teacher]) === d.teacher &&
        String(r[DRAFT_COL.status]) === DRAFT_STATE_DRAFT) { found = i; break; }
    }
    if (found >= 0) { claimed[found] = true; updates.push({ index: found, values: values }); }
    else appends.push(values);
  });
  return { updates: updates, appends: appends };
}

/** 担任シートの値（A:担任名, B:SlackメンバーID）から、担任名 → メンバーID の表を作る。 */
function homeroomIdMap_(rows) {
  var map = {};
  rows.forEach(function (r) {
    var name = String(r[0]).trim();
    if (name) map[name] = String(r[1]).trim();
  });
  return map;
}

// ───────────────────────── 投稿 ─────────────────────────

/**
 * Incoming Webhook に1件投稿する。URL は、返す値にも、エラーメッセージにも含めない。
 * @return {{ok: boolean, code: number, error: string}}
 */
function postToSlack_(webhookUrl, text) {
  try {
    var resp = UrlFetchApp.fetch(webhookUrl, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify({ text: text }), muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    return { ok: code >= 200 && code < 300, code: code, error: code >= 200 && code < 300 ? '' : 'HTTP ' + code };
  } catch (e) {
    return { ok: false, code: 0, error: String(e && e.message).split(webhookUrl).join('[URL]') };
  }
}

/**
 * 下書き（選択された行）を順に投稿する。
 * @param {Array} items [{row, teacher, text, keys}]
 * @return {Array} [{row, teacher, ok, error}]
 */
function postDrafts_(items, webhookUrl) {
  var results = [];
  items.forEach(function (it, i) {
    if (i > 0) Utilities.sleep(1000); // 続けて送りすぎない
    var r = postToSlack_(webhookUrl, it.text);
    results.push({ row: it.row, teacher: it.teacher, keys: it.keys, ok: r.ok, error: r.error });
  });
  return results;
}

// ───────────────────────── シートの読み書き（メニューから呼ばれる） ─────────────────────────

/** 対応が「担任に確認」の行から、担任ごとの下書きを作って、Slack下書きシートに書く。 */
function createSlackDrafts_(yymm) {
  var ss = getAppSpreadsheet_();
  var result = getSheet_(SHEET_RESULT);
  var last = result.getLastRow();
  var rows = last >= 2 ? result.getRange(2, 1, last - 1, 20).getDisplayValues() : [];
  var hs = ss.getSheetByName(SHEET_HOMEROOM);
  var hRows = hs && hs.getLastRow() >= 2 ? hs.getRange(2, 1, hs.getLastRow() - 1, 2).getDisplayValues() : [];
  var ids = homeroomIdMap_(hRows);
  var drafts = buildDrafts_(rows, ids, yymm);

  var sheet = getSheet_(SHEET_DRAFT);
  var dl = sheet.getLastRow();
  var existing = dl >= 2 ? sheet.getRange(2, 1, dl - 1, 8).getValues() : [];
  var plan = planDraftUpserts_(existing, drafts, yymm);
  plan.updates.forEach(function (u) {
    var range = sheet.getRange(u.index + 2, 1, 1, 8);
    range.setNumberFormat('@');
    range.setValues([u.values]);
    sheet.getRange(u.index + 2, DRAFT_COL.count + 1).setNumberFormat('0').setValue(u.values[DRAFT_COL.count]);
  });
  if (plan.appends.length) {
    var start = sheet.getLastRow() + 1;
    sheet.getRange(start, 1, plan.appends.length, 8).setNumberFormat('@');
    sheet.getRange(start, 1, plan.appends.length, 8).setValues(plan.appends);
    sheet.getRange(start, DRAFT_COL.count + 1, plan.appends.length, 1).setNumberFormat('0');
  }
  SpreadsheetApp.flush();
  var noId = drafts.filter(function (d) { return !d.memberId; }).map(function (d) { return d.teacher; });
  return { drafts: drafts, created: plan.appends.length, overwritten: plan.updates.length, noMemberId: noId };
}

/** Slack下書きシートで選択している行（複数可）の、「下書き」状態の行を返す。 */
function selectedDraftItems_(sheet) {
  var ranges = sheet.getActiveRangeList() ? sheet.getActiveRangeList().getRanges() : [sheet.getActiveRange()];
  var rowSet = {};
  ranges.forEach(function (rg) {
    for (var r = rg.getRow(); r < rg.getRow() + rg.getNumRows(); r++) if (r >= 2) rowSet[r] = true;
  });
  var items = [];
  var skipped = 0;
  sortedNumbers_(Object.keys(rowSet)).forEach(function (row) {
    var v = sheet.getRange(row, 1, 1, 8).getValues()[0];
    if (!String(v[DRAFT_COL.teacher]).trim()) return;
    if (String(v[DRAFT_COL.status]) !== DRAFT_STATE_DRAFT) { skipped++; return; }
    items.push({ row: row, month: String(v[DRAFT_COL.month]), teacher: String(v[DRAFT_COL.teacher]), count: v[DRAFT_COL.count],
      text: String(v[DRAFT_COL.text]), keys: String(v[DRAFT_COL.keys]).split(',').filter(Boolean) });
  });
  return { items: items, skipped: skipped };
}

/** 投稿できた下書きの状態を「送信済み」にし、照合結果の該当行のSlack送信日時を記入する。 */
function markDraftsSent_(sheet, results, nowStr) {
  var result = getSheet_(SHEET_RESULT);
  var last = result.getLastRow();
  var keyRows = {};
  if (last >= 2) result.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, i) { keyRows[String(r[0])] = i + 2; });
  results.forEach(function (r) {
    if (!r.ok) return;
    var range = sheet.getRange(r.row, DRAFT_COL.status + 1, 1, 2);
    range.setNumberFormat('@');
    range.setValues([[DRAFT_STATE_SENT, nowStr]]);
    (r.keys || []).forEach(function (k) {
      if (keyRows[k]) {
        var cell = result.getRange(keyRows[k], RC.sentAt + 1);
        cell.setNumberFormat('@');
        cell.setValue(nowStr);
      }
    });
  });
  SpreadsheetApp.flush();
}
