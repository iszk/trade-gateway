# DB 仕様（MVP / Firestore）

## 目的
認証トークン管理と webhook 重複防止に必要な最小データモデルを定義する。

## 採用 DB
- Firestore（Native mode）

## 方針
- すべての日時は UTC で保存する
- 機密情報（トークン）は暗号化保存を前提とする
- MVP ではコレクション設計を最小限にし、過剰な正規化は行わない
- 整合性は Firestore のトランザクションとアプリケーション制御で担保する

## コレクション定義（論理）

## 1. `oidc_connections`
OpenID 連携情報を保持する。

### ドキュメント ID
- `provider:subject`
- 例: `bitflyer:abc123`

### フィールド
- `provider` (string, required)
- `subject` (string, required)
- `access_token_encrypted` (string, required)
- `refresh_token_encrypted` (string, optional)
- `access_token_expires_at` (timestamp, required)
- `created_at` (timestamp, required)
- `updated_at` (timestamp, required)
- `expire_at` (timestamp, optional, TTL 用)

### 制約
- `provider` と `subject` の組み合わせはドキュメント ID で一意にする

## 2. `webhook_events`
受信 webhook の受付記録と重複判定に利用する。

### ドキュメント ID
- `event_id`

### フィールド
- `event_id` (string, required)
- `source` (string, required, default: `tradingview`)
- `broker` (string, required, default: `bitflyer`)
- `symbol` (string, required)
- `side` (string, required)
- `order_type` (string, required)
- `size` (number, required)
- `occurred_at` (timestamp, required)
- `received_at` (timestamp, required)
- `status` (string, required)
  - `accepted` | `rejected` | `suppressed`
- `rejection_reason` (string, optional)
- `expire_at` (timestamp, required, TTL 用)

### 重複判定仕様
- `event_id` をドキュメント ID とし、作成時は存在しないことを前提条件にする
- 既存ドキュメントがある場合は重複として扱い、API は `409` を返す
- 重複イベント自体は `webhook_events` に新規保存しない（監査はアプリログで補完）

## 3. `order_dispatch_logs`
ブローカーへの発注試行ログを保持する。

### ドキュメント ID
- 自動採番 ID

### フィールド
- `event_id` (string, required)
- `broker` (string, required)
- `ticker` (string, required)
- `side` (string, required) — `BUY` | `SELL`
- `size` (number, required)
- `provider_order_id` (string, optional) — ブローカー側の注文 ID
- `request_payload` (map, required)
- `response_payload` (map, optional)
- `result` (string, required)
  - `success` | `failure` | `suppressed`
- `error_code` (string, optional)
- `created_at` (timestamp, required)
- `expire_at` (timestamp, required, TTL 用)

## 4. `cron_metadata`

Cloud Run 上で動作するスロットスケジューラーが、各周期タスクの実行済みスロットIDを管理するために使用する（詳細は [slot-scheduler.md](./slot-scheduler.md) を参照）。

### ドキュメント ID
- `task_status`（固定）
- `saxo_orderactivities_poll_state` — Saxo audit orderactivities の batch polling 状態

### フィールド
`task_status`:

- `last_slot_10m` (number, required) — 10分周期タスクが最後に実行されたスロットID
- `last_slot_1h` (number, required) — 1時間周期タスクが最後に実行されたスロットID
- 新しい周期タスクを追加する場合は、対応する `last_slot_<interval>` フィールドを追加する

`saxo_orderactivities_poll_state`:

- `last_poll_at` (timestamp string, optional) — 最後に Saxo audit orderactivities の batch polling を試行した時刻
- `next_poll_url` (string, optional) — Saxo の `__nextPoll` URL。空文字の場合は未保持として扱う

### 制約
- `task_status` は Firestoreトランザクションを使用して読み書きを行い、重複実行を防止する
- `saxo_orderactivities_poll_state` は Saxo audit polling の cursor/lookback 管理専用で、30分超の実行間隔では `last_poll_at` から30分巻き戻して再取得する
- TTLは不要（上書きで管理）

## 5. `daily_balances`

broker 別の日次残高スナップショットを保持する。`/api/balances` と日次残高保存タスクで利用する。

### ドキュメント ID
- `{YYYY-MM-DD}_{broker}`
- 例: `2026-06-09_bitflyer`, `2026-06-09_saxo`
- `BalanceFetcher.fetchAllBalances()` 1 回の保存では、開始時点の JST 日付を全 broker のキーに共通適用する

### フィールド
- `broker` (string, required)
- `balances` (array, required)
  - `asset` (string, required)
  - `amount` (number, required)
- `updatedAt` (number, required) — Unix time milliseconds
- `date` (string, required) — JST の `YYYY-MM-DD`

### broker 別補足
- bitFlyer は `/v1/me/getbalance` の非ゼロ残高と `/v1/me/getcollateral` の `collateral` を `CFD_JPY` として保存する
- Saxo は `/port/v1/balances/me` の `CashBalance`, `CashAvailableForTrading`, `TotalValue`, `NetEquity` を非ゼロ項目のみ保存する

## 6. `orders_v2`

