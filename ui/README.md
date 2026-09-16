---
title: ui readme
type: document
---


# build

ビルドは context は root で、こんな感じでやる
```sh
docker . build -f ui/Dockerfile -t ui
```

## Symbols Detail

`/symbols/:symbol_id` の `Order Constraints` で、銘柄ごとの注文数量制約を確認・登録・更新できます。

- `Quantity Step`（最小刻み）と `Minimum Order Size`（最小注文数量）は同時に必須です。
- `Maximum Order Size`（最大注文数量）は任意ですが、入力する場合は最小注文数量以上にしてください。
- 入力値は正の有限数としてサーバー側で検証されます。0、負数、数値でない値、部分的な数値、必須項目の欠落は保存されません。
- API側で保存に失敗した場合は、HTTP status と API のエラーメッセージが画面に表示されます。
- 制約保存は自動推測や broker からの取得を行わず、policy の有効化や本番データの更新も行いません。Metadata と Trade Control の保存フォームも別になっています。
- `order_constraints` 未登録の legacy symbol は空欄で表示されるため、運用者が値を確認してから登録してください。

## Policies

`/policies` では `strategy_symbol_policies` と対応する `strategy_symbol_positions`（仮想 position）のみを表示します。証券会社の実ポジションは `/positions` で別に確認してください。`ledger_health` が READY でない項目は数量を補完せず異常として表示します。

### 追加

追加フォームの処理は、symbol の登録確認、fresh-start dry-run、symbol pause（開始時に active の場合）、fresh-start apply、一覧 read-back 検証、元が active の場合だけ resume の順で実行します。API_SECRET の Bearer 認証を使用します。API_URL の接続先取り違えは project ID では検出しない。接続先 URL と API_SECRET の環境別設定・配布・確認で管理する。

複数 API 呼び出しは全体として atomic ではありません。pause 後の step が失敗した場合、symbol は自動再開されないため、画面の完了 step と現在状態を確認して手動復旧します。共有 symbol を使う他 strategy の webhook も一時停止されます。

### 強制削除

一覧からの Force delete は API_SECRET の Bearer 認証に加え、SSR の確認画面で完全な `strategy_id:symbol_id` の再入力を要求します。成功すると対象 policy と仮想 position を削除し、symbol は paused のまま、`orders_v2` と reservation は保持します。削除後の自動 resume はありません。

現在の `ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK=true` では、削除後に symbol を再開すると policy 制約なしの webhook 発注が起き得ます。また後着約定で削除済み ledger を更新できないため、replacement policy と ledger、注文・reservation・broker 建玉を確認してから運用者が明示的に再開してください。
