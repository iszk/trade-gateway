# Webhook 仕様（MVP）

## 目的
TradingView から受信するアラートを正規化し、bitFlyer 向け発注リクエストに変換できる最小契約を定義する。

## スコープ
- 対象: bitFlyer 向け現物売買の成行注文（MVP）
- 非対象: 指値/逆指値、複雑注文、サクソバンク証券向け変換

## エンドポイント
- Method: `POST`
- Path: `/api/webhooks/tradingview`
- Content-Type: `application/json`
- Response Header: `X-Request-Id`

## リクエストスキーマ

### 必須項目
- `event_id` (string): 送信元で一意となるイベントID
- `occurred_at` (string, RFC3339): シグナル発生時刻
- `symbol` (string): 取引銘柄。MVP は `BTC_JPY` のみ許可
- `side` (string): `BUY` または `SELL`
- `order_type` (string): MVP は `MARKET` のみ許可
- `size` (number): 発注数量。`size > 0`
- `webhook_secret` (string): 共有シークレット

### 任意項目
- `broker` (string): 発注先ブローカー。未指定時は `bitflyer` を適用
- `strategy` (string): シグナル生成元の戦略名
- `note` (string): 運用メモ

### 認証方式（直接連携）
- TradingView 側で任意カスタムヘッダは付与できない前提とする
- 認証は body の `webhook_secret` 一致で行う
- 送信元 IP を allowlist で制限する

## バリデーション
1. JSON であること
2. 必須項目が欠落していないこと
3. `occurred_at` が RFC3339 形式であること
4. `side` と `order_type` が許可値であること
5. `size` が正の数であること
6. `symbol` が許可銘柄であること
7. `broker` 指定時は許可値であること（MVP は `bitflyer` のみ）
8. `webhook_secret` がサーバ設定値と一致すること
9. 送信元 IP が allowlist に含まれること

## TradingView 連携制約
- Webhook の送信は HTTP POST
- Alert message が valid JSON の場合のみ `application/json`
- 送信先 URL のポートは 80/443 のみ
- IPv6 は非対応
- 2FA 有効化が必要
- 許可対象 IP（2026-03-18 時点）
  - `52.89.214.238`
  - `34.212.75.30`
  - `54.218.53.128`
  - `52.32.178.7`

## TradingView Alert 設定

### Webhook URL
TradingView の Alert notification 設定で以下の URL を指定：

```
https://api.trade-gateway.example.com/api/webhooks/tradingview
```

> **プレースホルダ**: `api.trade-gateway.example.com` は実際のホスト名に置き換え

### Alert Message 設定
Alert の "Message" フィールドに以下の JSON を指定（改行は削除）：

```json
{
  "event_id": "{{alert.id}}",
  "occurred_at": "{{timenow}}",
  "symbol": "{{ticker}}",
  "side": "{{strategy.order.action}}",
  "order_type": "MARKET",
  "size": {{strategy.order.contracts}},
  "webhook_secret": "__YOUR_WEBHOOK_SECRET__",
  "strategy": "my awesome strategy",
  "interval": "{{interval}}",
  "price": {{strategy.order.price}},
  "note": "{{strategy.order.comment}}"
}
```

> **プレースホルダの説明**:
> - `{{alert.id}}`: TradingView Alert ID（自動置換）
> - `{{timenow}}`: 現在時刻 RFC3339 形式（自動置換）
> - `BTC_JPY`: 取引銘柄に応じて変更
> - `BUY` / `SELL`: シグナルに応じて変更
> - `0.01`: 発注単位に応じて変更
> - `__YOUR_WEBHOOK_SECRET__`: サーバ管理者から支給されたシークレットに置き換え
> - `strategy`, `note`: 任意項目、不要なら削除可

### TradingView Pine Script での例
Strategy の Alert callback 例：

