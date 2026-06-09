---
title: webhook symbol を broker ticker としてそのまま利用する
status: wip
---

# 概要

TradingView webhook の `symbol` に `bitflyer:FX_BTC_JPY` や `saxo:CfdOnIndex:4911` のような broker 側で処理しやすい正規値が入る前提に変更し、bitflyer の ticker 変換マップに依存しないようにする。

# 背景

既存の bitflyer 実装では webhook 由来の ticker を `TICKER_PRODUCT_CODE_MAP` で product_code に変換していた。今後は入力側で正しい broker ticker を送るため、アプリケーション側の個別マッピングを廃止して挙動を単純化する。

# 実装/修正プラン

- bitflyer の `TICKER_PRODUCT_CODE_MAP` を削除し、ticker を product_code として直接利用する
- webhook 仕様とテストを新しい `symbol` 前提に合わせる
- `mise run test` で確認する

# ログ

## 2026-06-09 16:01 Codex GPT-5
実装開始。webhook から broker ticker として正規値を受け取る前提に合わせ、bitflyer の ticker/product_code マッピング依存を除去する。

## 2026-06-09 16:03 Codex GPT-5
bitflyer の `TICKER_PRODUCT_CODE_MAP` と正規化フォールバックを削除し、`order.ticker` を bitflyer `product_code` としてそのまま使う実装に変更した。関連テストは `FX_BTC_JPY` / `BTC_JPY` の正規 ticker 前提へ更新し、webhook 仕様ドキュメントにも broker 側の正規 ticker を指定する旨と例を反映した。`mise run test` は成功。
