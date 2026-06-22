---
title: fetchAllBalances 実行時に broker 間で daily_balances の日付がずれる問題を解消する
status: wip
---

# 概要

`BalanceFetcher.fetchAllBalances()` で `bitflyer` と `saxo` の取得・保存を並列実行しているため、日付切り替わり直前/直後に実行されると broker ごとに `daily_balances` の `docId` 日付（`YYYY-MM-DD_<broker>`）が不一致になることがある。

`fetchAllBalances()` 単位で基準日付を 1 回だけ確定し、その値を両 broker の保存に共通適用して不整合を防ぐ。

対象:

- `api/src/services/balance-fetcher.ts`
- `api/src/services/balance-fetcher.test.ts`
- 必要に応じて日次残高仕様を記載しているドキュメント

# 背景

現状は `storeBrokerBalance()` 内で都度 `getJstDate()` を呼び出しており、2 broker の保存タイミングが日付境界をまたぐと別日扱いになる。

その結果、同一 `fetchAllBalances()` 呼び出し由来のデータなのに日付キーが分断され、参照・集計・運用確認の一貫性が下がる。

# 実装/修正プラン

- [ ] `fetchAllBalances()` 開始時点で JST 日付を 1 回だけ決定する
- [ ] `storeBrokerBalance()` が呼び出し元から日付を受け取れるようにする（または等価な設計に変更する）
- [ ] `fetchAndStoreBitflyerBalances()` / `fetchAndStoreSaxoBalances()` から同じ日付を渡す
- [ ] 日付境界ケースを再現するテストを追加し、両 broker で同一日付 `docId` になることを検証する
- [ ] 必要ならドキュメントに「`fetchAllBalances()` 1 回の保存は同一日付キーを使う」ことを追記する
- [ ] `mise run test` を通す

# ログ

## 2026-06-19 12:35 GitHub Copilot GPT-5.3-Codex

起票した。`fetchAllBalances()` の並列保存で日付境界をまたぐと broker ごとの `docId` が分かれる可能性があり、同一バッチ内での日付固定が必要。

## 2026-06-23 00:27 Codex GPT-5

`fetchAllBalances()` 開始時点で JST 日付を 1 回だけ確定し、bitFlyer/Saxo の保存処理へ同じ日付を渡すように変更した。
日付境界直前に基準日付を確定した場合でも両 broker の `daily_balances` docId と `date` が一致するテストを追加した。
DB仕様に、`fetchAllBalances()` 1 回の保存では開始時点の JST 日付を全 broker に共通適用する旨を追記した。
