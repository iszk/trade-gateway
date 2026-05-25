# webhook の stop_loss_pct / take_profit_pct 対応

## 概要

受信した webhook の `stop_loss` / `take_profit` フィールドで `"2%"` のようなパーセント値を受け取るケースがある。
これを専用フィールド `stop_loss_pct` / `take_profit_pct` で受け取るよう変更する。

- `stop_loss` は価格の絶対値として受け取る（従来通り）
- `stop_loss_pct` / `take_profit_pct` はパーセント値（例: `"2%"` または `2`）として受け取る
- `stop_loss` と `stop_loss_pct` が両方存在する場合は `stop_loss_pct` を優先して利用する
- 同様に `take_profit` と `take_profit_pct` が両方存在する場合は `take_profit_pct` を優先する

## 背景

TradingView の Pine Script で `"2%"` のようなパーセント文字列でストップロス・テイクプロフィットを
指定したいケースがある。現状は絶対価格しか受け付けていないため、パーセント指定の専用フィールドを追加する。

## ログ

### 2026-05-25 00:00:00 assistant

起票した: ユーザーからの要件として、webhook で `stop_loss_pct` / `take_profit_pct` フィールドを
受け取り、`_pct` フィールドが存在する場合はそちらを優先する仕様変更を記録するため。
