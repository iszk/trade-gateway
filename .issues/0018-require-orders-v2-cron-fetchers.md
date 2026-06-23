---
title: cron の約定同期 fetcher を orders_v2 専用 interface に一本化する
status: wip
---

# 概要

`api/src/services/cron-tasks.ts` の約定同期で、`getExecutionPriceForOrderV2` / `getClosingExecutionForOrderV2` があれば新ロジック、なければ旧 `getExecutionPrice` / `getClosingExecution` へフォールバックする分岐を削除する。

対象:

- `ExecutionPriceFetcherLike` / `ClosingExecutionFetcherLike` の legacy union
- `fetchAndUpdatePendingOrdersV2()` の `getExecutionPriceForOrderV2 ? ... : getExecutionPrice(...)`
- `syncExecutionsForExecutedIfdOrders()` の `getClosingExecutionForOrderV2 ? ... : getClosingExecution(...)`
- 旧 fetcher だけを注入している `cron-tasks.test.ts` のテスト

# 背景

`orders_v2` が source of truth になった後も、cron は旧 fetcher 形状を受け入れている。これにより新旧の動作差が cron 内に残り、metadata 更新や order context を使う同期が必須であることを型で表現できていない。

# 実装/修正プラン

- [x] `ExecutionPriceFetcherLike` を `getExecutionPriceForOrderV2(order)` 必須の型にする
- [x] `ClosingExecutionFetcherLike` を `getClosingExecutionForOrderV2(order)` 必須の型にする
- [x] cron 内の providerOrderId/ticker だけを渡す旧分岐を削除する
- [x] `cron-tasks.test.ts` の旧 fetcher 注入をすべて v2 fetcher 注入へ更新する
- [x] `getExecutionPrice` / `getClosingExecution` が他の production 経路で不要なら、次 issue の削除対象として参照関係を整理する
- [x] `docs/ifdoco-exit-flow.md` の旧フォールバック記述を削除または更新する
- [x] `mise run test` を通す

# ログ

## 2026-06-11 00:05 Codex GPT-5

起票した。`cron-tasks.ts:129` と `cron-tasks.ts:208` に、orders_v2 用 fetcher があれば使い、なければ旧 fetcher に戻る互換分岐が残っている。現状の test も旧 fetcher だけを渡すケースを複数持っており、型上も legacy union が許容されている。まず cron の注入 contract を orders_v2 専用に倒し、以後の issue で broker 内部の metadata 欠落時フォールバックや旧 public method を削除しやすくする。

## 2026-06-23 15:45 Codex GPT-5

実装開始。`ExecutionPriceFetcherLike` / `ClosingExecutionFetcherLike` を orders_v2 専用 method 必須の型に変更し、cron 内の旧 `getExecutionPrice` / `getClosingExecution` 分岐を削除する。併せて `cron-tasks.test.ts` の stub を v2 fetcher へ更新し、`docs/ifdoco-exit-flow.md` の旧フォールバック記述を更新する。

## 2026-06-23 15:46 Codex GPT-5

実装完了。cron の fetcher contract は `getExecutionPriceForOrderV2(order)` / `getClosingExecutionForOrderV2(order)` 必須に統一し、旧 providerOrderId/ticker 経由の分岐を削除した。`cron-tasks.test.ts` の注入 stub はすべて v2 fetcher へ更新済み。`getExecutionPrice` / `getClosingExecution` の production 参照は broker 内部の v2 fetcher metadata 欠落時フォールバックに残っており、これは既存 issue `0019-require-broker-metadata-for-orders-v2-sync.md` の対象として整理済み。`mise run test` は typecheck、api test 167 件、ui test 3 件がすべて pass。
