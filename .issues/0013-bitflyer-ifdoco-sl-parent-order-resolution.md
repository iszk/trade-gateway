---
title: bitFlyer IFDOCO の SL 決済時に親注文を正しく解決する
status: wip
---

# 概要

bitFlyer の IFDOCO で SL 側がトリガーされて成行決済された場合、既存の broker order metadata ベースの子注文追跡では親注文の完了を検知できず、親注文が `MONITORING` のまま残り続ける。

# 背景

bitFlyer の IFDOCO では、SL の trigger price に触れたタイミングで market 注文が作成される。

そのため、親注文に紐づく SL の `child_order_id` および `child_order_acceptance_id` が存在しない状態で broker order metadata が作成されることがある。

現状は `provider_order_ids[0]` の `parent_order_acceptance_id` から親注文配下の子注文一覧を取得する経路はあるが、broker order metadata の expected 条件と実際の子注文の照合が SL 成行化ケースに対して厳しすぎる。

特に SL が `MARKET` 子注文として返り、かつ `trigger_price` が取得できない場合、expected 側の `condition_type: STOP` / `trigger_price` と一致せず、該当 exit の `child_order_acceptance_id` を解決できない。その結果、約定取得に進めず、親注文が `MONITORING` のまま残り続ける。

# 実装/修正プラン

- 既存の `order_v2.provider_order_ids[0]` → `/v1/me/getparentorder` → `/v1/me/getchildorders` の経路は維持する
- `getchildorders` で返る SL 決済子注文が `MARKET` かつ `trigger_price` なしの場合でも、side / size / 未使用 acceptance_id / exit ロールを元に安全に解決できるようにする
- 候補が複数ある曖昧なケースでは自動解決せず、次回監視に回す
- SL MARKET 化かつ `trigger_price` 欠落の再現テストを追加する
- 実装に合わせて `docs/ifdoco-exit-flow.md` を更新する

# ログ

## 2026-06-03 15:44 Codex GPT-5
実装開始。既存コードでは親注文受付IDから親注文IDを解決し、子注文一覧を取得する経路は既に存在するため、issue の実装プランを実態に合わせて修正した。主な対応対象は、SL が MARKET 子注文として返り trigger_price が取得できない場合の exit acceptance_id 解決。

## 2026-06-03 15:45 Codex GPT-5
`BitflyerClient.getClosingExecutionForOrderV2` に、SL 決済子注文が `MARKET` かつ `trigger_price` なしで返るケースのテストを追加した。実装では通常の expected 条件による照合を維持しつつ、`STOP_LOSS` / `STOP` の expected に対して、side / size が一致し、未使用の `COMPLETED` な `MARKET` 子注文が一意に見つかる場合のみ解決できるようにした。曖昧な複数候補は従来通り解決しない。

`docs/ifdoco-exit-flow.md` に SL MARKET 化時の照合ルールを追記した。`mise run test` は通常実行だと `/tmp` が存在しないため mise の一時ディレクトリ作成で失敗したが、`TMPDIR=/var/tmp mise run test` で全 138 件パスした。
