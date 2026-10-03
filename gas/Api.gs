/**
 * とうげこう API（iPad 用）
 *
 * 画面は持たない。iPad のWebアプリ（docs/）から fetch で呼ばれる JSON API。
 * アプリ用スプレッドシートにバインドしたスクリプトとして動く。
 * 設定値（APP_SHEET_ID / FOLDER_ID / API_TOKEN ほか）はスクリプトプロパティに保存する。コードには書かない。
 *
 * 他のファイル：Setup.gs（初期化・シート定義・保守用）／ AttendanceBook.gs・Reconcile.gs・Slack.gs・Menu.gs（照合機能）
 */

var TZ = 'Asia/Tokyo';
var GROUP_GRADES = { '12': [1, 2], '34': [3, 4], '56': [5, 6] };
var TYPES = ['登校', '下校'];
var STATUS_BEFORE = '未登校';
var STATUS_PRESENT = '登校中';
var STATUS_DONE = '下校済み';

var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
var TODAY_SCAN_ROWS = 1000; // action=today で記録シートの末尾から読む最大行数

// ───────────────────────── エンドポイント ─────────────────────────

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (!isAuthorized_(p.token)) return json_({ ok: false, error: 'unauthorized' });

    var group = String(p.group || '');
    if (!GROUP_GRADES[group]) return json_({ ok: false, error: 'invalid_group' });

    if (p.action === 'roster') {
      return json_({ ok: true, group: group, children: getRoster_(group) });
    }
    if (p.action === 'today') {
      return json_(getToday_(group));
    }
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return serverError_(err);
  }
}

function doPost(e) {
  try {
    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return json_({ ok: false, error: 'invalid_json' });
    }
    if (!body || !isAuthorized_(body.token)) return json_({ ok: false, error: 'unauthorized' });

    var v = validateRecord_(body);
    if (v.error) return json_({ ok: false, error: v.error });

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return json_({ ok: false, error: 'busy' });
    try {
      return json_(saveRecord_(v));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return serverError_(err);
  }
}

// ───────────────────────── 記録の保存 ─────────────────────────

function validateRecord_(b) {
  var recordId = String(b.recordId || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(recordId)) return { error: 'invalid_record_id' };

  var type = String(b.type || '');
  if (TYPES.indexOf(type) < 0) return { error: 'invalid_type' };

  var capturedAt = String(b.capturedAt || '');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(capturedAt)) return { error: 'invalid_captured_at' };

  var group = String(b.group || '');
  if (!GROUP_GRADES[group]) return { error: 'invalid_group' };

  var childId = String(b.childId || '').trim();
  var child = findChild_(childId);
  if (!child) return { error: 'unknown_child' };

  var m = /^(?:data:image\/jpeg;base64,)?([A-Za-z0-9+\/=\s]+)$/.exec(String(b.imageBase64 || ''));
  if (!m) return { error: 'invalid_image' };
  var bytes;
  try {
    bytes = Utilities.base64Decode(m[1].replace(/\s/g, ''));
  } catch (decodeErr) {
    return { error: 'invalid_image' };
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return { error: 'invalid_image' };

  return {
    recordId: recordId,
    child: child,
    type: type,
    capturedAt: capturedAt,
    group: group,
    resent: b.resent === true,
    bytes: bytes
  };
}

