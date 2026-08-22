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
