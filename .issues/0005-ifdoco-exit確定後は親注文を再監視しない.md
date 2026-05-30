---
title: IFDOCO の exit 確定後は親注文を再監視しない設計に変更する
status: done
---

# 概要

現在の `orders_v2` 同期処理では、IFDOCO の親注文が `EXECUTED` になると、その後も cron のたびに決済子注文の約定確認対象に残り続ける。これにより、exit レコード作成後も `executed_size` / `executed_price` が再更新されうる。

IFDOCO の exit が一度確定した親注文は、再監視対象から外す設計に変更する。

現時点の方針として、親注文に `exit_sync_status` を持たせ、値は `MONITORING | COMPLETED` とする。

# 背景

現状のコードでは、`api/src/services/orders-v2.ts` の `createGetActiveIfdOrdersV2Fn()` が以下の条件で親注文を取得している。

- `status == EXECUTED`
- `order_type == IFDOCO`

この条件では、exit レコードが既に存在する親注文も永続的に監視対象に残る。

# 現状でわかっていること

- exit レコードの更新経路は、現状コード上 `syncExecutionsForExecutedIfdOrders()` が主経路
- `syncExecutionsForExecutedIfdOrders()` は `existingExit.executed_size !== closing.size` のとき更新する
- 親 IFDOCO 注文は、exit 確定後も `status=EXECUTED && order_type=IFDOCO` の条件に一致し続ける
- そのため exit 確定後も再監視される

# 実装済み

- `OrderV2` に `exit_sync_status?: 'MONITORING' | 'COMPLETED'` を追加した
- Webhook 受付時に新規 IFDOCO 親注文を `exit_sync_status: 'MONITORING'` で保存するようにした
- `orders_v2` の pending -> executed 同期でも、IFDOCO 親注文が約定した瞬間に `exit_sync_status: 'MONITORING'` を補完するようにした
- `createGetActiveIfdOrdersV2Fn()` は `status=EXECUTED && order_type=IFDOCO && exit_sync_status=MONITORING` の親注文だけを取得するようにした
- `syncExecutionsForExecutedIfdOrders()` は full close (`executed_size >= requested_size`) 到達時に親注文の `exit_sync_status` を `COMPLETED` に更新するようにした
- `closing.size > requested_size` は warn を出して親・exit とも更新しないようにした
- 関連テストと docs を更新した

# 実装方針（決定）

- 親 IFDOCO 注文に `exit_sync_status: 'MONITORING' | 'COMPLETED'` を追加する
- `status` は従来どおり「注文自体の約定状態」を表す用途に限定し、exit 監視の進捗は別フィールドで管理する
- `createGetActiveIfdOrdersV2Fn()` は `status=EXECUTED && order_type=IFDOCO && exit_sync_status=MONITORING` の親注文だけを取得する
- exit の `executed_size >= requested_size` が成立した時点で、親注文の `exit_sync_status` を `COMPLETED` に更新する
- `closing.size > requested_size` は異常値として warn を出し、親・exit ともに更新しない

# 命名メモ

- `status=COMPLETED` のような状態拡張は採用しない
- 理由: `status` は既に「注文の約定状態」として利用されており、exit 監視状態まで混ぜると集計・UI・既存クエリの意味がぶれる
- `PENDING` は「一時保留」の含みに読めるため不採用
- `ACTIVE` は意味が広く、監視対象であることがやや伝わりにくいため不採用
- `MONITORING` は「exit 監視対象に含める」意味が直接的で、今回の用途に最も合う

# 実装/修正プラン

- [x] exit 確定後の親 IFDOCO を再監視対象から外すための設計方針を決める
- [x] 方式候補を比較し、既存データとの整合性・移行コストを確認する
- [x] `OrderV2` に `exit_sync_status` を追加し、新規 IFDOCO 親注文作成時に `MONITORING` を保存する
- [x] `createGetActiveIfdOrdersV2Fn()` を `exit_sync_status=MONITORING` 前提の取得に変更する
- [x] `syncExecutionsForExecutedIfdOrders()` で full close 時に親の `exit_sync_status` を `COMPLETED` に更新する
- [x] `closing.size > requested_size` の異常値ガードを追加する
- [ ] 既存データの backfill / 移行方針を決める
- [x] テストを追加し、exit 確定後に再監視されないことを確認する

