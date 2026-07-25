# IFDOCO Exit レコード作成フロー

## 概要

IFDOCO 注文の親レコードが `orders_v2` に存在している状態で、決済（exit）注文が約定した際に exit レコードを `orders_v2` に作成するまでの流れを説明します。

entry の約定同期では、cursor polling、OrderId direct recovery、hourly range reconciliation が同じ activity resolver と shared execution apply helper を使う。resolver は `LogId` を dedupe し、複数 fill の数量・加重平均価格・最新約定時刻と、confirmed cancel/expire/rejection の terminal state を共通規則で解決する。

hourly range reconciliation は entry PENDING の missed fill を回復する安全網であり、window end 時点で作成24時間以内の注文だけを対象にする。24時間を超える stale entry は range の不完全履歴で上書きせず、OrderId direct recovery が全履歴を取得して救済する。hourly range は exit related order の direct/range recovery には拡張せず、exit は本書の10分監視フローで扱う。

## 前提条件

`orders_v2` に以下の状態の親レコードが存在すること：

| フィールド | 値 |
|---|---|
| `order_type` | `'IFDOCO'` |
| `status` | `'EXECUTED'` |
| `exit_sync_status` | `'MONITORING'` |
| `broker` | `'bitflyer'` または `'saxo'` |

## フロー

### 1. トリガー：10分ごとの cron

`cron-tasks.ts` の `executeTenMinutelyTask` が実行され、最後のステップとして `syncExecutionsForExecutedIfdOrders` が呼ばれる。

**条件チェック**：`ctx.getActiveIfdOrdersV2` / `addOrderV2` / `updateOrderV2` / `getOrderV2` / `closingExecutionFetchers` が全て設定されている場合のみ実行。

### 2. 対象注文の取得

`getActiveIfdOrdersV2()` で以下の3条件すべてを満たすレコードを Firestore から取得：

- `status == 'EXECUTED'`
- `order_type == 'IFDOCO'`
- `exit_sync_status == 'MONITORING'`

### 3. 既存の exit レコード確認

`exitId = "${order.id}-exit"` で `getOrderV2(exitId)` を呼び、既存の exit レコードの有無を確認。

### 4. ブローカー API で決済約定を取得（`getClosingExecutionForOrderV2`）

#### bitflyer

`broker_order_metadata.kind === 'bitflyer_parent_order_v1'` のケース（通常パス）：

#### 4-1. 子注文の acceptance_id 解決

`metadata.exits` に `resolved.acceptance_id === null` のものがあれば：

1. `GET /v1/me/getparentorder` で親注文情報を取得
2. `GET /v1/me/getchildorders` で子注文一覧を取得
3. `expected`（side / size / condition_type / price / trigger_price）でマッチングして acceptance_id を解決

bitflyer では SL がトリガーされた後、STOP 子注文ではなく MARKET 子注文として返ることがある。この MARKET 子注文に `trigger_price` が含まれない場合でも、`STOP_LOSS` の expected と side / size が一致し、未使用の `COMPLETED` な MARKET 子注文が一意に見つかる場合は、その子注文を SL 決済として解決する。候補が複数ある場合は誤解決を避けるため acceptance_id を更新せず、次回の監視に回す。

#### 4-2. 約定情報の取得

bitFlyer の `GET /v1/me/getexecutions` は `product_code` 単位で batch 取得し、`child_order_acceptance_id` ごとにメモリ上で突合する。batch cache は BitflyerClient インスタンス内のプロセス内 Map で、TTL は 30 秒。entry / exit ともに同じ batch cache を使うため、同一 `product_code` の複数注文を短時間に同期する場合でも `getexecutions` の呼び出し数は注文数に比例しない。

解決済みの各 exit の `acceptance_id` に対応する executions を batch から取り出し、全ての exit の約定を **加重平均価格・合計数量** で集計して返す。

batch 取得はページ上限を持つ。ページ上限に達した場合、またはレスポンスの `id` 欠落でページング継続できない場合は batch を不完全として扱う。不完全 batch の場合は、部分約定の過小集計を避けるため、対象 `acceptance_id` が batch 内に見つかっていても既存の `child_order_acceptance_id` 指定取得へフォールバックする。

#### 4-3. 未約定の場合

`execution: null` → cron 処理はスキップ（次回まで待機）。

`orders_v2` の cron 同期は、ブローカーごとの `getClosingExecutionForOrderV2(order)` を必ず呼び出す。broker 実装内部でも `broker_order_metadata.kind === 'bitflyer_parent_order_v1'` を必須とし、metadata 欠落・不一致時は warn ログを出して no-op にする。旧 parentOrderId/ticker ベースの探索 API は削除済みで、フォールバックしない。

#### Saxo

Saxo は entry の Market order に `Orders` として関連注文を付ける場合がある。`sendMarketOrder` の戻り値から `broker_order_metadata.kind === 'saxo_order_v1'` を保存し、関連注文を持たない単体 MARKET 注文でも entry 同期に必要な metadata を保持する。

| 要素 | 内容 |
|---|---|
| `entry.resolved.order_id` | entry order id |
| `exits[].expected` | `TAKE_PROFIT` / `STOP_LOSS`、side、order type、size、price |
| `exits[].resolved.order_id` | Saxo の related order id。レスポンスに含まれない場合は `null` |
| `external_reference` | Saxo 発注時に付与した `tg:` prefix の識別補助 |

