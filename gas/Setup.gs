/**
 * 初期化とシート定義、保守用の関数。
 *
 * setup() は、エディタから手動で実行する。
 *  - 存在しないシートとヘッダーを作る（既存のシート・データ・見出しは上書きしない）
 *  - 照合設定の初期値を、足りない項目だけ入れる
 *  - アプリ用スプレッドシートの ID を、スクリプトプロパティ APP_SHEET_ID に保存する
 */

var SHEET_ROSTER = '名簿';
var SHEET_HOMEROOM = '担任';
var SHEET_LOG = '記録';
var SHEET_SETTINGS = '照合設定';
var SHEET_EXCEPTIONS = '例外日';
var SHEET_RESULT = '照合結果';
var SHEET_DRAFT = 'Slack下書き';

var ROSTER_HEADERS = ['児童ID', '名前', 'よみ', '学年', '担任', '在籍', '並び順'];
var HOMEROOM_HEADERS = ['担任名', 'SlackメンバーID', '備考'];
var LOG_HEADERS = ['記録ID', '児童ID', '名前', '学年', '種別', '撮影日時', '受信日時', '写真URL', '端末グループ', '再送'];
var SETTINGS_HEADERS = ['項目', '値'];
var EXCEPTION_HEADERS = ['日付', '通常登校の締切', '通常下校の開始', '照合しない', 'メモ'];
var RESULT_HEADERS = ['キー', '対象月', '日付', '曜日', '児童ID', '名前', '学年', '担任', '行事メモ', 'アプリ登校', 'アプリ下校',
  '本来の記号', '出席簿の記号', '出席簿の時刻', '不一致の種類', '説明', '対応', '担任の回答', 'メモ', 'Slack送信日時'];
var DRAFT_HEADERS = ['対象月', '担任', 'SlackメンバーID', '件数', '下書き', '状態', '送信日時', '対象のキー'];

var RESULT_ACTIONS = ['未確認', '対象外', '事務局で修正', '担任に確認', '完了'];
var RESULT_ACTION_COLORS = { '未確認': '#fff2cc', '対象外': '#e6e6e6', '事務局で修正': '#cfe2f3', '担任に確認': '#fce5cd', '完了': '#d9ead3' };

var SETTINGS_DEFAULTS = [
  ['通常登校の締切', '8:30'],
  ['プール登校の開始', '9:45'],
  ['プール登校の終了', '10:10'],
  ['プールの曜日', '水'],
  ['プール日と判定する行事メモの語', 'プール'],
  ['通常下校の開始', '15:45'],
  ['時刻ずれの許容（分）', '15']
];

/**
 * 初期化。エディタから手動で実行する。
 * 先にスクリプトプロパティ FOLDER_ID / API_TOKEN を設定しておく
 * （ATTENDANCE_BOOK_ID と SLACK_WEBHOOK_URL は、照合機能を使うときに設定。未設定でもよい）。
 */
function setup() {
  var props = PropertiesService.getScriptProperties();

  var missing = ['FOLDER_ID', 'API_TOKEN'].filter(function (k) { return !props.getProperty(k); });
  if (missing.length) {
    Logger.log('【未設定】スクリプトプロパティを設定してください: ' + missing.join(', '));
    Logger.log('  プロジェクトの設定 → スクリプト プロパティ → 追加');
    Logger.log('  FOLDER_ID : ドライブのフォルダURLの folders/ のあとの文字列');
    Logger.log('  API_TOKEN : ランダムな長い文字列（24文字以上を推奨。iPad の設定画面に入れるものと同じ）');
  }
  ['ATTENDANCE_BOOK_ID', 'SLACK_WEBHOOK_URL'].forEach(function (k) {
    if (!props.getProperty(k)) Logger.log('（任意・未設定）' + k + '：照合機能を使うときに設定します。');
  });

  // バインド先のスプレッドシートを開き、ID を保存する（ウェブアプリ実行時は getActive が使えないため）
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('アプリ用スプレッドシートにバインドしたスクリプトのエディタから実行してください。');
  if (props.getProperty('APP_SHEET_ID') !== ss.getId()) {
    props.setProperty('APP_SHEET_ID', ss.getId());
    Logger.log('APP_SHEET_ID を保存しました。');
  }
  if (ss.getSpreadsheetTimeZone() !== TZ) {
    ss.setSpreadsheetTimeZone(TZ);
    Logger.log('スプレッドシートのタイムゾーンを ' + TZ + ' に変更しました。');
  }

  // シート。既存のシート・データ・見出しは変更しない
  var roster = ensureSheet_(ss, SHEET_ROSTER, ROSTER_HEADERS);
  ensureSheet_(ss, SHEET_HOMEROOM, HOMEROOM_HEADERS);
  var log = ensureSheet_(ss, SHEET_LOG, LOG_HEADERS);
  var settings = ensureSheet_(ss, SHEET_SETTINGS, SETTINGS_HEADERS);
  var exceptions = ensureSheet_(ss, SHEET_EXCEPTIONS, EXCEPTION_HEADERS);
  var result = ensureSheet_(ss, SHEET_RESULT, RESULT_HEADERS);
  ensureSheet_(ss, SHEET_DRAFT, DRAFT_HEADERS);

  // 6桁の児童ID・撮影日時・受信日時を、シートが数値や日時に自動変換しないよう、書式を文字列に固定する
  roster.getRange('A:A').setNumberFormat('@');
  log.getRange('A:B').setNumberFormat('@');
  log.getRange('F:G').setNumberFormat('@');

  fillSettingsDefaults_(settings);
  prepareExceptions_(exceptions);
  prepareResult_(result);
  removeEmptyDefaultSheet_(ss);
  checkRosterHeaders_(roster);
  Logger.log('シートを確認しました: ' + ss.getName());

  if (props.getProperty('FOLDER_ID')) {
    var folder = DriveApp.getFolderById(props.getProperty('FOLDER_ID'));
    Logger.log('写真フォルダを確認しました: ' + folder.getName() + '（共有設定: ' + folder.getSharingAccess() + '）');
    if (folder.getSharingAccess() !== DriveApp.Access.PRIVATE) {
      Logger.log('【注意】このフォルダはリンク共有などで公開されています。スタッフ以外が見られないか確認してください。');
    }
  }

  var token = props.getProperty('API_TOKEN');
  if (token && token.length < 24) Logger.log('【注意】API_TOKEN が短すぎます。24文字以上を推奨します。');
}

