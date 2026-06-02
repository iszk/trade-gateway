# IFDOCO Exit レコード作成フロー（bitflyer）

## 概要

IFDOCO 注文の親レコードが `orders_v2` に存在している状態で、決済（exit）注文が約定した際に exit レコードを `orders_v2` に作成するまでの流れを説明します。

## 前提条件

`orders_v2` に以下の状態の親レコードが存在すること：

| フィールド | 値 |
|---|---|
| `order_type` | `'IFDOCO'` |
| `status` | `'EXECUTED'` |
| `exit_sync_status` | `'MONITORING'` |
| `broker` | `'bitflyer'` |

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

### 4. bitflyer API で決済約定を取得（`getClosingExecutionForOrderV2`）

`broker_order_metadata.kind === 'bitflyer_parent_order_v1'` のケース（通常パス）：

#### 4-1. 子注文の acceptance_id 解決

`metadata.exits` に `resolved.acceptance_id === null` のものがあれば：

1. `GET /v1/me/getparentorder` で親注文情報を取得
2. `GET /v1/me/getchildorders` で子注文一覧を取得
3. `expected`（side / size / condition_type / price / trigger_price）でマッチングして acceptance_id を解決

#### 4-2. 約定情報の取得

解決済みの各 exit の `acceptance_id` に対し `GET /v1/me/getexecutions?child_order_acceptance_id=...` を呼ぶ。

全ての exit の約定を **加重平均価格・合計数量** で集計して返す。

#### 4-3. 未約定の場合

`execution: null` → cron 処理はスキップ（次回まで待機）。

> **Note**: `broker_order_metadata` が `bitflyer_parent_order_v1` でない場合は `getClosingExecution()` にフォールバック。こちらは `child_order_type !== 'MARKET'` かつ `child_order_state === 'COMPLETED'` の子注文を対象にする。

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
            ├─ getClosingExecutionForOrderV2(order)  [bitflyer API]
            │    ├─ acceptance_id 未解決 → getchildorders で解決
            │    └─ getexecutions per exit → 合算
            ├─ [skip] closing == null
            ├─ [skip] closing.size > requested_size + ε
            ├─ [skip] 既存 exit と executed_size の差 < ε
            ├─ addOrderV2({id: "${id}-exit", ...})  ← exit レコード新規作成
            │    または updateOrderV2(exitId, {...})  ← 部分約定の更新
            └─ [完全約定時] updateOrderV2(order.id, { exit_sync_status: 'COMPLETED' })
```

## 部分約定への対応

bitflyer では IFDOCO の exit 注文（STOP / LIMIT）が部分約定する可能性があります。

- **初回約定時**：exit レコードを新規作成（`executed_size` は部分約定数量）
- **約定進展時**：既存 exit レコードの `executed_size` / `executed_price` を更新
- **全約定完了時**：親レコードの `exit_sync_status` を `'COMPLETED'` に更新

このため、cron は exit が完了するまで繰り返し実行され、約定の進展を追跡します。

## 注意事項

- `broker_order_metadata` が正しく設定されていない場合、子注文の識別に失敗する可能性があります
- bitflyer API のレート制限により、大量の IFDOCO 注文を同時に処理する場合は遅延が発生する可能性があります
- `EPSILON = 0.00000001` は浮動小数点の精度誤差を考慮した値です
