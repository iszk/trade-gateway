---
title: bitFlyer IFDOCO の SL 決済時に親注文を正しく解決する
status: todo
---

# 概要

bitFlyer の IFDOCO で SL 側がトリガーされて成行決済された場合、既存の broker order metadata ベースの子注文追跡では親注文の完了を検知できず、親注文が `MONITORING` のまま残り続ける。

# 背景

bitFlyer の IFDOCO では、SL の trigger price に触れたタイミングで market 注文が作成される。

そのため、親注文に紐づく SL の `child_order_id` および `child_order_acceptance_id` が存在しない状態で broker order metadata が作成されることがある。

現状は broker order metadata から子注文を検索しているため、SL で決済されたケースでは該当注文を解決できず、親注文が `MONITORING` のままになり、子注文取得を延々と繰り返してしまう。

# 実装/修正プラン

- broker order metadata を起点にせず、`order_v2.provider_order_ids[0]` に入っている `parent_order_acceptance_id` から `/v1/me/getparentorder?parent_order_acceptance_id=XXX` を呼び出して `parent_order_id` を取得する
- 取得した `parent_order_id` を使って `/v1/me/getchildorders?product_code=FX_BTC_JPY&parent_order_id=JCPxxxx` を呼び出し、実際の子注文一覧を取得する
- SL が market 注文として生成されるケースでも親注文の完了判定に到達できるよう、bitFlyer 向けの監視ロジックとテストを更新する

# ログ
