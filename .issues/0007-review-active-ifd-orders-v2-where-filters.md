---
title: createGetActiveIfdOrdersV2Fn の where 条件見直しを確認する
status: done
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

- [x] `createGetActiveIfdOrdersV2Fn()` の呼び出し側で、実際に必要な注文集合を整理する
- [x] 現行条件と変更案で取得対象がどう変わるかを具体例ベースで比較する
- [x] Firestore の `!=` 条件の仕様と index 要件を確認する
- [ ] 変更する場合はテストケースを先に追加し、意図しない注文が混ざらないことを検証する
- [x] 変更しない場合は、現行条件を維持する理由をドキュメントまたは issue に残す

# ログ

## 2026-05-30 00:00 GitHub Copilot GPT-5.4

起票した。`createGetActiveIfdOrdersV2Fn()` の監視対象クエリについて、現行の厳密一致条件 (`order_type == IFDOCO`, `exit_sync_status == MONITORING`) を維持すべきか、除外条件 (`order_type != MARKET`, `exit_sync_status != COMPLETED`) に寄せるべきかを確認するための issue。

論点は、監視対象の意味が広がることによる誤取得、`exit_sync_status` 未設定データの扱い、Firestore の `!=` 制約、既存の `MONITORING` / `COMPLETED` 設計との整合性。まだ実装変更はしていない。

## 2026-06-23 15:36 Codex GPT-5

`createGetActiveIfdOrdersV2Fn()` の呼び出し側を確認した。現在は `executeTenMinutelyTask()` の exit 同期でのみ利用され、期待する集合は「親注文が `EXECUTED` 済みで、IFD/IFDOCO の exit 監視がまだ完了していないもの」に限定される。

現行条件の `status == EXECUTED` / `order_type == IFDOCO` / `exit_sync_status == MONITORING` は、`docs/ifdoco-exit-flow.md` の前提条件と一致している。webhook 作成時と PENDING 同期時にも IFD/IFDOCO 親注文へ `MONITORING` を付与する実装になっているため、新規データの監視対象は明示的に表現できている。

変更案の `order_type != MARKET` / `exit_sync_status != COMPLETED` は、Firestore の `!=` がフィールド欠損ドキュメントを返さないため、`exit_sync_status` 未設定の既存データ救済にはならない。また、`order_type != MARKET` は `LIMIT` / `STOP` など将来の非 MARKET 注文も条件上は含み得るため、active IFD order の意味を広げる。複数フィールドの inequality 条件になるため、現行の equality 条件より index 要件とクエリ制約も重くなる。

結論として、現時点では現行の厳密一致条件を維持する。未設定の既存 `exit_sync_status` を拾う必要がある場合は、クエリ条件を曖昧化するのではなく、対象データを `MONITORING` へ補正する migration または明示的な backfill issue として扱うのが安全。
