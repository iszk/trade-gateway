# DB 仕様（MVP）

## 目的
認証トークン管理と webhook 重複防止に必要な最小データモデルを定義する。

## 方針
- DB 製品は未確定だが、リレーショナルモデルで表現する
- すべての日時は UTC で保存する
- 機密情報（トークン）は暗号化保存を前提とする

## テーブル定義（論理）

## 1. `oidc_connections`
OpenID 連携情報を保持する。

- `id` (string, PK)
- `provider` (string, not null)
- `subject` (string, not null)
- `access_token_encrypted` (string, not null)
- `refresh_token_encrypted` (string, nullable)
- `access_token_expires_at` (timestamp, not null)
- `created_at` (timestamp, not null)
- `updated_at` (timestamp, not null)

制約:
- Unique: `(provider, subject)`

## 2. `webhook_events`
受信 webhook の受付記録と重複判定に利用する。

- `event_id` (string, PK)
- `source` (string, not null, default: `tradingview`)
- `broker` (string, not null, default: `bitflyer`)
- `symbol` (string, not null)
- `side` (string, not null)
- `order_type` (string, not null)
- `size` (decimal, not null)
- `occurred_at` (timestamp, not null)
- `received_at` (timestamp, not null)
- `status` (string, not null)  
  `accepted` | `rejected` | `duplicate`
- `rejection_reason` (string, nullable)

制約:
- Unique: `event_id`

## 3. `order_dispatch_logs`
ブローカーへの発注試行を保持する。

- `id` (string, PK)
- `event_id` (string, not null, FK -> webhook_events.event_id)
- `broker` (string, not null)  
  MVP: `bitflyer`
- `request_payload` (json/string, not null)
- `response_payload` (json/string, nullable)
- `result` (string, not null)  
  `success` | `failure`
- `error_code` (string, nullable)
- `created_at` (timestamp, not null)

## 保持期間（MVP）
- `webhook_events`: 90 日
- `order_dispatch_logs`: 180 日
- `oidc_connections`: 連携中は保持、削除要求時に削除

## インデックス（MVP）
- `webhook_events(received_at)`
- `order_dispatch_logs(event_id)`
- `oidc_connections(provider, subject)`

## 整合性ルール
1. `webhook_events.event_id` は API の重複判定キーと一致させる
2. `order_dispatch_logs.event_id` は必ず既存 `webhook_events` に紐付く
3. トークン平文保存を禁止する
