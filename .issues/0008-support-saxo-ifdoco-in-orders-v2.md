---
title: Saxo の IFDOCO 注文に関する orders_v2 対応を行う
status: wip
---

# 概要

Saxo で発生する IFDOCO 注文について、`orders_v2` への保存・同期・更新の流れを整理し、entry / exit の両方を他ブローカーと同様に追跡できるようにする。

# 背景

- 現在 `orders_v2` では bitFlyer 側の IFDOCO 対応を中心に改善が進んでいる
- 一方で Saxo については、IFDOCO の親子注文構造、約定情報の取得経路、`orders_v2` へのマッピング方針が未整理
- 既存 issue でも「Saxo の同様の箇所を調査・修正」は未対応として残っている
- Saxo 側の order lifecycle を踏まえずに場当たり対応すると、entry / exit の紐付け誤りや `executed_size` / `executed_price` / `executed_at` の欠落につながる

# 実装/修正プラン

- [x] Saxo ブローカー実装で IFDOCO 相当の注文・約定取得経路を特定する
- [x] 親注文・利確注文・損切注文の識別方法と紐付けキーを整理する
- [x] `orders_v2` に必要な項目 (`status`, `requested_size`, `executed_size`, `executed_price`, `executed_at`) をどこから取得するか定義する
- [x] entry / exit の保存タイミングと再同期方針を決める
- [x] 部分約定・キャンセル・片側約定後の残注文キャンセルなど、IFDOCO 特有の状態遷移を確認する
- [x] 必要な実装を追加し、Saxo の IFDOCO を `orders_v2` で整合的に扱えるようにする
- [x] テストを追加し、少なくとも entry 約定、exit 約定、片側約定後の残注文処理を検証する

# 確認したい論点

- Saxo における IFDOCO の API 表現が、親注文 + 関連注文なのか、strategy/order group としてまとまっているのか
- exit の約定を親注文起点で追うべきか、子注文起点で追うべきか
- `orders_v2` の 1 レコード 1 注文モデルを維持したまま表現できるか
- Webhook 受信時点で保持しているメタデータだけで紐付けが足りるか

# ログ

## 2026-06-01 00:32:29 GitHub Copilot GPT-5.4

起票した: Saxo の IFDOCO 注文について、`orders_v2` での entry / exit 同期方針が未整理であり、bitFlyer 側で進めた IFDOCO 対応と同等の追跡性を確保するため。特に、親子注文の紐付け方法、約定情報の取得元、部分約定や片側約定後の状態遷移を明確にした上で実装する必要がある。

## 2026-06-09 10:36 Codex GPT-5

0015 と重複する範囲を進めた。Saxo の IFDOCO 相当注文は Market entry に related orders (`Orders`) を付ける形として扱い、`saxo_order_v1` metadata に entry order id と `TAKE_PROFIT` / `STOP_LOSS` の expected/resolved order id を保存する方針で整理済み。entry 同期は `getExecutionPriceForOrderV2(order)`、exit 同期は `getClosingExecutionForOrderV2(order)` で `orders_v2` context と metadata を使う。cron の `closingExecutionFetchers` には Saxo が登録済み。

Saxo の audit activity からは現時点で正確な fill amount を取得していないため、同期数量は related order の expected size と親注文の requested size を使う。related order id が発注レスポンスに含まれない場合は `resolved.order_id = null` のまま保持し、exit 同期は安全側で no-op にする。片側 exit のみ約定してもう片側に audit activity がない場合、その約定だけを exit レコードに反映するテストを追加した。Saxo IFDOCO のフローは `docs/ifdoco-exit-flow.md` に追記したため、0008 はクローズ判断可能な状態。
