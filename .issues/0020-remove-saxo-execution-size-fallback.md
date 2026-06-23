---
title: Saxo の約定数量を requested_size フォールバックに頼らず取得する
status: todo
---

# 概要

Saxo の orders_v2 用 fetcher で `execution.size || order.requested_size` や `Math.min(exit.expected.size, order.requested_size)` にフォールバックしている箇所を廃止する。

対象:

- `api/src/brokers/saxo.ts`
  - `getExecutionPriceForOrderV2()` の `execution.size || order.requested_size`
  - `getClosingExecutionForOrderV2()` の `execution.size || Math.min(...)`
- Saxo 関連テストの `requested_size fallback` 前提

# 背景

現在の Saxo audit 経路は fill の価格と時刻を取れるが、数量は暫定的に `0` としている。呼び出し元が `requested_size` を使って補完するため、部分約定・一部決済・複数 related order の正確な数量表現が曖昧になる。新ロジックのみに倒すなら、Saxo も broker API から数量を取るか、数量が取れない場合は約定確定扱いしない方針にする必要がある。

# 実装/修正プラン

- [ ] Saxo の audit/order detail から約定数量を取得できる API レスポンス形状を確認する
- [ ] `SaxoOrderActivity` 型に数量フィールドがある場合は型を拡張する
- [ ] audit だけで不足する場合は order detail / trade endpoint など別 endpoint を使う
- [ ] 数量が取得できない場合は `execution: null` にするか、エラー/警告扱いにするか決める
- [ ] `getExecutionPriceForOrderV2()` と `getClosingExecutionForOrderV2()` から requested_size 補完を削除する
- [ ] entry / exit / 部分約定の Saxo テストを数量取得前提に更新する
- [ ] `docs/ifdoco-exit-flow.md` の Saxo 数量に関する注意書きを更新する
- [ ] `mise run test` を通す

# ログ

## 2026-06-11 00:05 Codex GPT-5

起票した。`saxo.ts:730` 付近で price が取れた場合に `size: 0` を返し、`saxo.ts:763` と `saxo.ts:790` で requested_size / expected.size へ補完している。これは「新ロジックがなければ旧・暫定値へ戻る」系の互換処理で、orders_v2 を実約定ベースにするうえでは別粒度で解消する必要がある。

## 2026-06-23 16:18 Codex GPT-5

issue 0019 後の未使用メソッド削除で Saxo の旧 `getExecutionPrice()` は削除済みになった。この issue の残件は、orders_v2 用の `getExecutionPriceForOrderV2()` / `getClosingExecutionForOrderV2()` 内に残る requested_size / expected.size 補完の廃止に絞る。
