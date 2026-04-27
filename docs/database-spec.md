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
  - `accepted` | `rejected`
- `rejection_reason` (string, optional)
- `expire_at` (timestamp, required, TTL 用)

### 重複判定仕様
- `event_id` をドキュメント ID とし、作成時は存在しないことを前提条件にする
- 既存ドキュメントがある場合は重複として扱い、API は `409` を返す
- 重複イベント自体は `webhook_events` に新規保存しない（監査はアプリログで補完）

## 3. `order_dispatch_logs`
ブローカーへの発注試行を保持する。cron により約定価格の事後取得、および `open_trades` への昇格状態を管理する。

### ドキュメント ID
- 自動採番 ID

### フィールド
- `event_id` (string, required)
- `broker` (string, required)
- `ticker` (string, required)
- `side` (string, required) — `BUY` | `SELL`
- `size` (number, required)
- `strategy` (string, optional)
- `interval` (string, optional)
- `price` (number, optional) — webhook 受信時点の参考価格
- `provider_order_id` (string, optional) — ブローカー側の注文 ID
- `execution_price` (number, optional) — 約定価格（cron で事後取得・更新）
- `open_trades_written` (boolean, required, default: `false`) — `open_trades` への書き込み済みフラグ
- `request_payload` (map, required)
- `response_payload` (map, optional)
- `result` (string, required)
  - `success` | `failure`
- `error_code` (string, optional)
- `created_at` (timestamp, required)
- `expire_at` (timestamp, required, TTL 用)

## 4. `cron_metadata`

Cloud Run 上で動作するスロットスケジューラーが、各周期タスクの実行済みスロットIDを管理するために使用する（詳細は [slot-scheduler.md](./slot-scheduler.md) を参照）。

### ドキュメント ID
- `task_status`（固定）

### フィールド
- `last_slot_10m` (number, required) — 10分周期タスクが最後に実行されたスロットID
- `last_slot_1h` (number, required) — 1時間周期タスクが最後に実行されたスロットID
- 新しい周期タスクを追加する場合は、対応する `last_slot_<interval>` フィールドを追加する

### 制約
- Firestoreトランザクションを使用して読み書きを行い、重複実行を防止する
- TTLは不要（上書きで管理）

## 5. `open_trades`

ペアリング待ちの未決済トレードを保持する。cron が `order_dispatch_logs` の成功かつ `execution_price` 確定済みレコードを昇格させて生成し、エントリー/エグジットのペアが揃い次第 `trade_records` に変換して削除される。

### ドキュメント ID
- `event_id`（対応する `webhook_events` の `event_id`）

### フィールド
- `event_id` (string, required)
- `broker` (string, required)
- `ticker` (string, required)
- `side` (string, required) — `BUY` | `SELL`
- `size` (number, required)
- `strategy` (string, required)
- `interval` (string, required)
- `execution_price` (number, required)
- `created_at` (timestamp, required)
- `order_dispatch_log_id` (string, required) — 紐付く `order_dispatch_logs` のドキュメント ID

### 制約
- ドキュメント ID = `event_id` で idempotent upsert（`set` 呼び出し）を使用する
- TTL は設定しない（ペアリング完了時に明示削除）

## 6. `trade_records`

エントリー/エグジットがペアリングされたクローズ済みトレードの記録を保持する。

### ドキュメント ID
- 自動採番 ID

### フィールド
- `strategy` (string, required)
- `interval` (string, required)
- `ticker` (string, required)
- `broker` (string, required)
- `entry_side` (string, required) — `BUY` | `SELL`
- `entry_price` (number, required) — エントリー約定価格
- `exit_price` (number, required) — エグジット約定価格
- `size` (number, required)
- `pnl` (number, required) — 損益
- `entry_event_id` (string, required)
- `exit_event_id` (string, required)
- `opened_at` (timestamp, required) — エントリー約定時刻
- `closed_at` (timestamp, required) — エグジット約定時刻
- `expire_at` (timestamp, required, TTL 用)

### 制約
- 同じ `entry_event_id` + `exit_event_id` の組み合わせが重複しないようアプリケーションで担保する

## 保持期間（MVP）
- `webhook_events`: 90 日
- `order_dispatch_logs`: 180 日
- `open_trades`: 無期限（ペアリング完了時に明示削除）
- `trade_records`: 約 2 年（`closed_at + 730 日`）
- `oidc_connections`: 連携中は保持、削除要求時に削除

## TTL 設計（MVP）
- `webhook_events.expire_at` に `received_at + 90 日` を設定
- `order_dispatch_logs.expire_at` に `created_at + 180 日` を設定
- `trade_records.expire_at` に `closed_at + 730 日` を設定
- `open_trades` は TTL を使用しない（ペアリング完了後に `delete()` で明示削除）
- `oidc_connections` は通常 TTL 対象外（削除要求時に明示削除）
- Firestore TTL ポリシーは対象コレクションごとに有効化する

## インデックス（MVP）
- Firestore の単一フィールドインデックスはデフォルト利用
- 追加の複合インデックス（必要時のみ）
  - `order_dispatch_logs`: `result` 昇順 + `open_trades_written` 昇順
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
