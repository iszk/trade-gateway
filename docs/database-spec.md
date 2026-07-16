# DB 仕様（MVP / Firestore）

## 目的
webhook 重複防止、発注監査、注文状態、銘柄制御、Saxo 認証状態、cron 実行状態に必要なデータモデルを定義する。

## 採用 DB
- Firestore（Native mode）

## 方針
- すべての日時は UTC で保存する
- MVP ではコレクション設計を最小限にし、過剰な正規化は行わない
- 整合性は Firestore のトランザクションとアプリケーション制御で担保する
- Saxo 認証トークンは `saxo_auth_data/saxo_auth` の `encryptedTokens` v1 として暗号化保存し、平文 token field は保存しない

## コレクション定義（論理）

## 1. `webhook_events`
受信 webhook の受付記録と重複判定に利用する。

### ドキュメント ID
- `{broker}:{symbol}:{event_id}`
- 例: `bitflyer:BTC_JPY:evt-001`

### フィールド
- `event_id` (string, required)
- `source` (string, required)
- `broker` (string, required)
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
- `{broker}:{symbol}:{event_id}` をドキュメント ID とし、作成時は存在しないことを前提条件にする
- 既存ドキュメントがある場合は重複として扱い、API は `409` を返す
- 重複イベント自体は `webhook_events` に新規保存しない（監査はアプリログで補完）

## 2. `order_dispatch_logs`
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

## 3. `orders_v2`
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
- `execution_costs` (map, optional)
  - `commission` (number, optional) — broker execution が返した明示 commission の累積値。`0` は known zero、フィールド不在は unknown
- `executed_at` (timestamp, optional) — `status=EXECUTED` では required
- `status` (string, required) — `PENDING` | `EXECUTED` | `FAILED` | `CANCELED`
- `exit_sync_status` (string, optional) — `MONITORING` | `COMPLETED`
- `provider_order_ids` (string[], required)
- `broker_order_metadata` (map, optional)
  - `bitflyer_parent_order_v1`: parent acceptance id、entry 子注文、TP/SL 子注文の expected/resolved acceptance id を保持する
  - `saxo_order_v1`: entry order id、`ExternalReference`、Saxo related orders の expected/resolved order id を保持する。related order を持たない Saxo MARKET 注文でも entry 同期のため保存する。Saxo の発注レスポンスで related order id が返らない場合、resolved order id は `null` のままとし、exit 同期は安全に no-op する。現状は Saxo 1アカウント前提のため account/client は保存していない。複数アカウント対応時は [saxo.md](./saxo.md) を参照して metadata と polling 状態を account/client ごとに分離する
- `created_at` (timestamp, required)
- `updated_at` (timestamp, required)

