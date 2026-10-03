#!/bin/bash
# GAS API の動作確認（README「2-5」の自動版）。
# URL と合言葉は実行時に入力する。ファイルや履歴には残らない。
#
# 使い方:
#   bash tools/check-api.sh              … roster / today / 誤った合言葉 の確認
#   bash tools/check-api.sh tools/test-photo.jpg … さらに POST（登校の記録・重複送信）も確認
#                                          ※ 名簿（1・2年）の先頭の児童の「登校」が1件記録される

set -u
PHOTO="${1:-}"

# 貼り付け時の改行・空行で空入力にならないよう、空なら聞き直す（前後の空白も除く）
GAS_URL=""
while [ -z "$GAS_URL" ]; do
  read -r -p "ウェブアプリのURL（.../exec）: " RAW_URL
  # 余計な文字（「デプロイしました」など）が混ざっていても、https://… の部分だけを取り出す
  GAS_URL=$(printf '%s' "$RAW_URL" | grep -oE 'https?://[^[:space:]]+' | head -1)
done
TOKEN=""
while [ -z "$TOKEN" ]; do
  read -r -s -p "合言葉（入力は表示されません）: " TOKEN
  echo
  TOKEN=$(echo "$TOKEN" | tr -d '[:space:]')
done
echo "URL: ${GAS_URL:0:45}...  / 合言葉の長さ: ${#TOKEN}"

get() { curl -sL --max-time 60 -w '\n[HTTP %{http_code}]' "$GAS_URL?action=$1&group=$2&token=$3"; }

echo; echo "== 1. roster（group=12） =="; get roster 12 "$TOKEN"
echo; echo "== 2. today（group=12） ==";  get today 12 "$TOKEN"
echo; echo "== 3. 誤った合言葉（unauthorized になれば正常） =="; get roster 12 "wrong-token"

if [ -n "$PHOTO" ]; then
  [ -f "$PHOTO" ] || { echo; echo "写真ファイルが見つかりません: $PHOTO"; exit 1; }
  CHILD=$(curl -sL --max-time 60 "$GAS_URL?action=roster&group=12&token=$TOKEN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["children"][0]["childId"])' 2>/dev/null)
  [ -n "$CHILD" ] || { echo; echo "名簿（1・2年）から児童を取得できませんでした。"; exit 1; }
  read -r -p "児童ID $CHILD の「登校」を1件記録します。よければ y: " ANS
  [ "$ANS" = "y" ] || { echo "中止しました。"; exit 0; }

  BODY=$(mktemp)
  trap 'rm -f "$BODY"' EXIT
  IMG=$(base64 < "$PHOTO" | tr -d '\n')
  RID=$(uuidgen)
  printf '{"token":"%s","recordId":"%s","childId":"%s","type":"登校","capturedAt":"%s","group":"12","resent":false,"imageBase64":"data:image/jpeg;base64,%s"}' \
    "$TOKEN" "$RID" "$CHILD" "$(date '+%Y-%m-%d %H:%M:%S')" "$IMG" > "$BODY"

  post() { curl -sL --max-time 120 -H 'Content-Type: text/plain' --data-binary @"$BODY" -w '\n[HTTP %{http_code}]' "$GAS_URL"; }
  echo; echo "== 4. POST（{\"ok\":true} になれば正常） =="; post
  echo; echo "== 5. 同じ記録をもう一度（duplicate:true になれば正常） =="; post
  echo; echo "== 6. today（その児童が 登校中 になれば正常） =="; get today 12 "$TOKEN"
fi

echo; echo "終わりました。"
