/**
 * スプレッドシートのメニュー「照合」（事務局用）。
 *   1. 月を選んで照合
 *   2. Slack下書きを作成
 *   3. 選択した下書きをSlackに投稿
 *
 * このファイルは出席簿を直接は触らない（照合は Reconcile.gs が readAttendanceMonth() を通して読み取るだけ）。
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('照合')
    .addItem('月を選んで照合', 'menuReconcile')
    .addItem('Slack下書きを作成', 'menuCreateDrafts')
    .addItem('選択した下書きをSlackに投稿', 'menuPostSelectedDrafts')
    .addToUi();
}

// ───────────────────────── 画面の部品 ─────────────────────────

/** ダイアログを出す。エディタから実行したとき（画面がないとき）は、ログに出す。 */
function alert_(title, message) {
  try {
    SpreadsheetApp.getUi().alert(title, message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    Logger.log('【' + title + '】' + message);
  }
}

/** はい・いいえの確認。エディタから実行したときは、いいえ（false）にする（勝手に投稿しない）。 */
function confirm_(title, message) {
  try {
    var ui = SpreadsheetApp.getUi();
    return ui.alert(title, message, ui.ButtonSet.OK_CANCEL) === ui.Button.OK;
  } catch (e) {
    Logger.log('【' + title + '】' + message + '（画面がないため、実行しませんでした）');
    return false;
  }
}

/** 月の入力（yymm）。キャンセルや、形式の違いは null。 */
function promptYymm_(title) {
  var ui = SpreadsheetApp.getUi();
  var suggest = suggestYymm_(new Date());
  var r = ui.prompt(title, '対象の月を、4桁（年の下2桁＋月）で入力してください。例：2026年11月 → 2611\n（いまなら ' + suggest + ' が候補です）', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return null;
  var v = String(r.getResponseText()).trim();
  if (!/^\d{4}$/.test(v) || Number(v.slice(2)) < 1 || Number(v.slice(2)) > 12) {
    ui.alert('月の形式が違います', '「' + v + '」は、年の下2桁＋月の4桁（例：2611）ではありません。', ui.ButtonSet.OK);
    return null;
  }
  return v;
}

/** 月末か翌月初めに実行する想定：20日以降はその月、19日までは前の月を、候補にする。 */
function suggestYymm_(now) {
  var p = Utilities.formatDate(now, TZ, 'yyyy-MM-dd').split('-').map(Number);
  var y = p[0], m = p[1];
  if (p[2] < 20) { m -= 1; if (m < 1) { m = 12; y -= 1; } }
  return String(y).slice(2) + ('0' + m).slice(-2);
}

// ───────────────────────── 1. 月を選んで照合 ─────────────────────────

function menuReconcile() {
  var yymm = promptYymm_('月を選んで照合');
  if (!yymm) return;
  var out;
  try {
    out = runReconcileAndWrite_(yymm);
  } catch (e) {
    alert_('照合できませんでした', String(e && e.message));
    return;
  }
  var sm = out.res.summary;
  var lines = [];
  lines.push(yymm + ' の照合が終わりました。');
  lines.push('対象日 ' + sm.targetDays.length + '日、児童 ' + sm.childrenChecked + '人。');
  lines.push('不一致 ' + out.res.mismatches.length + '件（' + [1, 2, 3, 4, 5].map(function (t) { return MISMATCH_CIRCLED[t] + sm.counts[t]; }).join(' ') + '）');
  lines.push('新規 ' + out.stats.added + '件、更新 ' + out.stats.updated + '件、解消 ' + out.stats.resolved + '件' + (out.stats.reopened ? '、再発 ' + out.stats.reopened + '件' : '') + '。');
  if (out.openBefore.unconfirmed || out.openBefore.askTeacher) {
    lines.push('');
    lines.push('【前月以前に、対応が済んでいない記録があります】未確認 ' + out.openBefore.unconfirmed + '件、担任に確認 ' + out.openBefore.askTeacher + '件。');
  }
  if (sm.notInBook.length) lines.push('\n名簿にいるが、出席簿にいない児童が ' + sm.notInBook.length + '人います（照合していません）：' + sm.notInBook.slice(0, 10).join(', ') + (sm.notInBook.length > 10 ? ' ほか' : ''));
  var um = Object.keys(sm.unknownMarks);
  if (um.length) lines.push('\n出席簿に、想定外の記号があります（比較していません）：' + um.map(function (m) { return '「' + m + '」' + sm.unknownMarks[m] + '件'; }).join(' '));
  if (out.res.warnings.length) lines.push('\n【警告】' + out.res.warnings.slice(0, 3).join(' / '));
  try { var ss = getAppSpreadsheet_(); ss.setActiveSheet(ss.getSheetByName(SHEET_RESULT)); } catch (e) { /* 画面がないときは何もしない */ }
  alert_('照合', lines.join('\n'));
}

// ───────────────────────── 2. Slack下書きを作成 ─────────────────────────

function menuCreateDrafts() {
  var yymm = promptYymm_('Slack下書きを作成');
  if (!yymm) return;
  var out;
  try {
    out = createSlackDrafts_(yymm);
  } catch (e) {
    alert_('下書きを作れませんでした', String(e && e.message));
    return;
  }
  if (!out.drafts.length) {
    alert_('Slack下書き', yymm + ' に、対応が「担任に確認」で、まだ Slack に送っていない記録は、ありません。\n照合結果シートの「対応」を確認してください。');
    return;
  }
  var lines = [yymm + ' の下書きを、担任 ' + out.drafts.length + '人分作りました（新規 ' + out.created + '、上書き ' + out.overwritten + '）。'];
  lines.push(out.drafts.map(function (d) { return d.teacher + '：' + d.count + '件'; }).join('\n'));
  if (out.noMemberId.length) lines.push('\n【SlackメンバーIDがありません】' + out.noMemberId.join('、') + '\n「担任」シートに登録すると、メンションが付きます（いまは担任名だけの文面です）。');
  lines.push('\n文面は、Slack下書きシートの「下書き」のセルで、直接直せます。');
  try { var ss = getAppSpreadsheet_(); ss.setActiveSheet(ss.getSheetByName(SHEET_DRAFT)); } catch (e) { /* 画面がないときは何もしない */ }
  alert_('Slack下書き', lines.join('\n'));
}

// ───────────────────────── 3. 選択した下書きをSlackに投稿 ─────────────────────────

function menuPostSelectedDrafts() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== SHEET_DRAFT) {
    alert_('Slackに投稿', 'シート「' + SHEET_DRAFT + '」を開いて、投稿する行を選択してから、もう一度実行してください。');
    return;
  }
  var sel = selectedDraftItems_(sheet);
  if (!sel.items.length) {
    alert_('Slackに投稿', '投稿できる行が選択されていません。状態が「' + DRAFT_STATE_DRAFT + '」の行を選んでください' + (sel.skipped ? '（「送信済み」の行は、投稿しません）。' : '。'));
    return;
  }
  var webhook = cleanWebhookUrl_(PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL'));
  if (!webhook) {
    alert_('Slackに投稿', 'Slack の投稿先（Webhook）が、設定されていません。投稿はしませんでした。\n\n下書きのセルをコピーして、Slack に貼り付けてください。\n貼り付けたあと、状態を「' + DRAFT_STATE_SENT + '」に、手で変えてください。');
    return;
  }
  if (!isSlackWebhookUrl_(webhook)) {
    alert_('Slackに投稿', 'スクリプトプロパティ SLACK_WEBHOOK_URL が、Slack の Incoming Webhook の URL ではありません（入っている値のドメイン：' + urlHostOnly_(webhook) +
      '）。投稿はしませんでした。\n\nWebhook の URL は「https://hooks.slack.com/services/…」の形です。チャンネルの URL ではありません。\nSlack の「Incoming Webhooks」で作った URL を、設定し直してください。');
    return;
  }
  var summary = sel.items.map(function (it) { return it.teacher + '：' + it.count + '件'; }).join('\n');
  if (!confirm_('Slackに投稿しますか？', '次の ' + sel.items.length + '人宛てに、Slack に投稿します。\n\n' + summary + '\n\n投稿すると、取り消せません。')) return;

  var results = postDrafts_(sel.items, webhook);
  var nowStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  markDraftsSent_(sheet, results, nowStr);
  var ok = results.filter(function (r) { return r.ok; });
  var ng = results.filter(function (r) { return !r.ok; });
  var msg = ok.length + '件を投稿しました。';
  if (ng.length) {
    msg += '\n\n【投稿できませんでした】\n' + ng.map(function (r) { return r.teacher + '（' + r.error + '）'; }).join('\n') + '\n状態は「' + DRAFT_STATE_DRAFT + '」のままです。';
    var hints = [];
    ng.forEach(function (r) { var h = slackErrorHint_(r.code, r.reason); if (h && hints.indexOf(h) < 0) hints.push(h); });
    if (hints.length) msg += '\n\n【考えられる原因】\n' + hints.join('\n');
  }
  alert_('Slackに投稿', msg);
}
