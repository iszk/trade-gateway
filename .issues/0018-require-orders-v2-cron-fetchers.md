---
title: cron の約定同期 fetcher を orders_v2 専用 interface に一本化する
status: todo
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

- [ ] `ExecutionPriceFetcherLike` を `getExecutionPriceForOrderV2(order)` 必須の型にする
- [ ] `ClosingExecutionFetcherLike` を `getClosingExecutionForOrderV2(order)` 必須の型にする
- [ ] cron 内の providerOrderId/ticker だけを渡す旧分岐を削除する
- [ ] `cron-tasks.test.ts` の旧 fetcher 注入をすべて v2 fetcher 注入へ更新する
- [ ] `getExecutionPrice` / `getClosingExecution` が他の production 経路で不要なら、次 issue の削除対象として参照関係を整理する
- [ ] `docs/ifdoco-exit-flow.md` の旧フォールバック記述を削除または更新する
- [ ] `mise run test` を通す

# ログ

## 2026-06-11 00:05 Codex GPT-5

起票した。`cron-tasks.ts:129` と `cron-tasks.ts:208` に、orders_v2 用 fetcher があれば使い、なければ旧 fetcher に戻る互換分岐が残っている。現状の test も旧 fetcher だけを渡すケースを複数持っており、型上も legacy union が許容されている。まず cron の注入 contract を orders_v2 専用に倒し、以後の issue で broker 内部の metadata 欠落時フォールバックや旧 public method を削除しやすくする。
