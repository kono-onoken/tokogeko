# とうげこう（登下校管理アプリ）

Tokyo Community School の登下校を、iPad で子ども自身が記録するためのアプリです。
顔写真つきで登校・下校を記録し、Google スプレッドシート／ドライブに保存します。

- 画面（フロント）：PWA（素の HTML/CSS/JS）。GitHub Pages で公開
- 記録（バックエンド）：Google Apps Script（API 専用）＋ スプレッドシート ＋ ドライブ
- 詳しい仕様は [CLAUDE.md](CLAUDE.md) を参照

```
iPad ×3 ──→ Webアプリ（docs/） ──fetch──→ GAS（gas/） ──→ スプレッドシート／ドライブ
```

## フォルダ構成

| パス | 内容 |
|---|---|
| `CLAUDE.md` | 仕様書 |
| `gas/` | Google Apps Script（`Code.gs`、`appsscript.json`） |
| `docs/` | GitHub Pages で公開するフロント一式（`index.html`、`sw.js`、`manifest.webmanifest`、`icons/`） |
| `tools/` | 開発用（公開されない）：`dev-server.js`（ローカルサーバー＋モックAPI）、`check-api.sh`（本物の GAS の確認）、`make-icons.js`（アイコン生成） |

## 注意（絶対にコミットしないもの）

- GAS のウェブアプリ URL
- 合言葉（`API_TOKEN`）
- スプレッドシート ID、ドライブのフォルダ ID
- `gas/.clasp.json`（scriptId を含む）

これらは GAS のスクリプトプロパティ、または iPad 内（localStorage）にだけ保存します。

---

## 1. 事前準備（人間の作業）

学校の Google アカウントで次を用意します。

1. **写真用フォルダ**（ドライブ）を作る。共有は**スタッフだけ**にし、「リンクを知っている全員」は絶対にオンにしない。
2. **スプレッドシート**を新規に作る（名前は自由。例：「登下校記録」）。
3. **合言葉（API_TOKEN）** を作る。ターミナルで次を実行し、出てきた文字列を控える（他人に見せない・コミットしない）。
   ```bash
   openssl rand -hex 24
   ```
4. clasp にログインする（済んでいれば不要）。
   ```bash
   clasp login
   ```

ID の調べ方：

| 値 | 見つけ方 |
|---|---|
| `SHEET_ID` | スプレッドシートの URL `https://docs.google.com/spreadsheets/d/`**ここ**`/edit` |
| `FOLDER_ID` | フォルダの URL `https://drive.google.com/drive/folders/`**ここ**`?usp=sharing` |

## 2. GAS のセットアップとデプロイ

### 2-1. コードを GAS に送る（clasp）

`gas/.clasp.json` に scriptId が入っている（コミットされない）。コードを直したら次で反映する。

```bash
cd gas
clasp push
```

新しい環境でゼロから作る場合は、`gas/` で次を実行して `.clasp.json` を作る（`appsscript.json` が初期値で上書きされるので、そのあと `git checkout gas/appsscript.json` で戻してから `clasp push -f`）。

```bash
cd gas
clasp create-script --type standalone --title "とうげこう API"
```

GAS のエディタを開く：

```bash
cd gas
clasp open-script
```

### 2-2. スクリプトプロパティを設定する

エディタ左の「プロジェクトの設定」（歯車）→ 下の「スクリプト プロパティ」→「スクリプト プロパティを編集」で3つ追加して保存する。

| プロパティ | 値 |
|---|---|
| `SHEET_ID` | スプレッドシートの ID |
| `FOLDER_ID` | 写真フォルダの ID |
| `API_TOKEN` | 上で作った合言葉 |

### 2-3. `setup()` を実行する

1. エディタ上部の関数選択で `setup` を選び「実行」。
2. 初回は権限の承認を求められる（「詳細」→「（安全ではないページ）に移動」→ 許可）。スプレッドシートとドライブへのアクセスの許可。
3. 下の実行ログに、次のように出れば OK。
   - シート「名簿」「記録」を確認しました
   - 写真フォルダを確認しました（共有設定: **PRIVATE**）
   - 共有設定が PRIVATE 以外なら【注意】が出る。フォルダの共有を見直すこと。
