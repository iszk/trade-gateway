---
title: webhook の stop_loss_pct / take_profit_pct 対応
status: done
---

# 概要

受信した webhook の `stop_loss` / `take_profit` フィールドで `"2%"` のようなパーセント値を受け取るケースがある。
これを専用フィールド `stop_loss_pct` / `take_profit_pct` で受け取るよう変更する。

- `stop_loss` は価格の絶対値として受け取る（従来通り）
- `stop_loss_pct` / `take_profit_pct` はパーセント値（例: `"2%"` または `2`）として受け取る
- `stop_loss` と `stop_loss_pct` が両方存在する場合は `stop_loss_pct` を優先して利用する
- 同様に `take_profit` と `take_profit_pct` が両方存在する場合は `take_profit_pct` を優先する

# 背景

TradingView の Pine Script で `"2%"` のようなパーセント文字列でストップロス・テイクプロフィットを
指定したいケースがある。現状は絶対価格しか受け付けていないため、パーセント指定の専用フィールドを追加する。

# ログ

## 2026-05-25 23:59:59 assistant

対応完了。

### 変更内容

- `api/src/index.ts`
  - `baseWebhookSchema` に `stop_loss_pct` / `take_profit_pct` フィールドを追加（`string | number`、任意）
  - `dispatchOrder` 呼び出し前に `effectiveStopLoss` / `effectiveTakeProfit` を計算するロジックを追加
    - `_pct` フィールドが存在する場合は優先使用（数値は `"N%"` 文字列に変換）
    - 存在しない場合は従来の `stop_loss` / `take_profit` にフォールバック
  - `orderMethod` 判定ロジック（IFD/IFDOCO）を effective values ベースに更新

- `api/src/index.test.ts`
  - 新フィールドに関するテストを7件追加（文字列/数値の変換・優先順位・フォールバック・IFDOCO判定）

### テスト結果

`index.test.ts` の全52テストがパス。
