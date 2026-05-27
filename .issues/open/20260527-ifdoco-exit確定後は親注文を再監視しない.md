# IFDOCO の exit 確定後は親注文を再監視しない設計に変更する

## 概要

現在の `orders_v2` 同期処理では、IFDOCO の親注文が `EXECUTED` になると、その後も cron のたびに決済子注文の約定確認対象に残り続ける。これにより、exit レコード作成後も `executed_size` / `executed_price` が再更新されうる。

IFDOCO の exit が一度確定した親注文は、再監視対象から外す設計に変更する。

## 背景

現状のコードでは、`api/src/services/orders-v2.ts` の `createGetActiveIfdOrdersV2Fn()` が以下の条件で親注文を取得している。

- `status == EXECUTED`
- `order_type == IFDOCO`

この条件では、exit レコードが既に存在する親注文も永続的に監視対象に残る。

さらに `api/src/services/cron-tasks.ts` の `syncExecutionsForExecutedIfdOrders()` では、毎回 `getClosingExecution()` を呼び、既存 exit レコードの `executed_size` と今回取得した `closing.size` が一致しない限り `updateOrderV2()` で上書き更新する。

そのため、bitflyer API 側の返却内容が何らかの理由で変動した場合、

- ある時点では `executed_size = 0.008`
- 後の時点では `executed_size = 0.011`

のように、exit レコードが再更新されることがありうる。

「毎 cron 必ず増える」のではなく「`getClosingExecution()` の返り値が変わった回だけ更新される」ため、不定期に値が増える現象とも整合する。

## 現状でわかっていること

- exit レコードの更新経路は、現状コード上 `syncExecutionsForExecutedIfdOrders()` が主経路
- `syncExecutionsForExecutedIfdOrders()` は `existingExit.executed_size !== closing.size` のとき更新する
- 親 IFDOCO 注文は、exit 確定後も `status=EXECUTED && order_type=IFDOCO` の条件に一致し続ける
- そのため exit 確定後も再監視される
- bitflyer 側では以下の不具合をすでに修正済み
  - `getchildorders` のレスポンス順依存
  - `ticker -> product_code` 正規化漏れ
  - `parent_order_acceptance_id (JRF...)` で `getchildorders` を引いていた問題
- それでも設計上、exit 確定後に再更新される余地は残っている
- 現状は `closing.size > requested_size` を防ぐガードもない

## 実装/修正プラン

- [ ] exit 確定後の親 IFDOCO を再監視対象から外すための設計方針を決める
- [ ] 方式候補を比較し、既存データとの整合性・移行コストを確認する
- [ ] 選択した方式で `createGetActiveIfdOrdersV2Fn()` / `syncExecutionsForExecutedIfdOrders()` を修正する
- [ ] `closing.size > requested_size` の異常値ガードを追加する
- [ ] テストを追加し、exit 確定後に再監視されないことを確認する

## 方式候補

### 案1: 親注文に「exit 同期済み」フラグを持つ

例:
- `exit_synced: boolean`
- `exit_completed_at: Date | null`

メリット:
- 親レコード側だけで監視対象から除外できる
- クエリ条件を明示しやすい

デメリット:
- `OrderV2` のスキーマ変更が必要
- 既存データ移行を考える必要がある

### 案2: exit レコードの存在で再監視を止める

例:
- `getOrderV2(exitId)` が存在し、かつ `status=EXECUTED` なら以後スキップ

メリット:
- 追加スキーマなしで実装可能
- 最小変更になりやすい

デメリット:
- 部分約定進展を将来どう扱うかの設計整理が必要
- exit レコードが一度作られたら、それ以降の正当な更新も止まる

### 案3: 親注文の status を exit 確定後に別状態へ遷移する

例:
- `CLOSED`
- `EXIT_CONFIRMED`

メリット:
- 状態遷移として自然
- 監視条件に使いやすい

デメリット:
- `OrderStatusV2` の拡張が必要
- 既存 API / UI / 集計ロジックへの影響確認が必要

## 着手時の確認ポイント

- 「部分約定の進展」を今後も追いたいか、それとも exit 初回確定で十分か
- `orders_v2` をトレード履歴の確定ソースにしたいのか、中間同期テーブルにしたいのか
- 既存の `EXECUTED` 親 IFDOCO で、すでに exit レコードが存在するものへの移行方針
- UI / stats 側で親 IFDOCO の状態変更を参照していないか

## ログ

### 2026-05-27 22:45:00 GitHub Copilot GPT-5.4

起票した: IFDOCO の exit レコード不正値調査の過程で、親注文が exit 確定後も `status=EXECUTED && order_type=IFDOCO` の条件で再監視され続ける設計上の問題が確認されたため。bitflyer 側の照会不具合を修正しても、設計上 `executed_size` / `executed_price` が再更新される余地が残るため、再監視対象から外す設計変更を別 issue として切り出した。