4. スプレッドシートに「名簿」「記録」シートができているので、「名簿」に児童を入力する（列は A:児童ID、B:名前、C:よみ、D:学年、E:在籍(TRUE/FALSE)、F:並び順）。
   - 動作確認だけ先にしたいときは、関数 `addSampleRoster` を実行するとダミーの6名（T001〜T006、各学年1名）が入る。**確認が済んだら削除する。**

### 名簿の書き方（漢字とふりがな）

名前は、1年生から**漢字で**表示する（自分の名前を理解するため）。1・2年のグループでは、「よみ」がふりがなとして漢字の上に付く。3年生以上はふりがななし。

| 列 | 書き方 | 例 |
|---|---|---|
| 名前 | **漢字**で書く。姓と名のあいだにスペースを入れる | `小野 健` |
| よみ | **ひらがな**で書く。名前と同じ位置にスペースを入れる | `おの けん` |

- 姓と名の数が名前とよみで同じなら、**姓・名それぞれの上に**ふりがなが付く（`<ruby>小野<rt>おの</rt></ruby> <ruby>健<rt>けん</rt></ruby>`）。スペースの数が合わないときは、名前全体の上に付く。
- ひらがなだけの部分（例：名が「けん」）にはふりがなを付けない。
- 3年生以上の画面は、「登校」「下校」「下校済み」など、文言も漢字になる（1・2年はひらがな）。

### 2-4. ウェブアプリとしてデプロイする（初回のみ）

1. エディタ右上「デプロイ」→「新しいデプロイ」。
2. 歯車 →「ウェブアプリ」を選ぶ。
3. 設定：
   - 次のユーザーとして実行：**自分**
   - アクセスできるユーザー：**全員**
4. 「デプロイ」→ 表示される **ウェブアプリの URL**（`https://script.google.com/macros/s/…/exec`）と、「デプロイを管理」にある **デプロイ ID** を控える。
   - この URL は iPad の設定画面に入力する（コミットしない）。

### 2-5. curl で動作を確認する

ターミナルで、URL と合言葉を環境変数に入れる（履歴に残したくなければ `read -s` を使う）。

```bash
export GAS_URL='https://script.google.com/macros/s/xxxxxxxx/exec'
read -s TOKEN && export TOKEN   # 合言葉を貼り付けて Enter
```

**名簿（roster）**：`group` は `12`（1・2年）/ `34`（3・4年）/ `56`（5・6年）。

```bash
curl -sL "$GAS_URL?action=roster&group=12&token=$TOKEN"
```

→ `{"ok":true,"group":"12","children":[…]}` で、該当学年の在籍児童だけが返る。

**今日の状態（today）**

```bash
curl -sL "$GAS_URL?action=today&group=12&token=$TOKEN"
```

→ 全員 `"status":"未登校"` から始まる。

**誤った合言葉**

```bash
curl -sL "$GAS_URL?action=roster&group=12&token=wrong"
```

→ `{"ok":false,"error":"unauthorized"}`

**記録の送信（POST）**：任意の JPEG 写真（`photo.jpg`）を使う。児童 ID は名簿にあるもの（ダミーなら `T001`）。

```bash
IMG=$(base64 < photo.jpg | tr -d '\n')
RID=$(uuidgen)
printf '{"token":"%s","recordId":"%s","childId":"T001","type":"登校","capturedAt":"%s","group":"12","resent":false,"imageBase64":"data:image/jpeg;base64,%s"}' \
  "$TOKEN" "$RID" "$(date '+%Y-%m-%d %H:%M:%S')" "$IMG" > /tmp/post.json

curl -sL -H 'Content-Type: text/plain' --data-binary @/tmp/post.json "$GAS_URL"
```

→ `{"ok":true}`。確認すること：
- 「記録」シートに1行増えた（撮影日時・受信日時は文字列のまま）
- 写真フォルダに今日の日付のサブフォルダができ、`HHmmss_T001_…_登校.jpg` が入っている
- 手順の `today` を再度実行すると、T001 が `"登校中"` になる

**同じ記録をもう一度送る（二重記録されないこと）**

```bash
curl -sL -H 'Content-Type: text/plain' --data-binary @/tmp/post.json "$GAS_URL"
```

→ `{"ok":true,"duplicate":true}`。記録シートは1行のまま。

確認後は `rm /tmp/post.json` で消し、ダミーの行・写真は削除する。

**エラーの例**