exit 同期では、`cs/v1/audit/orderactivities` を時間範囲または poll cursor で一括取得し、解決済みの related order id と突合する。`FinalFill` または `Fill` の `ExecutionPrice` / `AveragePrice` を約定価格として使い、`FillAmount` を優先して数量を合算する。`FillAmount` がない場合は `FilledAmount` / `Amount` を累積数量として扱う。数量フィールドがないレスポンスは、誤同期を避けるため約定未確定として扱う。

片側の related order だけが約定している場合は、その約定だけを exit レコードへ反映する。もう片側が未約定またはキャンセル済みで audit activity がない場合は無視する。Saxo の発注レスポンスで related order id が返らず `resolved.order_id === null` の場合、誤同期を避けるため exit 同期は no-op になる。
`broker_order_metadata.kind !== 'saxo_order_v1'` の場合も warn ログを出して no-op にし、entry order id だけを使った旧探索へはフォールバックしない。

Saxo metadata の自己修復は、exits が空の単体 `MARKET` entry に限定される。metadata 欠落 IFDOCO や related order の復元、既存 IFDOCO の exit metadata 補完には適用しない。自己修復で保存された metadata は entry の batch / direct / range 同期へ復帰させるが、exit 同期の対象を推測して追加することはない。

### 5. バリデーション

```typescript
closing.size > order.requested_size + EPSILON  // EPSILON = 0.00000001
```

の場合は **警告ログを出してスキップ**（不正データとして処理しない）。

### 6. exit レコードの作成 or 更新

| 状況 | 処理 |
|---|---|
| exit レコードなし | `addOrderV2` で新規作成 |
| exit レコードあり、`executed_size` の差が `EPSILON` 未満 | **スキップ**（変化なし、更新不要） |
| exit レコードあり、`executed_size` が変化している | `updateOrderV2` で `executed_size` / `executed_price` を更新 |

#### 新規作成時の exit レコード内容

| フィールド | 値 |
|---|---|
| `id` | `"${order.id}-exit"` |
| `strategy` | 親レコードの `strategy` |
| `broker` | 親レコードの `broker` |
| `ticker` | 親レコードの `ticker` |
| `side` | 親の `side` を反転（BUY→SELL, SELL→BUY） |
| `order_type` | `'MARKET'` |
| `requested_size` | 親レコードの `requested_size` |
| `executed_size` | `closing.size`（取得した約定数量） |
| `executed_price` | `closing.price`（加重平均価格） |
| `status` | `'EXECUTED'` |
| `exit_sync_status` | `undefined` |
| `provider_order_ids` | `["${providerOrderId}:closing"]` |

#### 更新時の exit レコード内容

| フィールド | 値 |
|---|---|
| `executed_size` | `closing.size`（最新の約定数量） |
| `executed_price` | `closing.price`（最新の加重平均価格） |

### 7. 全約定完了時：親レコードを COMPLETED に更新

```typescript
closing.size >= order.requested_size - EPSILON
```

が満たされた場合、親レコードの `exit_sync_status` を `'MONITORING'` → **`'COMPLETED'`** に更新。

これにより次回 cron の `getActiveIfdOrdersV2()` の取得対象から除外される。

## フロー図

```
[cron 10分ごと]
  └─ syncExecutionsForExecutedIfdOrders
       ├─ getActiveIfdOrdersV2()  ← EXECUTED + IFDOCO + MONITORING
       └─ for each order:
            ├─ getOrderV2("${id}-exit")  ← 既存 exit 確認
            ├─ getClosingExecutionForOrderV2(order)  [broker API]
            │    ├─ bitflyer: acceptance_id 未解決 → getchildorders で解決
            │    ├─ bitflyer: getexecutions per exit → 合算
            │    └─ Saxo: resolved related order id ごとに audit activity を確認
            ├─ [skip] closing == null
            ├─ [skip] closing.size > requested_size + ε
            ├─ [skip] 既存 exit と executed_size の差 < ε
            ├─ addOrderV2({id: "${id}-exit", ...})  ← exit レコード新規作成
            │    または updateOrderV2(exitId, {...})  ← 部分約定の更新
            └─ [完全約定時] updateOrderV2(order.id, { exit_sync_status: 'COMPLETED' })
```

## 部分約定への対応

bitflyer では IFDOCO の exit 注文（STOP / LIMIT）が部分約定する可能性があります。Saxo は audit activity から正確な fill 数量をまだ取得できていないため、現在は related order の expected size を同期数量として扱います。

- **初回約定時**：exit レコードを新規作成（`executed_size` は部分約定数量）
- **約定進展時**：既存 exit レコードの `executed_size` / `executed_price` を更新
- **全約定完了時**：親レコードの `exit_sync_status` を `'COMPLETED'` に更新

このため、cron は exit が完了するまで繰り返し実行され、約定の進展を追跡します。

## 注意事項

- Saxo の単体 MARKET で provider order ID などの安全条件を満たす metadata 欠落 entry は、10分同期で最小 metadata を自己修復します。IFDOCO、related order、別 broker、`DRY_RUN`、provider ID 欠落、malformed / 矛盾 metadata は従来どおり安全側で no-op となり、手動 backfill が必要です
- bitflyer API のレート制限により、大量の IFDOCO 注文を同時に処理する場合は遅延が発生する可能性があります
- Saxo の related order id が発注レスポンスに含まれない場合、exit 同期は安全側で no-op になります
- Saxo の部分約定数量は audit activity だけでは確定できないため、正確な fill amount の取得元が確認できたら同期数量の算出を見直す必要があります
- `EPSILON = 0.00000001` は浮動小数点の精度誤差を考慮した値です
