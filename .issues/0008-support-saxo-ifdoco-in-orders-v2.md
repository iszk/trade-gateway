---
title: Saxo の IFDOCO 注文に関する orders_v2 対応を行う
status: todo
---

# 概要

Saxo で発生する IFDOCO 注文について、`orders_v2` への保存・同期・更新の流れを整理し、entry / exit の両方を他ブローカーと同様に追跡できるようにする。

# 背景

- 現在 `orders_v2` では bitFlyer 側の IFDOCO 対応を中心に改善が進んでいる
- 一方で Saxo については、IFDOCO の親子注文構造、約定情報の取得経路、`orders_v2` へのマッピング方針が未整理
- 既存 issue でも「Saxo の同様の箇所を調査・修正」は未対応として残っている
- Saxo 側の order lifecycle を踏まえずに場当たり対応すると、entry / exit の紐付け誤りや `executed_size` / `executed_price` / `executed_at` の欠落につながる

# 実装/修正プラン

- [ ] Saxo ブローカー実装で IFDOCO 相当の注文・約定取得経路を特定する
- [ ] 親注文・利確注文・損切注文の識別方法と紐付けキーを整理する
- [ ] `orders_v2` に必要な項目 (`status`, `requested_size`, `executed_size`, `executed_price`, `executed_at`) をどこから取得するか定義する
- [ ] entry / exit の保存タイミングと再同期方針を決める
- [ ] 部分約定・キャンセル・片側約定後の残注文キャンセルなど、IFDOCO 特有の状態遷移を確認する
- [ ] 必要な実装を追加し、Saxo の IFDOCO を `orders_v2` で整合的に扱えるようにする
- [ ] テストを追加し、少なくとも entry 約定、exit 約定、片側約定後の残注文処理を検証する

# 確認したい論点

- Saxo における IFDOCO の API 表現が、親注文 + 関連注文なのか、strategy/order group としてまとまっているのか
- exit の約定を親注文起点で追うべきか、子注文起点で追うべきか
- `orders_v2` の 1 レコード 1 注文モデルを維持したまま表現できるか
- Webhook 受信時点で保持しているメタデータだけで紐付けが足りるか

# ログ

## 2026-06-01 00:32:29 GitHub Copilot GPT-5.4

起票した: Saxo の IFDOCO 注文について、`orders_v2` での entry / exit 同期方針が未整理であり、bitFlyer 側で進めた IFDOCO 対応と同等の追跡性を確保するため。特に、親子注文の紐付け方法、約定情報の取得元、部分約定や片側約定後の状態遷移を明確にした上で実装する必要がある。
