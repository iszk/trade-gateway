---
title: orders_v2 の日時基準から created_at フォールバックを外す
status: wip
---

# 概要

`orders_v2` の一覧・統計で `executed_at` があればそれを使い、なければ `created_at` を使う互換処理を廃止し、EXECUTED 注文は `executed_at` 必須として扱う。

対象:

- `api/src/services/orders-v2.ts`
  - `getEffectiveOrderTime()`
  - `createListOrdersV2ByDateRangeFn()` の executed_at / created_at 二重 query
- `api/src/services/stats-v2.ts`
  - `executed_at ?? created_at`
- `api/src/services/orders-v2.test.ts`
- `api/src/services/stats-v2.test.ts`

# 背景

`executed_at` 追加時の既存データ互換として `created_at` フォールバックが入っている。新規同期では `executed_at` が保存されるようになっているため、過去データをどう扱うかを決めれば、日時基準を実約定時刻に一本化できる。

# 実装/修正プラン

- [x] Firestore 上の既存 `orders_v2` で `status=EXECUTED` かつ `executed_at` 欠落の扱いを決める
- [x] 方針案: backfill する、集計対象外にする、または過去データ破棄として割り切る
- [x] `OrderV2` 型で `executed_at` を EXECUTED 時必須に近づける表現を検討する
- [x] 一覧 API の date range query を `executed_at` のみへ簡素化する
- [x] stats のソートを `executed_at` のみにする
- [x] `created_at` フォールバック前提のテストを削除・更新する
- [x] `docs/database-spec.md` / `docs/api-spec.md` に EXECUTED 注文の日時基準を明記する
- [x] `mise run test` を通す

# ログ

## 2026-06-11 00:05 Codex GPT-5

起票した。`orders-v2.ts` と `stats-v2.ts` に `executed_at ?? created_at` の互換処理が残っている。これは約定時刻導入時の過去データ互換として妥当だったが、今後は `orders_v2` の新ロジックへ一本化するなら、既存データの backfill または除外方針を決めたうえで削除対象になる。

## 2026-06-23 15:25 Codex GPT-5

実装を開始した。方針は、`orders_v2` の一覧・統計の日時基準を `executed_at` のみに一本化し、`status=EXECUTED` だが `executed_at` が欠落している既存データは一覧・統計対象外として扱う。過去データの補正は本 issue では行わず、必要なら別途 backfill で対応する。

## 2026-06-23 15:29 Codex GPT-5

実装した。`createListOrdersV2ByDateRangeFn()` は `executed_at` の単一 query にし、`created_at` query と dedupe/filter の互換処理を削除した。`computeStatsV2()` と `buildTradeRecordsFromOrdersV2()` は `executed_at` がない EXECUTED 注文を対象外にし、ソートも `executed_at` のみに統一した。`OrderV2` 型は EXECUTED 時に `executed_at` / 非 null `executed_price` を要求する union に変更した。

UI の Orders V2 表示は `created_at` フォールバックを外し、欠落時は `—` 表示にした。docs には EXECUTED 注文の `executed_at` 必須と、一覧・統計の日時基準を明記した。`cron-tasks.ts` の `execution.executed_at ?? order.executed_at ?? order.created_at` は、ブローカー約定結果に時刻がない場合に保存する `executed_at` を埋める書き込み側の互換処理であり、今回の read 側フォールバック削除とは別スコープとして残した。

`mise run test` は typecheck と api/ui test まで成功した。