```pine
strategy.entry("Long", strategy.long, when=longSignal)
alert(json.stringify(
  object.new(
    event_id=str.tostring(time),
    occurred_at=str.format("{0, date, yyyy-MM-dd'T'HH:mm:ss'Z'}", time),
    symbol="BTC_JPY",
    side="BUY",
    order_type="MARKET",
    size=0.01,
    webhook_secret="__YOUR_WEBHOOK_SECRET__",
    strategy="MA Crossover",
    note="Condition met"
  )
))
```

## 重複判定
- 一意キーは `event_id`
- `event_id` が既処理なら重複として拒否する

## レスポンス

### 成功
- Status: `202 Accepted`
- Body:

```json
{
  "status": "accepted",
  "event_id": "evt-20260318-0001"
}
```

### エラー
- `400 Bad Request`: 形式不正・必須欠落・許可値違反
- `401 Unauthorized`: `webhook_secret` 不正
- `403 Forbidden`: 送信元 IP 不正
- `409 Conflict`: 重複イベント
- `500 Internal Server Error`: 想定外エラー

### エラーコード / reason 対応

| HTTP Status | `error.code` | `reason` | 条件 |
| --- | --- | --- | --- |
| `400` | `INVALID_REQUEST` | `invalid_content_type` | `Content-Type` が `application/json` ではない |
| `400` | `INVALID_REQUEST` | `invalid_json` | JSON パースに失敗した |
| `400` | `INVALID_REQUEST` | `validation_error` | スキーマ検証に失敗した |
| `401` | `INVALID_WEBHOOK_SECRET` | `invalid_webhook_secret` | `webhook_secret` が一致しない |
| `403` | `FORBIDDEN_SOURCE_IP` | `forbidden_source_ip` | 送信元 IP が allowlist に含まれない |
| `409` | `DUPLICATED_EVENT` | `duplicated_event` | `event_id` が既処理 |

## ログ仕様
- 受信ログ: `event = "webhook:received"`
- 受理ログ: `event = "webhook:accepted"`
- 拒否ログ: `event = "webhook:rejected"`
- 各ログは `request_id` を含む
- 拒否ログは `reason`, `error`, `event_id`, `rawBody`, `payload` を可能な範囲で含む
- `webhook_secret` はログ出力時に `[REDACTED]` へマスクする

## 受け入れ観点
- 正常系: 正常 payload + 正しい `webhook_secret` + 許可 IP + 未処理 event_id で `202`
- 異常系: `webhook_secret` 不正で `401`
- 異常系: 許可外 IP で `403`
- 異常系: 必須欠落で `400`
- 異常系: 同一 event_id 再送で `409`

## サンプルペイロード

### リクエスト例 1: BUY シグナル

```json
{
  "event_id": "evt-20260319-00123",
  "occurred_at": "2026-03-19T14:30:45Z",
  "symbol": "BTC_JPY",
  "side": "BUY",
  "order_type": "MARKET",
  "size": 0.05,
  "webhook_secret": "sk_webhook_a1b2c3d4e5f6g7h8i9j0k1l2",
  "strategy": "MA Crossover Strategy",
  "note": "50EMA > 200EMA on 4H chart"
}
```

### リクエスト例 2: SELL シグナル（最小限の項目）

```json
{
  "event_id": "evt-20260319-00124",
  "occurred_at": "2026-03-19T15:45:30Z",
  "symbol": "BTC_JPY",
  "side": "SELL",
  "order_type": "MARKET",
  "size": 0.05,
  "webhook_secret": "sk_webhook_a1b2c3d4e5f6g7h8i9j0k1l2"
}
```

### レスポンス例（成功）

```json
{
  "status": "accepted",
  "event_id": "evt-20260319-00123"
}
```

HTTP Status: `202 Accepted`

### レスポンス例（エラー）

#### webhook_secret 不正
Status: `401 Unauthorized`
```json
{
  "status": "unauthorized",
  "error": "Invalid webhook_secret"
}
```

#### 必須項目欠落
Status: `400 Bad Request`
```json
{
  "status": "bad_request",
  "error": "Missing required field: size"
}
```

#### 重複イベント
Status: `409 Conflict`
```json
{
  "status": "conflict",
  "error": "Event already processed",
  "event_id": "evt-20260319-00123"
}
```
