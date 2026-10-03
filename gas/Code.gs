/**
 * とうげこう（登下校管理アプリ）API
 *
 * 画面は持たない。iPad のWebアプリ（docs/）から fetch で呼ばれる JSON API。
 * 設定値（SHEET_ID / FOLDER_ID / API_TOKEN）はスクリプトプロパティに保存する。コードには書かない。
 */

var TZ = 'Asia/Tokyo';
var SHEET_ROSTER = '名簿';
var SHEET_LOG = '記録';
var ROSTER_HEADERS = ['児童ID', '名前', 'よみ', '学年', '在籍', '並び順'];
var LOG_HEADERS = ['記録ID', '児童ID', '名前', '学年', '種別', '撮影日時', '受信日時', '写真URL', '端末グループ', '再送'];

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
  // appendRow は書式が文字列でも日時文字列を日付に自動変換するため、
  // 先に対象セルを文字列書式にしてから setValues で書く
  var row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1).setNumberFormat('@');
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

/** 名簿シートの全児童（在籍に関係なく）を返す。 */
function readRosterRows_() {
  var sheet = getSheet_(SHEET_ROSTER);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, 6).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var id = String(r[0]).trim();
    if (!id) continue;
    var order = r[5] === '' ? NaN : Number(r[5]);
    rows.push({
      id: id,
      name: String(r[1]).trim(),
      yomi: String(r[2]).trim(),
      grade: Number(r[3]),
      enrolled: r[4] === true || String(r[4]).trim().toUpperCase() === 'TRUE',
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
      var s = byId[String(r[1])];
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

function getSheet_(name) {
  var sheet = SpreadsheetApp.openById(prop_('SHEET_ID')).getSheetByName(name);
  if (!sheet) throw new Error('sheet not found: ' + name + '（setup() を実行してください）');
  return sheet;
}

// ───────────────────────── 手動実行用 ─────────────────────────

/**
 * 初期化。エディタから手動で実行する。
 * 先にスクリプトプロパティ SHEET_ID / FOLDER_ID / API_TOKEN を設定しておく。
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var missing = ['SHEET_ID', 'FOLDER_ID', 'API_TOKEN'].filter(function (k) { return !props.getProperty(k); });
  if (missing.length) {
    Logger.log('【未設定】スクリプトプロパティを設定してください: ' + missing.join(', '));
    Logger.log('  プロジェクトの設定 → スクリプト プロパティ → 追加');
    Logger.log('  SHEET_ID  : スプレッドシートURLの /d/ と /edit の間の文字列');
    Logger.log('  FOLDER_ID : ドライブのフォルダURLの folders/ のあとの文字列');
    Logger.log('  API_TOKEN : ランダムな長い文字列（24文字以上を推奨）');
  }

  if (props.getProperty('SHEET_ID')) {
    var ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
    if (ss.getSpreadsheetTimeZone() !== TZ) {
      ss.setSpreadsheetTimeZone(TZ);
      Logger.log('スプレッドシートのタイムゾーンを ' + TZ + ' に変更しました。');
    }
    ensureSheet_(ss, SHEET_ROSTER, ROSTER_HEADERS);
    var log = ensureSheet_(ss, SHEET_LOG, LOG_HEADERS);
    // 撮影日時・受信日時をシートが日時に自動変換しないよう、書式を文字列に固定する
    log.getRange('F:G').setNumberFormat('@');
    log.getRange('A:A').setNumberFormat('@');
    removeEmptyDefaultSheet_(ss);
    Logger.log('シート「' + SHEET_ROSTER + '」「' + SHEET_LOG + '」を確認しました: ' + ss.getName());
  }

  if (props.getProperty('FOLDER_ID')) {
    var folder = DriveApp.getFolderById(props.getProperty('FOLDER_ID'));
    Logger.log('写真フォルダを確認しました: ' + folder.getName() +
      '（共有設定: ' + folder.getSharingAccess() + '）');
    if (folder.getSharingAccess() !== DriveApp.Access.PRIVATE) {
      Logger.log('【注意】このフォルダはリンク共有などで公開されています。スタッフ以外が見られないか確認してください。');
    }
  }

  var token = props.getProperty('API_TOKEN');
  if (token && token.length < 24) Logger.log('【注意】API_TOKEN が短すぎます。24文字以上を推奨します。');
}

/**
 * 写真フォルダの共有状態を詳しくログに出す。手動実行用。
 * フォルダ本人と、その親フォルダをたどって共有設定と、権限を持つ人を表示する。
 */
function checkFolderSharing() {
  var folder = DriveApp.getFolderById(prop_('FOLDER_ID'));
  var depth = 0;
  while (folder && depth < 10) {
    Logger.log((depth === 0 ? '【写真フォルダ】' : '【親' + depth + '】') + folder.getName() +
      ' / 共有設定: ' + folder.getSharingAccess() + ' / リンクの権限: ' + folder.getSharingPermission());
    var editors = folder.getEditors().map(function (u) { return u.getEmail(); });
    var viewers = folder.getViewers().map(function (u) { return u.getEmail(); });
    Logger.log('  オーナー: ' + (folder.getOwner() ? folder.getOwner().getEmail() : '（共有ドライブ等）'));
    Logger.log('  編集者: ' + (editors.join(', ') || 'なし'));
    Logger.log('  閲覧者: ' + (viewers.join(', ') || 'なし'));
    var parents = folder.getParents();
    folder = parents.hasNext() ? parents.next() : null;
    depth++;
  }
}

/**
 * 写真フォルダのリンク共有を解除して PRIVATE（権限を付けた人だけ）にする。手動で1回実行する用。
 * 共有を「厳しくする」方向にしか使わない。公開する処理はこのアプリに入れない。
 */
function makeFolderPrivate() {
  var folder = DriveApp.getFolderById(prop_('FOLDER_ID'));
  folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  Logger.log('写真フォルダ「' + folder.getName() + '」の共有設定: ' + folder.getSharingAccess());
}

/** 記録シートの末尾3行を、セルごとの型つきでログに出す。不具合調査用（写真URLは出さない）。 */
function debugLastRecords() {
  var sheet = getSheet_(SHEET_LOG);
  var last = sheet.getLastRow();
  Logger.log('lastRow=' + last + ' / today=' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));
  if (last < 2) return;
  var n = Math.min(last - 1, 3);
  var rows = sheet.getRange(last - n + 1, 1, n, 6).getValues();
  rows.forEach(function (r, i) {
    Logger.log('row ' + (last - n + 1 + i) + ': ' + r.map(function (v, c) {
      return LOG_HEADERS[c] + '=' + JSON.stringify(v) + '(' + (v instanceof Date ? 'Date' : typeof v) + ')';
    }).join(' | '));
  });
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var range = sheet.getRange(1, 1, 1, headers.length);
  var current = range.getValues()[0];
  if (current.join('|') !== headers.join('|')) range.setValues([headers]);
  range.setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

function removeEmptyDefaultSheet_(ss) {
  ['シート1', 'Sheet1'].forEach(function (n) {
    var s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });
}

/** 動作確認用のダミー名簿（架空の児童6名）を入れる。名簿が空のときだけ書き込む。 */
function addSampleRoster() {
  var sheet = getSheet_(SHEET_ROSTER);
  if (sheet.getLastRow() > 1) {
    Logger.log('名簿にすでにデータがあるため、何もしません。');
    return;
  }
  var rows = [
    ['T001', 'テスト いちろう', 'てすと いちろう', 1, true, 1],
    ['T002', 'テスト はなこ', 'てすと はなこ', 2, true, 1],
    ['T003', 'テスト さぶろう', 'てすと さぶろう', 3, true, 1],
    ['T004', 'テスト よしこ', 'てすと よしこ', 4, true, 1],
    ['T005', 'テスト ごろう', 'てすと ごろう', 5, true, 1],
    ['T006', 'テスト ろくこ', 'てすと ろくこ', 6, true, 1]
  ];
  sheet.getRange(2, 1, rows.length, 6).setValues(rows);
  Logger.log('ダミーの名簿を入れました。動作確認が済んだら削除してください。');
}

/**
 * 指定日より前の日付フォルダ（yyyy-MM-dd）をゴミ箱に移す。手動実行用。
 * @param {string|Date} beforeDate この日より前（この日は含まない）のフォルダが対象
 */
function deleteOldPhotos(beforeDate) {
  if (!beforeDate) throw new Error('beforeDate を指定してください（例: "2026-04-01"）');
  var limit = beforeDate instanceof Date
    ? Utilities.formatDate(beforeDate, TZ, 'yyyy-MM-dd')
    : String(beforeDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(limit)) throw new Error('beforeDate は yyyy-MM-dd 形式で指定してください');

  var root = DriveApp.getFolderById(prop_('FOLDER_ID'));
  var it = root.getFolders();
  var count = 0;
  while (it.hasNext()) {
    var f = it.next();
    var n = f.getName();
    if (/^\d{4}-\d{2}-\d{2}$/.test(n) && n < limit) {
      f.setTrashed(true); // ゴミ箱に移すだけ。ドライブのゴミ箱から30日間は復元できる
      Logger.log('ゴミ箱へ: ' + n);
      count++;
    }
  }
  Logger.log(limit + ' より前の日付フォルダ ' + count + ' 件をゴミ箱に移しました。');
}

/** エディタから実行するための入り口。下の日付を書き換えてから実行する。 */
function runDeleteOldPhotos() {
  deleteOldPhotos(''); // 例: deleteOldPhotos('2026-04-01')
}