| `error` | 意味 |
|---|---|
| `unauthorized` | 合言葉が違う |
| `invalid_group` / `invalid_type` / `invalid_captured_at` / `invalid_record_id` / `invalid_image` | 送った値の形式が違う |
| `unknown_child` | 名簿にない児童 ID |
| `busy` | 同時書き込みで30秒待っても順番が来なかった（再送すれば通る） |
| `server_error` | GAS 側の失敗（エディタの「実行数」でログを見る。`setup()` 未実行やプロパティ未設定が多い） |

### 2-6. 古い写真の削除（手動）

学期末などに、指定日**より前**の日付フォルダをドライブのゴミ箱へ移せる（30日間は復元可）。
エディタで `runDeleteOldPhotos` の `deleteOldPhotos('')` の日付（例：`'2027-04-01'`）を入れ、`clasp push` してから `runDeleteOldPhotos` を実行する。実行後は日付を空に戻しておく。

### GAS 更新時の注意

コードを修正したら「デプロイを管理」→ 既存のデプロイを編集 →「新しいバージョン」で更新します。
**新しいデプロイを作ると URL が変わり、iPad からつながらなくなります。**

clasp を使う場合は、先に `clasp push` でコードを送ってから、既存のデプロイ ID を指定して更新します（`-i` を付け忘れると新しいデプロイができて URL が変わるので注意）。

```bash
cd gas
clasp push
clasp deploy -i <deploymentId>
```

## 3. フロントの動作確認（ローカル）

カメラには HTTPS が必要だが、`localhost` だけは HTTP でも使える。ローカル確認は必ず `localhost` で行う（`192.168.…` などの IP アドレスではカメラが使えない）。

### 3-1. モック GAS つきのローカルサーバー（本物の GAS なしで試す）

```bash
cd /Users/tcsstaff/Documents/Claude/tokogeko-app
node tools/dev-server.js
```

| 何が動くか | URL |
|---|---|
| アプリ本体（`docs/`） | http://localhost:8080 |
| GAS の代わりのモック API | http://localhost:8787/exec |

アプリの設定画面（初回は自動で開く）に次を入れて保存する。

| 項目 | 値 |
|---|---|
| 学年グループ | 好きなもの（`34` は16人、`12` は5人のダミー児童） |
| URL | `http://localhost:8787/exec` |
| 合言葉 | `test-token` |
| 暗証番号 | 好きな4〜6桁 |

モックの記録はメモリ上だけ（写真は保存しない）。サーバーを止めると消える。`http://localhost:8787/__records` で受信した記録を見られる。止めるときは `Ctrl+C`。

### 3-2. 本物の GAS につないで試す

同じ `http://localhost:8080` の設定画面に、本物のウェブアプリ URL と合言葉を入れる（ダミー名簿を入れておくと確認しやすい）。`node tools/dev-server.js` は、アプリを配信するためにだけ使う。

### 3-3. 確認すること（チェックリストの一部）

| 確認 | やり方 |
|---|---|
| 一覧・状態表示 | 名前を押して撮影 → タイルが緑（登校中・顔写真つき）→ もう一度 → 青灰色（げこうずみ・写真が薄い） |
| 下校済みの子 | タップすると「もう げこうしているよ」だけ出て、カメラは起動しない |
| 暗証番号 | 画面右上の隅を3秒長押し → 暗証番号 → 設定画面（短く押しても開かない） |
| オフライン | 下記 |
| 日付が変わる | 翌日になると全員が未登校に戻り、前日の表示用写真は消える |
| 30秒放置 | 撮影画面で30秒触らないとホームに戻り、カメラが止まる |

**オフラインの確認**

1. Chrome の開発者ツール →「Network」→ スロットリングを「Offline」にする（またはモックサーバーを `Ctrl+C` で止める）。
2. 名前を押して撮影する。すぐに「登校中」になり、左下に「未送信 1件」が出る。
3. そのままページを再読み込みする（Service Worker があるので、サーバーが止まっていても起動する）。一覧・状態・「未送信 1件」が残っている。
4. 「Offline」を戻す（モックを再起動する）。`online` イベントか60秒以内に自動で送信され、「未送信」が消える。
5. 送信された記録は `resent: true` で、撮影日時はオフラインで撮った時刻のまま。

**Service Worker の更新**