### 制約
- 親注文・exit 注文ともにドキュメント ID を一意キーとして upsert / update する
- クローズ済みトレードの read model は別コレクションに保存せず、`orders_v2` から再計算する
- 一覧・統計・トレード再構成の日時基準は `executed_at` とする。`status=EXECUTED` で `executed_at` が欠落している既存データは集計対象外とし、`created_at` へはフォールバックしない
- cron による `orders_v2` の約定・exit 同期は `broker_order_metadata` を前提にする。metadata が未設定、または broker が期待する `kind` ではない注文は warn ログを出して同期を no-op とし、旧 order id ベースの探索へフォールバックしない
- `execution_costs` と `execution_costs.commission` は optional とする。Firestore 上で `execution_costs` またはその `commission` field が未設定の場合は、legacy order、broker 未対応、約定情報の欠落などで値が unknown であることを表し、`0` とは区別する。注文更新 API の DTO では DB 上の未設定を `execution_costs: { commission: null }` に正規化して公開する（[注文更新 API OpenAPI](./openapi/order-updates.openapi.yaml)、[API 利用仕様](./api-spec.md#order-updates-api)）。
- commission は broker execution の明示手数料だけを保存する。spread、funding、slippage、売買価格差などの実質コストはこの field に含めず、現行 schema では保存しない。
- TTL は現時点で使用しない

## 4. `tradable_symbols`
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

## 5. `cron_metadata`
Cloud Run 上で動作するスロットスケジューラーが、各周期タスクの実行済みスロットIDを管理するために使用する（詳細は [slot-scheduler.md](./slot-scheduler.md) を参照）。また、Saxo audit orderactivities の batch polling 状態も保持する。

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
- TTL は不要（上書きで管理）

## 6. `saxo_auth_data`
Saxo の暗号化済み OAuth token と account 情報を保持する。`saxo_auth_data/saxo_auth` の固定ドキュメントを使う。

### ドキュメント ID
- `saxo_auth`（固定）

### フィールド
- `encryptedTokens` (map, required) — encrypted document v1 envelope
  - `version` (number, required) — `1`
  - `algorithm` (string, required) — `aes-256-gcm`
  - `iv` (string, required) — 12 byte random IV の canonical base64
  - `ciphertext` (string, required) — `{ accessToken, refreshToken }` JSON payload の暗号文を canonical base64 で保持
  - `authTag` (string, required) — 16 byte authentication tag の canonical base64
- `accessTokenExpiresAt` (number, required) — Unix time milliseconds
- `refreshTokenExpiresAt` (number, required) — Unix time milliseconds
- `accounts` (array, optional)
  - `accountKey` (string, required)
  - `clientKey` (string, required)
  - `legalAssetTypes` (string[], required)
  - `currency` (string, required)
  - `displayName` (string, required)
- `refreshingUntil` (number, optional) — access token refresh の短時間ロック用。成功時は `saveAuth` の上書き保存で消える

### 制約
- 現状は Saxo 1アカウント運用を前提にする
- `accessToken` / `refreshToken` の平文 field は廃止済みで、新規保存・更新では作成しない
- 暗号化鍵は Firestore に保存せず、Secret Manager から `SAXO_TOKEN_ENCRYPTION_KEY` として注入する 32 byte canonical base64 key を使う
- AES-256-GCM の AAD は `saxo_auth_data/saxo_auth:v1` に固定し、token pair だけを暗号化する。期限と account/client metadata は暗号化対象外とする
- access token の期限が近い場合は Firestore transaction で `refreshingUntil` を更新し、複数プロセスの同時 refresh を抑制する
- legacy 平文 document は初回 read 時に検証し、Firestore transaction 内で encrypted document v1 へ全置換する。transaction 競合時は最新 document を再読込し、古い token へ巻き戻さない
- encrypted/plaintext field の混在、不正 schema、鍵の未設定・不正、wrong key、IV/ciphertext/authTag の不正または改ざんは fail-closed とし、平文 fallback や token なしでの継続を行わない
- legacy migration の parse・暗号化・transaction commit が失敗した場合は元 document を変更せず、request を失敗させる
- TTL は使用しない

## 保持期間（MVP）
- `webhook_events`: 90 日
- `order_dispatch_logs`: 180 日
- `orders_v2`: 現時点では明示的な TTL を設定しない
- `tradable_symbols`: 明示的な TTL を設定しない
- `cron_metadata`: TTL なし（上書きで管理）
- `saxo_auth_data`: TTL なし（認証連携中は保持）

## TTL 設計（MVP）
- `webhook_events.expire_at` に `received_at + 90 日` を設定
- `order_dispatch_logs.expire_at` に `created_at + 180 日` を設定
- その他の現行 collection は TTL を使用しない
- Firestore TTL ポリシーは対象コレクションごとに有効化する

## インデックス（MVP）
- Firestore の単一フィールドインデックスはデフォルト利用
- 追加の複合インデックス（必要時のみ）
  - `order_dispatch_logs`: `result` 昇順 + `created_at` 降順
  - `orders_v2`: `status` / `order_type` / `exit_sync_status` の複合条件、または `executed_at` 範囲 + 降順並び替えが必要なクエリで、Firestore から要求された場合に追加する
- `webhook_events`, `tradable_symbols`, `cron_metadata`, `saxo_auth_data` はドキュメント ID 参照または単純な一覧取得を基本とする

## 整合性ルール
1. `webhook_events` のドキュメント ID は `{broker}:{symbol}:{event_id}` とし、同一 broker / symbol / event の重複を拒否する
2. `order_dispatch_logs.event_id` は webhook の `event_id` と同じ値を保存する
3. `orders_v2` は webhook dispatch 成功時のみ作成する
4. `orders_v2` の約定・exit 同期は `broker_order_metadata` を前提にし、metadata 欠落時は安全側で no-op にする
5. `cron_metadata/task_status` の更新は Firestore transaction で行う
6. `saxo_auth_data/saxo_auth.refreshingUntil` の更新は Firestore transaction で行う

## セキュリティ要件（MVP）
- API secret、webhook secret、broker API secret は環境変数で管理し、Firestore に保存しない
- `saxo_auth_data` の OAuth token は AES-256-GCM で暗号化し、暗号鍵は Secret Manager で管理する
- Firestore と Secret Manager のアクセス権限を、それぞれ必要な runtime service account に限定する
- OAuth token endpoint の失敗時は raw response body を Error / logger へ渡さず、HTTP status と安全な固定メッセージだけを記録する

## 廃止済み・未使用コレクション
- `open_trades` と `trade_records` は v1 系 read model として廃止した
- `oidc_connections` は現行ソースコードでは使用していない
- 既存データは移行せず、不要になった時点で手動削除する前提とする