/** シートがなければ、見出しつきで作る。あっても、データや見出しは書き換えない（違いがあればログに出す）。 */
function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  var created = false;
  if (!sheet) { sheet = ss.insertSheet(name); created = true; }
  var range = sheet.getRange(1, 1, 1, headers.length);
  var current = range.getValues()[0];
  var empty = current.every(function (v) { return v === ''; });
  if (created || empty) {
    range.setValues([headers]);
    range.setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else if (current.join('|') !== headers.join('|')) {
    Logger.log('【注意】シート「' + name + '」の見出しが想定と違います（変更しません）。想定：' + headers.join(' / '));
  }
  return sheet;
}

/** 名簿に必要な見出しが足りているか確認して、ログに出す（名簿は人が管理するので、変更しない）。 */
function checkRosterHeaders_(sheet) {
  var header = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(function (v) { return String(v).trim(); });
  var lacking = ROSTER_HEADERS.filter(function (h) { return header.indexOf(h) < 0; });
  if (lacking.length) {
    Logger.log('【注意】名簿の見出しに次の列がありません: ' + lacking.join(', '));
    if (lacking.indexOf('担任') >= 0) Logger.log('  → 「担任」列は、在籍の列の左（E列）に挿入してください（列の順番は、見出し名で判断します）。');
  }
}

/** 照合設定：足りない項目だけ初期値を入れる（すでにある項目の値は変えない）。 */
function fillSettingsDefaults_(sheet) {
  sheet.getRange('B:B').setNumberFormat('@'); // 「8:30」が時刻に変換されないように
  var last = sheet.getLastRow();
  var existing = last >= 2 ? sheet.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); }) : [];
  SETTINGS_DEFAULTS.forEach(function (d) {
    if (existing.indexOf(d[0]) >= 0) return;
    var row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1, 1, 2).setNumberFormat('@').setValues([d]);
    existing.push(d[0]);
  });
  sheet.setColumnWidth(1, 260);
}

/** 例外日：日付と時刻の書式、「照合しない」のチェックボックス。 */
function prepareExceptions_(sheet) {
  sheet.getRange('A2:A500').setNumberFormat('yyyy/MM/dd');
  sheet.getRange('B2:C500').setNumberFormat('@');
  sheet.getRange('D2:D500').insertCheckboxes();
}

/** 照合結果：「対応」のプルダウンと、対応の値による行の色（条件付き書式）。 */
function prepareResult_(sheet) {
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('E:E').setNumberFormat('@');
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(RESULT_ACTIONS, true).setAllowInvalid(false).build();
  sheet.getRange('Q2:Q5000').setDataValidation(rule);
  var area = sheet.getRange('A2:T5000');
  var rules = RESULT_ACTIONS.map(function (a) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$Q2="' + a + '"')
      .setBackground(RESULT_ACTION_COLORS[a])
      .setRanges([area])
      .build();
  });
  sheet.setConditionalFormatRules(rules);
}

function removeEmptyDefaultSheet_(ss) {
  ['シート1', 'Sheet1'].forEach(function (n) {
    var s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });
}

// ───────────────────────── 保守用（手動実行） ─────────────────────────

/** 動作確認用のダミー名簿（架空の児童6名・各学年1名）を入れる。名簿が空のときだけ書き込む。 */
function addSampleRoster() {
  var sheet = getSheet_(SHEET_ROSTER);
  if (sheet.getLastRow() > 1) {
    Logger.log('名簿にすでにデータがあるため、何もしません。');
    return;
  }
  var col = rosterColumns_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
  var rows = [
    ['900001', '試験 一郎', 'しけん いちろう', 1],
    ['900002', '試験 花子', 'しけん はなこ', 2],
    ['900003', '試験 三郎', 'しけん さぶろう', 3],
    ['900004', '試験 良子', 'しけん よしこ', 4],
    ['900005', '試験 五郎', 'しけん ごろう', 5],
    ['900006', '試験 六子', 'しけん ろくこ', 6]
  ].map(function (r, i) {
    var out = [];
    var put = function (idx, v) { if (idx !== undefined) out[idx] = v; };
    put(col.id, r[0]); put(col.name, r[1]); put(col.yomi, r[2]); put(col.grade, r[3]);
    put(col.homeroom, 'テスト担任'); put(col.enrolled, true); put(col.order, 1);
    for (var k = 0; k < out.length; k++) if (out[k] === undefined) out[k] = '';
    return out;
  });
  var width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
  rows.forEach(function (r) { while (r.length < width) r.push(''); });
  sheet.getRange(2, 1, rows.length, width).setValues(rows);
  Logger.log('ダミーの名簿（児童ID 900001〜900006）を入れました。動作確認が済んだら削除してください。');
}

/**
 * 写真フォルダの共有状態を詳しくログに出す。
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