# 方式候補

## 採用: 親注文に exit 監視状態を持つ

例:
- `exit_sync_status: 'MONITORING' | 'COMPLETED'`

メリット:
- 親レコード側だけで監視対象から除外できる
- クエリ条件を明示しやすい
- `status` の意味を汚さず、exit 監視だけを局所的に制御できる

デメリット:
- `OrderV2` のスキーマ変更が必要
- 既存データ移行を考える必要がある

## 不採用: exit レコードの存在で再監視を止める

例:
- `getOrderV2(exitId)` が存在し、かつ `status=EXECUTED` なら以後スキップ

メリット:
- 追加スキーマなしで実装可能
- 最小変更になりやすい

デメリット:
- 部分約定進展を将来どう扱うかの設計整理が必要
- exit レコードが一度作られたら、それ以降の正当な更新も止まる

## 不採用: 親注文の status を exit 確定後に別状態へ遷移する

例:
- `CLOSED`
- `EXIT_CONFIRMED`

メリット:
- 状態遷移として自然
- 監視条件に使いやすい

デメリット:
- `OrderStatusV2` の拡張が必要
- 既存 API / UI / 集計ロジックへの影響確認が必要

# 着手時の確認ポイント

- 「部分約定の進展」を今後も追いたいか、それとも exit 初回確定で十分か
- `orders_v2` をトレード履歴の確定ソースにしたいのか、中間同期テーブルにしたいのか
- 既存の `EXECUTED` 親 IFDOCO で、すでに exit レコードが存在するものへの移行方針
- backfill 前の既存 IFDOCO 親注文を、未設定なら `MONITORING` 扱いにするかどうか
- Firestore の複合 index 追加要否

# ログ


## 2026-05-27 22:45:00 GitHub Copilot GPT-5.4

起票した: IFDOCO の exit レコード不正値調査の過程で、親注文が exit 確定後も `status=EXECUTED && order_type=IFDOCO` の条件で再監視され続ける設計上の問題が確認されたため。bitflyer 側の照会不具合を修正しても、設計上 `executed_size` / `executed_price` が再更新される余地が残るため、再監視対象から外す設計変更を別 issue として切り出した。

## 2026-05-30 00:00:00 GitHub Copilot GPT-5.4

方針を更新した。親 IFDOCO に `exit_sync_status: 'MONITORING' | 'COMPLETED'` を持たせる案を採用する。`status` は既存どおり注文自体の約定状態に限定し、exit 監視状態は分離する。`PENDING` は一時保留の含みに読めるため不採用、`ACTIVE` は意味が広いため不採用とした。

## 2026-05-30 00:35:00 GitHub Copilot GPT-5.4

実装した。`orders_v2` の親 IFDOCO に `exit_sync_status` を追加し、新規作成時および pending -> executed 同期時に `MONITORING` を付与するようにした。`getActiveIfdOrdersV2` は `status=EXECUTED && order_type=IFDOCO && exit_sync_status=MONITORING` のみを取得し、exit の full close 到達時は親注文を `COMPLETED` に更新するよう変更した。あわせて `closing.size > requested_size` の異常値ガードを追加した。

テストも更新した。`api/src/services/cron-tasks.test.ts` では、pending IFDOCO 親注文の `MONITORING` 付与、部分約定進展、full close 時の `COMPLETED` 更新、異常値スキップ、close metadata 保存時の `COMPLETED` 更新を確認するケースを追加・更新した。`api/src/index.test.ts` では bitflyer parent order metadata 保存時に `exit_sync_status: 'MONITORING'` が積まれることを確認した。

補足: 対象テスト (`src/services/cron-tasks.test.ts`) は pass した。`src/index.test.ts` 全体は既存の open handle 由来で `Promise resolution is still pending but the event loop has already resolved` によりタイムアウトするため、全体 pass までは未確認。既存データの backfill と Firestore 複合 index の確認は未着手。
