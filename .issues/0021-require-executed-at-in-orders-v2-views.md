---
title: orders_v2 の日時基準から created_at フォールバックを外す
status: todo
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

- [ ] Firestore 上の既存 `orders_v2` で `status=EXECUTED` かつ `executed_at` 欠落の扱いを決める
- [ ] 方針案: backfill する、集計対象外にする、または過去データ破棄として割り切る
- [ ] `OrderV2` 型で `executed_at` を EXECUTED 時必須に近づける表現を検討する
- [ ] 一覧 API の date range query を `executed_at` のみへ簡素化する
- [ ] stats のソートを `executed_at` のみにする
- [ ] `created_at` フォールバック前提のテストを削除・更新する
- [ ] `docs/database-spec.md` / `docs/api-spec.md` に EXECUTED 注文の日時基準を明記する
- [ ] `mise run test` を通す

# ログ

## 2026-06-11 00:05 Codex GPT-5

起票した。`orders-v2.ts` と `stats-v2.ts` に `executed_at ?? created_at` の互換処理が残っている。これは約定時刻導入時の過去データ互換として妥当だったが、今後は `orders_v2` の新ロジックへ一本化するなら、既存データの backfill または除外方針を決めたうえで削除対象になる。