注文の source of truth。webhook 受付時に親注文を保存し、cron が約定情報と IFDOCO の exit を同期する。`/api/trade-records*` のクローズ済みトレード一覧・統計は、このコレクションの EXECUTED 注文から FIFO で再構成する。

### ドキュメント ID
- `id`（Webhook の `event_id` など）
- exit 注文は親注文 ID に `-exit` を付与して表現する

### フィールド
- `id` (string, required)
- `strategy` (string, required)
- `broker` (string, required)
- `ticker` (string, required)
- `side` (string, required) — `BUY` | `SELL`
- `order_type` (string, required) — `MARKET` | `IFDOCO` | `LIMIT` | `STOP`
- `requested_size` (number, required)
- `executed_size` (number, required)
- `executed_price` (number | null, required)
- `executed_at` (timestamp, optional)
- `status` (string, required) — `PENDING` | `EXECUTED` | `FAILED` | `CANCELED`
- `exit_sync_status` (string, optional) — `MONITORING` | `COMPLETED`
- `provider_order_ids` (string[], required)
- `broker_order_metadata` (map, optional)
  - `bitflyer_parent_order_v1`: parent acceptance id、entry 子注文、TP/SL 子注文の expected/resolved acceptance id を保持する
  - `saxo_order_v1`: entry order id、`ExternalReference`、Saxo related orders の expected/resolved order id を保持する。Saxo の発注レスポンスで related order id が返らない場合、resolved order id は `null` のままとし、exit 同期は安全に no-op する。現状は Saxo 1アカウント前提のため account/client は保存していない。複数アカウント対応時は [saxo.md](./saxo.md) を参照して metadata と polling 状態を account/client ごとに分離する
- `created_at` (timestamp, required)
- `updated_at` (timestamp, required)

### 制約
- 親注文・exit 注文ともにドキュメント ID を一意キーとして upsert / update する
- クローズ済みトレードの read model は別コレクションに保存せず、`orders_v2` から再計算する
- cron による `orders_v2` の約定・exit 同期は `broker_order_metadata` を前提にする。metadata が未設定、または broker が期待する `kind` ではない注文は warn ログを出して同期を no-op とし、旧 order id ベースの探索へフォールバックしない
- TTL は現時点で使用しない

## 保持期間（MVP）
- `webhook_events`: 90 日
- `order_dispatch_logs`: 180 日
- `orders_v2`: 現時点では明示的な TTL を設定しない
- `oidc_connections`: 連携中は保持、削除要求時に削除

## TTL 設計（MVP）
- `webhook_events.expire_at` に `received_at + 90 日` を設定
- `order_dispatch_logs.expire_at` に `created_at + 180 日` を設定
- `orders_v2` は TTL を使用しない
- `oidc_connections` は通常 TTL 対象外（削除要求時に明示削除）
- Firestore TTL ポリシーは対象コレクションごとに有効化する

## インデックス（MVP）
- Firestore の単一フィールドインデックスはデフォルト利用
- 追加の複合インデックス（必要時のみ）
  - `order_dispatch_logs`: `result` 昇順 + `created_at` 降順
- `oidc_connections` はドキュメント ID 参照を基本とし、複合インデックスは不要

## 整合性ルール
1. `webhook_events` のドキュメント ID は API の重複判定キー `event_id` と一致させる
2. `order_dispatch_logs.event_id` は必ず既存 `webhook_events.event_id` に紐付ける（アプリケーションで検証）
3. トークン平文保存を禁止する
4. `webhook_events` 作成と初回処理状態更新は同一トランザクションで行う

## セキュリティ要件（MVP）
- `access_token_encrypted` と `refresh_token_encrypted` は暗号化済み文字列のみ保存
- 鍵管理は Cloud KMS を利用する
- 復号は発注時など必要最小限のタイミングに限定する

## 廃止済みコレクション
- `open_trades` と `trade_records` は v1 系 read model として廃止した
- 既存データは移行せず、不要になった時点で手動削除する前提とする

## 6. `tradable_symbols`

broker + ticker のメタデータと、symbol 単位の売買停止状態を保持する。

### ドキュメント ID
- `broker:ticker`
- 例: `bitflyer:BTC_JPY`, `saxo:FX:NAS100`
- broker は最初の `:` より前、ticker は最初の `:` より後ろすべて
- `/` は使用不可

### フィールド
- `id` (string, required)
- `broker` (string, required)
- `ticker` (string, required)
- `display_name` (string, optional)
- `currency` (string, required) — 例: `JPY`, `USD`
- `note` (string, optional)
- `trade_control` (map, required)
  - `status` (string, required) — `active` | `paused`
  - `reason` (string, optional)
  - `updated_at` (timestamp, required)
  - `updated_by` (string, optional)
- `created_at` (timestamp, required)
- `updated_at` (timestamp, required)

### 制約
- ドキュメントが存在しない symbol は `active` として扱う
- Webhook で未知の symbol を受けた場合、売買処理とは独立して `currency = JPY` のデフォルトレコードを事後作成する
- `currency` は UI 表示・整理用途であり、Webhook の売買判定では参照しない
