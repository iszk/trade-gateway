---
title: orders_v2 同期で broker metadata 欠落時の旧ロジックフォールバックを廃止する
status: done
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

- [x] metadata がない orders_v2 を同期対象としてどう扱うか決める
- [x] 方針案: metadata 欠落時は warn を出して `execution: null` とし、旧探索はしない
- [x] 既存の `orders_v2` に metadata 欠落レコードが残る可能性を調べ、必要なら backfill / 手動破棄 / no-op の運用方針を文書化する
- [x] bitFlyer の v2 fetcher から旧 `getExecutionPrice()` / `getClosingExecution()` 呼び出しを削除する
- [x] Saxo の v2 fetcher から旧 `getExecutionPrice(providerOrderId, ticker)` フォールバックを削除する
- [x] metadata 欠落時の挙動を broker test で固定する
- [x] `docs/ifdoco-exit-flow.md` と `docs/database-spec.md` を metadata 必須の説明に更新する
- [x] `mise run test` を通す

# ログ

## 2026-06-11 00:05 Codex GPT-5

起票した。cron 以外にも、bitFlyer/Saxo の `getExecutionPriceForOrderV2()` と `getClosingExecutionForOrderV2()` 内に metadata 欠落時の旧ロジックフォールバックが残っている。これは `orders_v2` の同期精度を metadata 前提に寄せる方針と衝突するため、cron interface 一本化とは別 issue として、既存データの扱いと broker ごとの no-op/warn 方針を含めて進める。

## 2026-06-23 16:14 Codex GPT-5

実装開始。metadata 欠落・kind 不一致の `orders_v2` は warn ログを出して `execution: null` とし、旧 order id ベースの探索へフォールバックしない方針で進める。既存の metadata 欠落レコードは自動推測せず、同期したい場合は metadata の backfill または手動破棄・再作成の運用に寄せる。

## 2026-06-23 16:16 Codex GPT-5

bitFlyer/Saxo の v2 約定・exit 同期から metadata 欠落時の旧探索フォールバックを削除した。metadata 欠落・kind 不一致時は broker ごとに warn ログを出して `execution: null` を返し、外部 API は呼ばない。bitFlyer/Saxo の broker test に metadata 欠落時の no-op を追加し、Saxo の既存 v2 audit テストは metadata 前提に更新した。`docs/database-spec.md` と `docs/ifdoco-exit-flow.md` に metadata 必須と既存欠落データの運用方針を追記した。

## 2026-06-23 16:18 Codex GPT-5

0019 の変更で production 参照がなくなった旧 `getExecutionPrice()` / `getClosingExecution()` を bitFlyer/Saxo broker 実装から削除した。併せて旧メソッドを直接検証していた broker test を削除し、`docs/ifdoco-exit-flow.md` の旧 method 名を削除済みの parentOrderId/ticker ベース探索として表現し直した。