`docs/sw.js` の `CACHE`（例：`tokogeko-v1`）は、アプリ本体を変更して公開するたびにバージョン番号を上げる。上げないと、iPad に古い画面がキャッシュされたまま残る。更新は「次に起動したとき」に反映される（アプリを一度完全に閉じて開き直す）。表示はホーム画面の右下の小さな `v1` で確認でき、`docs/index.html` の `APP_VERSION` も合わせて更新する。

### 3-4. アイコンの作り直し

```bash
node tools/make-icons.js
```

`docs/icons/` に、180px・192px・512px の PNG をオリジナルのランドセル図案で書き出す（外部ライブラリ不要）。

## 4. 公開（GitHub Pages）

`docs/` フォルダを GitHub Pages で公開する。公開されるのはアプリの画面（`docs/`）だけでなく、リポジトリ全体が見える（無料プランでは**公開リポジトリ**が必要）。URL・合言葉・各種 ID・`.clasp.json` はコミットされないようにしてあるので、リポジトリの中身が公開されても、記録や写真は見られない。

> 無料の GitHub では、Pages は公開リポジトリだけで使える。非公開のままにしたい場合は、GitHub の有料プラン（Pro / Team）が必要。

### 4-1. コミット前の確認（済み）

```bash
git add -A -n          # コミット対象の一覧（.clasp.json が入っていないこと）
git check-ignore -v gas/.clasp.json
```

### 4-2. GitHub にリポジトリを作る

1. https://github.com/new を開く。
2. Repository name：`tokogeko`（好きな名前でよい。以下この名前で説明）。
3. **Public** を選ぶ。
4. 「Add a README file」「.gitignore」「license」は**すべてオフ**のまま（すでにあるため）。
5. 「Create repository」。

### 4-3. 初回コミットと push

ターミナルで次を実行する（名前・メール・ユーザー名は自分のものに置き換える）。

```bash
cd /Users/tcsstaff/Documents/Claude/tokogeko-app
git config user.name "あなたの名前"
git config user.email "GitHub に登録しているメール"
git add -A
git commit -m "とうげこう: 初回コミット"
git remote add origin https://github.com/<ユーザー名>/tokogeko.git
git push -u origin main
```

- push のとき、パスワードを聞かれたら、GitHub のパスワードではなく **Personal Access Token** を使う（GitHub → Settings → Developer settings → Personal access tokens → 「repo」権限）。ブラウザでのログインを求められた場合は、その画面に従う。
- ターミナルが苦手なら、GitHub Desktop（「Add Local Repository」→ Publish repository）でも同じことができる。

### 4-4. Pages を有効にする

1. GitHub のリポジトリ →「Settings」→ 左の「Pages」。
2. 「Build and deployment」の Source を **Deploy from a branch** にする。
3. Branch を **`main`**、フォルダを **`/docs`** にして「Save」。
4. 1〜2分待つと、画面の上に公開 URL が出る：`https://<ユーザー名>.github.io/tokogeko/`

### 4-5. 公開 URL での確認

公開 URL を Chrome で開いて確認する（HTTPS なので、カメラも Service Worker も使える）。

- 初回は設定画面が開く → 本物のウェブアプリ URL と合言葉を入れて接続テスト → 保存。
- 撮影して記録される（記録シートの行、写真フォルダ）。
- 開発者ツール →「Application」→「Service Workers」に `sw.js` が「activated」で出る。「Cache Storage」に `tokogeko-v2`（など）が出る。
- 機内モード相当（Network を Offline）で再読み込みしても起動する。

> 公開 URL では、`localhost` とは別のサイトとして扱われるため、設定（URL・合言葉・暗証番号）は入れ直しになる。iPad でも同じ。

### 4-6. アプリを更新するとき

1. `docs/` の中身を直したら、`docs/sw.js` の `CACHE`（例：`tokogeko-v2` → `v3`）と、`docs/index.html` の `APP_VERSION`（`v2` → `v3`）のバージョン番号を上げる。
2. `git add -A && git commit -m "…" && git push`
3. 1〜2分で公開が更新される。iPad は、アプリを一度完全に閉じて開き直す（2回開き直すと確実）と、新しい版になる。右下の小さなバージョン表示で確認できる。

## 5. iPad のセットアップ

> 段階5で書きます。

## 6. 毎朝の運用

> 段階5で書きます。