/** ロック内で呼ぶこと。 */
function saveRecord_(v) {
  var sheet = getSheet_(SHEET_LOG);

  // 再送による二重記録を防ぐ
  if (sheet.getLastRow() > 1) {
    var hit = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
      .createTextFinder(v.recordId).matchEntireCell(true).findNext();
    if (hit) return { ok: true, duplicate: true };
  }

  var day = v.capturedAt.substring(0, 10);
  var time = v.capturedAt.substring(11).replace(/:/g, '');
  var safeName = v.child.name.replace(/[\\\/:*?"<>|]/g, '_');
  var fileName = time + '_' + v.child.id + '_' + safeName + '_' + v.type + '.jpg';

  // 共有設定は変更しない（親フォルダの権限を継承 → スタッフだけが閲覧できる）
  var folder = getDayFolder_(day);
  var file = folder.createFile(Utilities.newBlob(v.bytes, 'image/jpeg', fileName));

  var received = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  // appendRow は、日時や数字に見える文字列（6桁の児童ID・撮影日時など）を自動変換するため、
  // 先に対象セルを文字列書式にしてから setValues で書く
  var row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, 2).setNumberFormat('@');
  sheet.getRange(row, 6, 1, 2).setNumberFormat('@');
  sheet.getRange(row, 1, 1, LOG_HEADERS.length).setValues([[
    v.recordId, v.child.id, v.child.name, v.child.grade, v.type,
    v.capturedAt, received, file.getUrl(), v.group, v.resent
  ]]);
  return { ok: true };
}

function getDayFolder_(day) {
  var root = DriveApp.getFolderById(prop_('FOLDER_ID'));
  var it = root.getFoldersByName(day);
  return it.hasNext() ? it.next() : root.createFolder(day);
}

// ───────────────────────── 名簿・今日の状態 ─────────────────────────

/**
 * 名簿の見出し行から、各項目の列の位置を求める（列の順番に依存しない）。
 * 「担任」「よみ」「並び順」は無くてもよい。「児童ID」「名前」「学年」「在籍」は必須。
 */
function rosterColumns_(headerRow) {
  var idx = {};
  for (var i = 0; i < headerRow.length; i++) {
    var k = String(headerRow[i]).trim();
    if (k && idx[k] === undefined) idx[k] = i;
  }
  var missing = ['児童ID', '名前', '学年', '在籍'].filter(function (k) { return idx[k] === undefined; });
  if (missing.length) throw new Error('名簿の見出しがありません: ' + missing.join(', '));
  return {
    id: idx['児童ID'], name: idx['名前'], yomi: idx['よみ'], grade: idx['学年'],
    homeroom: idx['担任'], enrolled: idx['在籍'], order: idx['並び順']
  };
}

/** 名簿シートの全児童（在籍に関係なく）を返す。 */
function readRosterRows_() {
  var sheet = getSheet_(SHEET_ROSTER);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(1, 1, last, Math.max(sheet.getLastColumn(), 1)).getValues();
  var col = rosterColumns_(values[0]);
  var cell = function (r, i) { return i === undefined ? '' : r[i]; };
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var id = String(r[col.id]).trim();
    if (!id) continue;
    var rawOrder = cell(r, col.order);
    var order = rawOrder === '' ? NaN : Number(rawOrder);
    rows.push({
      id: id,
      name: String(r[col.name]).trim(),
      yomi: String(cell(r, col.yomi)).trim(),
      grade: Number(r[col.grade]),
      homeroom: String(cell(r, col.homeroom)).trim(),
      enrolled: r[col.enrolled] === true || String(r[col.enrolled]).trim().toUpperCase() === 'TRUE',
      // 並び順が空の子は、並び順のある子のあとに名簿の行順で並べる
      sort: isNaN(order) ? 1e6 + i : order,
      row: i
    });
  }
  return rows;
}

function findChild_(childId) {
  var rows = readRosterRows_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === childId) return rows[i];
  }
  return null;
}

function getRoster_(group) {
  var grades = GROUP_GRADES[group];
  return readRosterRows_()
    .filter(function (c) { return c.enrolled && grades.indexOf(c.grade) >= 0; })
    .sort(function (a, b) { return a.grade - b.grade || a.sort - b.sort || a.row - b.row; })
    .map(function (c, idx) {
      return { childId: c.id, name: c.name, yomi: c.yomi, grade: c.grade, order: idx + 1 };
    });
}

function getToday_(group) {
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var children = getRoster_(group);
  var byId = {};
  children.forEach(function (c) {
    byId[c.childId] = { childId: c.childId, status: STATUS_BEFORE, arrivedAt: null, departedAt: null };
  });

  var sheet = getSheet_(SHEET_LOG);
  var last = sheet.getLastRow();
  if (last >= 2) {
    var n = Math.min(last - 1, TODAY_SCAN_ROWS);
    var rows = sheet.getRange(last - n + 1, 1, n, 6).getValues(); // A〜F
    var sheetTz = sheet.getParent().getSpreadsheetTimeZone();
    rows.forEach(function (r) {
      var s = byId[String(r[1]).trim()];
      if (!s) return;
      var at = cellToDateTime_(r[5], sheetTz);
      if (at.substring(0, 10) !== today) return;
      if (r[4] === '登校') {
        if (!s.arrivedAt || at < s.arrivedAt) s.arrivedAt = at;
      } else if (r[4] === '下校') {
        if (!s.departedAt || at > s.departedAt) s.departedAt = at;
      }
    });
  }

  var states = children.map(function (c) {
    var s = byId[c.childId];
    if (s.departedAt) s.status = STATUS_DONE;
    else if (s.arrivedAt) s.status = STATUS_PRESENT;
    return s;
  });
  return {
    ok: true,
    group: group,
    date: today,
    serverTime: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
    states: states
  };
}

/**
 * セルの値（文字列、またはシートが日時に自動変換した Date）を yyyy-MM-dd HH:mm:ss にそろえる。
 * Date のときは、セルに見えている時刻（スプレッドシートのタイムゾーン）をそのまま読む。
 */
function cellToDateTime_(v, sheetTz) {
  if (v instanceof Date) return Utilities.formatDate(v, sheetTz || TZ, 'yyyy-MM-dd HH:mm:ss');
  return String(v);
}

// ───────────────────────── 共通部品 ─────────────────────────

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function serverError_(err) {
  // 合言葉や写真データを含めないよう、メッセージだけをログに残す
  console.error('server_error: ' + (err && err.message));
  return json_({ ok: false, error: 'server_error' });
}

function prop_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('script property not set: ' + key);
  return v;
}

function isAuthorized_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!expected || typeof token !== 'string' || token.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/** アプリ用スプレッドシート。ウェブアプリ実行時は getActive が使えないため、setup() で保存した ID から開く。 */
function getAppSpreadsheet_() {
  return SpreadsheetApp.openById(prop_('APP_SHEET_ID'));
}

function getSheet_(name) {
  var sheet = getAppSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('sheet not found: ' + name + '（setup() を実行してください）');
  return sheet;
}
