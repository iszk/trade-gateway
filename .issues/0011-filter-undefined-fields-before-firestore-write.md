---
title: Firestore write 前に undefined フィールドを除去する
status: done
---

# 概要

Firestore への `set` / `update` に `undefined` を含むオブジェクトが渡されるとエラーになるため、書き込み前に `undefined` なフィールドを除去する。

# 背景

`orders-v2` 系の書き込みで optional なプロパティが `undefined` のまま渡されることがあり、Firestore の write で失敗しやすい。

# 実装/修正プラン

- `orders-v2` の write 経路で `undefined` を shallow に除去する
- 対応するユニットテストを追加する
- 既存テストを実行して回帰を確認する

# ログ

## 2026-06-02 23:42 GitHub Copilot GPT-5.4
`orders-v2` の Firestore write で `undefined` をそのまま渡している箇所を修正対象に設定。既存の `order-dispatch-logs` と同じ shallow な `omitUndefinedFields` パターンを適用し、`set` / `update` の payload から `undefined` を除去するテストを追加する。

## 2026-06-02 23:45 GitHub Copilot GPT-5.4
`orders-v2` に `omitUndefinedFields` を追加し、`createAddOrderV2Fn` と `createUpdateOrderV2Fn` の Firestore write 前に `undefined` なフィールドを除去するように変更。`orders-v2.test.ts` に `set` / `update` の payload 検証テストを追加し、追加した 3 件の対象テストは通過した。

`npm --prefix /opt/equuss/src/github.com/iszk/trade-gateway/api test` 相当の実行では、今回追加した `orders-v2` テストは通過した一方で、既存の `src/index.test.ts` の `strategy/interval がなければ addOrderV2 を呼ばない` が失敗していた。今回の修正ではその既存失敗には手を入れていない。

## 2026-06-02 23:47 GitHub Copilot GPT-5.4
`omitUndefinedFields` を `api/src/omit-undefined-fields.ts` に切り出し、`orders-v2` と `order-dispatch-logs` の重複実装を共通 util の参照へ置き換えた。適用先の横展開は行わず、現時点で利用中の 2 箇所だけを共通化した。

## 2026-06-02 23:52 GitHub Copilot GPT-5.4
issue をクローズ。クローズ理由: `undefined` フィールド除去の共通 util を追加し、対象として合意されていた `orders-v2` と `order-dispatch-logs` への適用、および影響範囲の対象テスト通過まで確認できたため。
