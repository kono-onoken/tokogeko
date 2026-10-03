#!/bin/bash
# GAS API の動作確認（README「2-5」の自動版）。
# URL と合言葉は実行時に入力する。ファイルや履歴には残らない。
#
# 使い方:
#   bash tools/check-api.sh              … roster / today / 誤った合言葉 の確認
#   bash tools/check-api.sh photo.jpg    … さらに POST（登校の記録・重複送信）も確認
#                                          ※ 児童ID T001 の「登校」が1件記録される

set -u
PHOTO="${1:-}"

# 貼り付け時の改行・空行で空入力にならないよう、空なら聞き直す（前後の空白も除く）
GAS_URL=""
while [ -z "$GAS_URL" ]; do
  read -r -p "ウェブアプリのURL（.../exec）: " GAS_URL
  GAS_URL=$(echo "$GAS_URL" | tr -d '[:space:]')
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
  read -r -p "T001 の「登校」を1件記録します。よければ y: " ANS
  [ "$ANS" = "y" ] || { echo "中止しました。"; exit 0; }

  BODY=$(mktemp)
  trap 'rm -f "$BODY"' EXIT
  IMG=$(base64 < "$PHOTO" | tr -d '\n')
  RID=$(uuidgen)
  printf '{"token":"%s","recordId":"%s","childId":"T001","type":"登校","capturedAt":"%s","group":"12","resent":false,"imageBase64":"data:image/jpeg;base64,%s"}' \
    "$TOKEN" "$RID" "$(date '+%Y-%m-%d %H:%M:%S')" "$IMG" > "$BODY"

  post() { curl -sL --max-time 120 -H 'Content-Type: text/plain' --data-binary @"$BODY" -w '\n[HTTP %{http_code}]' "$GAS_URL"; }
  echo; echo "== 4. POST（{\"ok\":true} になれば正常） =="; post
  echo; echo "== 5. 同じ記録をもう一度（duplicate:true になれば正常） =="; post
  echo; echo "== 6. today（T001 が 登校中 になれば正常） =="; get today 12 "$TOKEN"
fi

echo; echo "終わりました。"
