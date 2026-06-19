---
title: orders_v2 同期で broker metadata 欠落時の旧ロジックフォールバックを廃止する
status: todo
---

# 概要

broker 実装内で `broker_order_metadata` が期待する `kind` でない場合に、旧 `getExecutionPrice()` / `getClosingExecution()` へ戻る分岐を削除し、orders_v2 同期は metadata 前提にする。

対象:

- `api/src/brokers/bitflyer.ts`
  - `getExecutionPriceForOrderV2()` の `metadata?.kind !== 'bitflyer_parent_order_v1'` 分岐
  - `getClosingExecutionForOrderV2()` の `metadata?.kind !== 'bitflyer_parent_order_v1'` 分岐
- `api/src/brokers/saxo.ts`
  - `getExecutionPriceForOrderV2()` の `metadata?.kind !== 'saxo_order_v1'` 分岐
  - `getClosingExecutionForOrderV2()` の metadata 欠落 no-op 方針の明確化
- metadata なし orders_v2 の扱い

# 背景

cron 側を v2 fetcher 必須にしても、broker 内部で metadata がなければ旧 order id ベースの探索へ戻るため、新旧混在は残る。特に bitFlyer の旧 closing 判定は `child_order_type !== 'MARKET'` に依存しており、metadata ベースの新ロジックより不安定なため、orders_v2 同期からは外したい。

# 実装/修正プラン

- [ ] metadata がない orders_v2 を同期対象としてどう扱うか決める
- [ ] 方針案: metadata 欠落時は warn を出して `execution: null` とし、旧探索はしない
- [ ] 既存の `orders_v2` に metadata 欠落レコードが残る可能性を調べ、必要なら backfill / 手動破棄 / no-op の運用方針を文書化する
- [ ] bitFlyer の v2 fetcher から旧 `getExecutionPrice()` / `getClosingExecution()` 呼び出しを削除する
- [ ] Saxo の v2 fetcher から旧 `getExecutionPrice(providerOrderId, ticker)` フォールバックを削除する
- [ ] metadata 欠落時の挙動を broker test で固定する
- [ ] `docs/ifdoco-exit-flow.md` と `docs/database-spec.md` を metadata 必須の説明に更新する
- [ ] `mise run test` を通す

# ログ

## 2026-06-11 00:05 Codex GPT-5

起票した。cron 以外にも、bitFlyer/Saxo の `getExecutionPriceForOrderV2()` と `getClosingExecutionForOrderV2()` 内に metadata 欠落時の旧ロジックフォールバックが残っている。これは `orders_v2` の同期精度を metadata 前提に寄せる方針と衝突するため、cron interface 一本化とは別 issue として、既存データの扱いと broker ごとの no-op/warn 方針を含めて進める。
