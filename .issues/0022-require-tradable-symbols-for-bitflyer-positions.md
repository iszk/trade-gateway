---
title: bitFlyer ポジション取得の固定 ticker フォールバックを廃止する
status: todo
---

# 概要

`PositionFetcher` で `tradable_symbols` から bitFlyer ticker を取得できない場合に `FX_BTC_JPY` へ戻る互換処理を削除し、登録済み symbol のみを取得対象にする。

対象:

- `api/src/services/position-fetcher.ts`
  - `DEFAULT_BITFLYER_POSITION_TICKERS`
  - `getBitflyerPositionTickers()` の空配列・例外時フォールバック
- `api/src/services/position-fetcher.test.ts`
- `docs/api-spec.md` の bitFlyer ポジション取得ルール

# 背景

issue 0015 で bitFlyer ポジション取得は `tradable_symbols` ベースに寄せたが、互換性維持のため symbol が空または取得失敗した場合だけ `FX_BTC_JPY` に戻る。新ロジックのみに倒すなら、設定不備を固定 ticker で隠さず、空配列または明示的な失敗として扱う必要がある。

# 実装/修正プラン

- [ ] `tradable_symbols` 未登録時の期待挙動を決める
- [ ] 方針案: bitFlyer の取得対象は空配列にして、ログで設定不足を通知する
- [ ] `listTradableSymbols()` 失敗時に固定 ticker へ戻らないようにする
- [ ] `BitflyerClient.getPositions([])` の扱いを確認し、必要なら呼び出し前に空配列を返す
- [ ] 既存テストの fallback 期待を削除し、設定不足時の挙動を固定する
- [ ] `docs/api-spec.md` から `FX_BTC_JPY` fallback 記述を削除する
- [ ] `mise run test` を通す

# ログ

## 2026-06-11 00:05 Codex GPT-5

起票した。`cron-tasks.ts:208` と同じ「新しい設定があれば使い、なければ旧固定値へ戻る」系の互換処理として、`PositionFetcher` の bitFlyer ticker 解決に `FX_BTC_JPY` フォールバックが残っている。注文同期とは別ドメインなので、適度な粒度として独立 issue にした。
