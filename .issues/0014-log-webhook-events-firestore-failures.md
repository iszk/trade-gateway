---
title: webhook_events Firestore 保存失敗時の undefined 混入防止と診断ログ追加
status: done
---

# 概要

webhook 受信直後の `webhook_events` 保存で Firestore が `undefined` を拒否して失敗する問題を追跡する。

# 背景

通常受理時に `rejection_reason` が `undefined` のまま Firestore 書き込み payload に含まれていた。Firestore は `undefined` 値を保存できないため、webhook 受付後の初期処理でエラーになる。

# 実装/修正プラン

- `webhook_events` 保存前に `undefined` フィールドを除外する
- Firestore 書き込み失敗時のみ、保存しようとした値をログ出力する
- webhook_events 保存後の発注・ログ・orders_v2 保存で追加の引っかかりポイントがないか確認する
- 回帰テストを追加して `mise run test` で確認する

# ログ

## 2026-06-05 11:58 Codex GPT-5
`webhook_events` の Firestore 保存失敗について issue を作成した。通常受理時の `rejection_reason: undefined` が主因で、既に `omitUndefinedFields` を適用する修正と単体テスト追加を行っている。続けてエラー時ログ追加と後続経路の確認を行う。

## 2026-06-05 11:59 Codex GPT-5
`webhook_events` の Firestore 保存失敗時のみ、`webhook_event:create_failed` として collection、doc_id、保存予定 data、error をログ出力するようにした。重複イベントは通常の制御フローなのでこのエラーログ対象外とした。

提示 payload は `symbol = "saxo:CfdOnIndex:4912"` から broker `saxo`、ticker `CfdOnIndex:4912` として処理される。`webhook_events` 保存後は Saxo 認証、口座情報、Saxo API の注文受付が主な失敗点になる。アプリ内の後続 Firestore 書き込みである `order_dispatch_logs` と `orders_v2` は既に undefined 除去が入っているため、同じ種類の Firestore undefined エラーは起きにくい。

`mise run test` を実行し、140 tests / 140 pass を確認した。
