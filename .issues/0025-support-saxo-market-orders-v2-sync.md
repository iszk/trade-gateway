---
title: Saxo の MARKET 注文でも orders_v2 の PENDING を解消して約定金額を更新する
status: todo
---

# 概要

Saxo の `MARKET` 注文についても、orders_v2 の `PENDING` を `EXECUTED` に更新し、約定価格・約定数量を反映できるようにしたい。

# 背景

現状の Saxo 実装では、`sendMarketOrder()` が related order を持たない `MARKET` 注文に対して `broker_order_metadata` を保存しない。

その結果、orders_v2 に入った Saxo の `MARKET` 注文は metadata なしのままになり、`getExecutionPriceForOrderV2()` 側で `saxo_order_v1` 以外を `orders_v2_metadata_missing` として即スキップする。

実際のログでも、直近の Saxo `MARKET` 注文で `broker_order_metadata` が欠けており、cron 側で `orders_v2_execution_not_found` が繰り返し出ていることを確認した。

確認できている事実:

- `buildSaxoOrderMetadata()` は related order が 0 件だと `undefined` を返す
- そのため `MARKET` 注文単体では `broker_order_metadata` が保存されない
- `getExecutionPriceForOrderV2()` は metadata なしでは同期処理を行わない
- cron はその結果として `PENDING` を残し続ける

# 実装/修正プラン

- [ ] Saxo の `MARKET` 注文で最低限必要な metadata の扱いを整理する
- [ ] `MARKET` 注文でも PENDING を解消できる同期条件を定義する
- [ ] 約定価格・約定数量の更新が `MARKET` 注文でも行われるようにする
- [ ] 既存の Saxo / orders_v2 テストに MARKET 注文のケースを追加する

# ログ

## 2026-06-23 23:36 Codex GPT-5.4 mini

`MARKET` 注文の Saxo orders_v2 レコードで `broker_order_metadata` が欠落していることを確認した。`buildSaxoOrderMetadata()` は related order が無いと `undefined` を返すため、単体の `MARKET` 注文では metadata が保存されず、`getExecutionPriceForOrderV2()` が `orders_v2_metadata_missing` で同期を止める。結果として cron が `orders_v2_execution_not_found` を繰り返し、PENDING が解消されない。