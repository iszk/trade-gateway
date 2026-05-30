---
title: createGetActiveIfdOrdersV2Fn の where 条件見直しを確認する
status: todo
---

# 概要

`api/src/services/orders-v2.ts` の `createGetActiveIfdOrdersV2Fn()` で使っている Firestore の `where` 条件を、現在の厳密一致条件のまま維持すべきか、除外条件ベースに変更すべきかを確認する。

今回の確認対象の変更案は以下。

- `order_type != MARKET`
- `exit_sync_status != COMPLETED`

# 背景

現状の `createGetActiveIfdOrdersV2Fn()` は以下の条件で親注文を取得している。

- `status == EXECUTED`
- `order_type == IFDOCO`
- `exit_sync_status == MONITORING`

一方で、監視対象の定義を「除外したい条件を外す」形で表現したいという観点から、以下のような条件に寄せたほうが運用しやすい可能性がある。

- `order_type != MARKET`
- `exit_sync_status != COMPLETED`

ただし、Firestore の `!=` は欠損フィールドや複合 index、意図しない注文種別の混入に注意が必要なため、単純置換でよいとは限らない。

# 確認したいこと

- `order_type != MARKET` にすると、`IFDOCO` 以外の注文種別まで監視対象に含まれないか
- `exit_sync_status != COMPLETED` にすると、`exit_sync_status` 未設定の既存データをどう扱うべきか
- 現在の `MONITORING` / `COMPLETED` 設計と整合するか
- Firestore で必要になる複合 index やクエリ制約が増えないか
- UI / 集計 / cron の前提として、「active IFD order」の意味が広がりすぎないか

# 実装/修正プラン

- [ ] `createGetActiveIfdOrdersV2Fn()` の呼び出し側で、実際に必要な注文集合を整理する
- [ ] 現行条件と変更案で取得対象がどう変わるかを具体例ベースで比較する
- [ ] Firestore の `!=` 条件の仕様と index 要件を確認する
- [ ] 変更する場合はテストケースを先に追加し、意図しない注文が混ざらないことを検証する
- [ ] 変更しない場合は、現行条件を維持する理由をドキュメントまたは issue に残す

# ログ

## 2026-05-30 00:00 GitHub Copilot GPT-5.4

起票した。`createGetActiveIfdOrdersV2Fn()` の監視対象クエリについて、現行の厳密一致条件 (`order_type == IFDOCO`, `exit_sync_status == MONITORING`) を維持すべきか、除外条件 (`order_type != MARKET`, `exit_sync_status != COMPLETED`) に寄せるべきかを確認するための issue。

論点は、監視対象の意味が広がることによる誤取得、`exit_sync_status` 未設定データの扱い、Firestore の `!=` 制約、既存の `MONITORING` / `COMPLETED` 設計との整合性。まだ実装変更はしていない。
