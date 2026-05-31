---
title: orders-v2 のレコードに約定時間を追加する
status: done
---

# 概要

`orders-v2` のレコードに、注文作成時刻とは別に実際の約定時刻を保持できるようにする。

通常の成行注文では `created_at` を約定時刻の近似として扱っても大きな問題になりにくいが、IFDOCO の exit や指値注文では、実際に約定した時刻と注文作成時刻が乖離するため、後から正しい時系列を追えない。

# 背景

- 現状の `orders-v2` では、レコード上で実際の約定時刻を明示的に保持していない
- 通常の market 注文は `created_at` で概ね代用できる
- 一方で、以下のケースでは `created_at` では不十分
  - IFDOCO の exit
  - 指値注文
  - 発注から約定まで時間差がある注文全般
- 約定時刻がないと、約定順の分析やトレード記録の整合確認で誤差や誤解釈が発生する

# 実装/修正プラン

- [ ] `orders-v2` のスキーマに約定時刻フィールドを追加する
- [ ] ブローカーごとに、実約定時刻を取得できる経路を整理する
- [ ] 実約定時刻が取得できる注文では、その値を保存する
- [ ] 実約定時刻が取得できない注文では、既存データとの互換性を崩さないフォールバック方針を決める
- [ ] 既存の集計・表示・トレード記録処理で、新フィールドを使うべき箇所を見直す
- [ ] テストを追加し、market 注文と約定遅延のある注文の両方を検証する

# ログ

## 2026-05-28 00:00 GitHub Copilot GPT-5.4

起票した: `orders-v2` では注文作成時刻しか扱えず、IFDOCO の exit や指値注文で実際の約定タイミングを失ってしまうため。`created_at` を約定時刻の近似として使えるケースと使えないケースを分離し、実約定時刻を保持できるようにする必要がある。

## 2026-06-01 00:12 GitHub Copilot GPT-5.4

着手した。`orders_v2` の型と Firestore 読み出しに `executed_at` を追加し、同期処理では実約定時刻が取得できた場合はそれを保存、取得できない場合は既存互換のため `created_at` 相当へフォールバックする方針で進める。合わせて `computeStatsV2` の時系列判定を `created_at` 固定から `executed_at ?? created_at` に切り替える。

## 2026-06-01 00:16 GitHub Copilot GPT-5.4

実装した。`orders_v2` の型と Firestore 復元処理に `executed_at` を追加し、`cron-tasks` で entry/exit の同期時に `executed_at` を保存するようにした。bitFlyer の `getExecutionPriceForOrderV2` / `getClosingExecutionForOrderV2` では `getexecutions` の `exec_date` から最新約定時刻を抽出して返し、取得できないブローカーや既存データでは `executed_at ?? created_at` のフォールバックで従来互換を維持している。`computeStatsV2` も約定順を `executed_at` 優先で処理するよう更新し、関連テストを追加・更新した。`mise run test` で全件パスを確認済み。

## 2026-06-01 00:32 GitHub Copilot GPT-5.4

追加確認したところ、Saxo の MARKET 注文取得経路 (`SaxoClient.getExecutionPrice`) は `AveragePrice` しか返しておらず `executed_at` が未対応だったため補完する。`/cs/v1/audit/orderactivities` の fill 活動に含まれる時刻を優先的にパースし、`ExecutionInfo.executed_at` として `orders_v2` 同期へ渡す。既存どおり時刻が取れない応答は `cron-tasks` 側の `created_at` フォールバックに委ねる。
