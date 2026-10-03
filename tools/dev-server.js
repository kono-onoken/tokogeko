#!/usr/bin/env node
// ローカル確認用サーバー（開発専用）。
//   node tools/dev-server.js
//
//  http://localhost:8080  … docs/ を配信（アプリ本体。カメラは localhost なら HTTPS なしで使える）
//  http://localhost:8787/exec … GAS の代わりをするモック API（roster / today / POST）
//
// アプリの設定画面に次を入れると、本物の GAS なしで一通り試せる：
//   URL: http://localhost:8787/exec    合言葉: test-token
// 記録はメモリ上にだけ保存され、写真は保存しない（再起動で消える）。
const http = require('http');
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const TOKEN = process.env.MOCK_TOKEN || 'test-token';
const APP_PORT = Number(process.env.APP_PORT) || 8080;
const API_PORT = Number(process.env.API_PORT) || 8787;
const GROUPS = { '12': [1, 2], '34': [3, 4], '56': [5, 6] };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

// 架空の児童（動作確認用）
const ROSTER = [
  // 名前は漢字、よみはひらがな（1・2年はよみがふりがなになる）。すべて架空の名前
  ['900101', '山田 太郎', 'やまだ たろう', 1, true], ['900102', '佐藤 梅子', 'さとう うめこ', 1, true],
  ['900103', '鈴木 栄太', 'すずき えいた', 1, true], ['900104', '高橋 音羽', 'たかはし おとは', 2, true],
  ['900105', '伊藤 和樹', 'いとう かずき', 2, true], ['900106', '渡辺 きらら', 'わたなべ きらら', 2, false],
  ['900201', '中村 邦夫', 'なかむら くにお', 3, true], ['900202', '小林 恵子', 'こばやし けいこ', 3, true],
  ['900203', '加藤 幸太', 'かとう こうた', 4, true], ['900204', '吉田 さくら', 'よしだ さくら', 4, true],
  ['900301', '山本 俊', 'やまもと しゅん', 5, true], ['900302', '松本 菫', 'まつもと すみれ', 6, true],
].map(([id, name, yomi, grade, enrolled], i) => ({ id, name, yomi, grade, enrolled, order: i + 1 }));
// 3・4年は16人にして、1グループ15人前後のときの見た目を確認できるようにする
for (let i = 5; i <= 14; i++) {
  const grade = i <= 9 ? 3 : 4;
  ROSTER.push({ id: '9002' + String(i).padStart(2, '0'), name: `テスト ${'あいうえおかきくけこ'[i - 5]}${'たろう'}`, yomi: '', grade, enrolled: true, order: 100 + i });
}
const records = [];

const jst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

function send(res, code, body, headers = {}) {
  res.writeHead(code, Object.assign({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}
const json = (res, obj) => send(res, 200, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

function roster(group) {
  return ROSTER.filter((c) => c.enrolled && GROUPS[group].includes(c.grade))
    .map((c) => ({ childId: c.id, name: c.name, yomi: c.yomi, grade: c.grade, order: c.order }));
}
function todayStates(group) {
  const today = jst().slice(0, 10);
  const states = roster(group).map((c) => {
    const mine = records.filter((r) => r.childId === c.childId && r.capturedAt.startsWith(today));
    const ins = mine.filter((r) => r.type === '登校').map((r) => r.capturedAt).sort();
    const outs = mine.filter((r) => r.type === '下校').map((r) => r.capturedAt).sort();
    const arrivedAt = ins[0] || null, departedAt = outs[outs.length - 1] || null;
    return { childId: c.childId, status: departedAt ? '下校済み' : arrivedAt ? '登校中' : '未登校', arrivedAt, departedAt };
  });
  return { ok: true, group, date: today, serverTime: jst(), states };
}

function api(req, res, url) {
  if (req.method === 'GET') {
    const q = url.searchParams;
    if (q.get('token') !== TOKEN) return json(res, { ok: false, error: 'unauthorized' });
    const group = q.get('group');
    if (!GROUPS[group]) return json(res, { ok: false, error: 'invalid_group' });
    if (q.get('action') === 'roster') return json(res, { ok: true, group, children: roster(group) });
    if (q.get('action') === 'today') return json(res, todayStates(group));
    return json(res, { ok: false, error: 'unknown_action' });
  }
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let b;
      try { b = JSON.parse(raw); } catch (e) { return json(res, { ok: false, error: 'invalid_json' }); }
      if (b.token !== TOKEN) return json(res, { ok: false, error: 'unauthorized' });
      if (!/^[A-Za-z0-9-]{8,64}$/.test(String(b.recordId))) return json(res, { ok: false, error: 'invalid_record_id' });
      if (!['登校', '下校'].includes(b.type)) return json(res, { ok: false, error: 'invalid_type' });
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(b.capturedAt))) return json(res, { ok: false, error: 'invalid_captured_at' });
      if (!GROUPS[b.group]) return json(res, { ok: false, error: 'invalid_group' });
      const child = ROSTER.find((c) => c.id === b.childId);
      if (!child) return json(res, { ok: false, error: 'unknown_child' });
      if (!/^data:image\/jpeg;base64,/.test(String(b.imageBase64))) return json(res, { ok: false, error: 'invalid_image' });
      if (records.some((r) => r.recordId === b.recordId)) return json(res, { ok: true, duplicate: true });
      records.push({ recordId: b.recordId, childId: child.id, name: child.name, type: b.type, capturedAt: b.capturedAt, receivedAt: jst(), group: b.group, resent: b.resent === true, imageBytes: b.imageBase64.length });
      console.log(`[mock] 記録 ${child.id} ${b.type} ${b.capturedAt}${b.resent ? ' (再送)' : ''}  計${records.length}件`);
      return json(res, { ok: true });
    });
    return;
  }
  send(res, 204, '');
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(DOCS, p);
  if (!file.startsWith(DOCS)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

http.createServer((req, res) => serveStatic(req, res, new URL(req.url, 'http://x'))).listen(APP_PORT, () => console.log(`アプリ   http://localhost:${APP_PORT}`));
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__records') return json(res, { records });
  if (url.pathname === '/__reset') { records.length = 0; return json(res, { ok: true }); }
  api(req, res, url);
}).listen(API_PORT, () => console.log(`モックAPI http://localhost:${API_PORT}/exec （合言葉: ${TOKEN}）`));
