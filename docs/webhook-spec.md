# Webhook 仕様（MVP）

## 目的
TradingView から受信するアラートを正規化し、bitFlyer 向け発注リクエストに変換できる最小契約を定義する。

## スコープ
- 対象: bitFlyer 向け現物売買の成行注文、サクソバンク証券向け成行注文（子注文含む）
- 非対象: 指値注文（成行のみ）

## 実装方針（MVP）
- `src/index.ts` は broker 非依存とし、Webhook受信処理に集中する
- broker固有処理は dispatcher 層を介して実行する
- 抽象化は軽量に留める（dispatcher + broker handler）

## エンドポイント
- Method: `POST`
- Path: `/api/webhooks/tradingview`
- Content-Type: `application/json`
- Response Header: `X-Request-Id`

## リクエストスキーマ

### 必須項目
- `event_id` (string): 送信元で一意となるイベントID
- `occurred_at` (integer, unix milliseconds): シグナル発生時刻
- `ticker` (string): 取引銘柄。1 文字以上の文字列を必須とする
- `side` (string): `BUY` または `SELL`
- `size` (number): 発注数量。`size > 0`
- `webhook_secret` (string): 共有シークレット

### 任意項目
- `broker` (string): 発注先ブローカー。未指定時は `bitflyer` を適用
- `order_type` (string): 指定時は `MARKET` のみ許可
- `price` (number): 価格情報。`stop_loss` / `take_profit` を使用する場合は必須
- `interval` (string): TradingView の時間足
- `strategy` (string): シグナル生成元の戦略名
- `note` (string): 運用メモ
- `stop_loss` (string): ストップロス幅。`"2.5%"` のようなパーセント文字列で指定。`price` を基準に計算される
- `take_profit` (string): テイクプロフィット幅。`"2.5%"` のようなパーセント文字列で指定。`price` を基準に計算される

### 認証方式（直接連携）
- TradingView 側で任意カスタムヘッダは付与できない前提とする
- 認証は body の `webhook_secret` 一致で行う
- 送信元 IP を allowlist で制限する

## バリデーション
1. JSON であること
2. 必須項目が欠落していないこと
3. `occurred_at` が Unix time（milliseconds）の整数であること
4. `side` が許可値であること
5. `size` が正の数であること
6. `ticker` が 1 文字以上であること
7. `order_type` 指定時は許可値であること（MVP は `MARKET` のみ）
8. `broker` 指定時は許可値であること（`bitflyer` `dummy` `auto`）
9. `webhook_secret` がサーバ設定値と一致すること
10. 送信元 IP が allowlist に含まれること

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
  "occurred_at": {{timenow}},
  "ticker": "{{ticker}}",
  "side": "{{strategy.order.action}}",
  "size": {{strategy.order.contracts}},
  "webhook_secret": "__YOUR_WEBHOOK_SECRET__",
  "strategy": "my awesome strategy",
  "interval": "{{interval}}",
  "price": {{strategy.order.price}},
  "note": "{{strategy.order.comment}}",
  "stop_loss": "2.0%",
  "take_profit": "3.0%"
}
```

> **プレースホルダの説明**:
> - `{{alert.id}}`: TradingView Alert ID（自動置換）
> - `{{timenow}}`: 現在時刻の Unix time（milliseconds, 自動置換）
> - `BTC_JPY`: 取引銘柄に応じて変更
> - `BUY` / `SELL`: シグナルに応じて変更
> - `0.01`: 発注単位に応じて変更
> - `__YOUR_WEBHOOK_SECRET__`: サーバ管理者から支給されたシークレットに置き換え
> - `strategy`, `note`: 任意項目、不要なら削除可
> - `stop_loss`, `take_profit`: 任意項目。`"2.0%"` のように記述。`price` も同時に指定が必要

### TradingView Pine Script での例
Strategy の Alert callback 例：

```pine
strategy.entry("Long", strategy.long, when=longSignal)
alert(json.stringify(
  object.new(
    event_id=str.tostring(time),
    occurred_at=str.tostring(timenow),
    ticker="BTC_JPY",
    side="BUY",
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
- 備考: broker dispatch が失敗した場合も Webhook は受理済みとして `202` を返す（失敗詳細はログで追跡）
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
- 拒否ログ: `event = "webhook:rejected"`（入力拒否に加え、broker dispatch failure もここで記録）
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
  "occurred_at": 1773930645000,
  "ticker": "BTC_JPY",
  "side": "BUY",
  "order_type": "MARKET",
  "size": 0.05,
  "webhook_secret": "sk_webhook_a1b2c3d4e5f6g7h8i9j0k1l2",
  "strategy": "MA Crossover Strategy",
  "note": "50EMA > 200EMA on 4H chart"
}
```

### リクエスト例 3: ストップロス / テイクプロフィット付き（サクソバンク向け）

```json
{
  "event_id": "evt-20260319-00125",
  "occurred_at": 1773935200000,
  "ticker": "FX:NAS100",
  "side": "BUY",
  "size": 1,
  "price": 18500.0,
  "stop_loss": "2.0%",
  "take_profit": "3.0%",
  "webhook_secret": "sk_webhook_a1b2c3d4e5f6g7h8i9j0k1l2"
}
```

> BUY の場合、`stop_loss` は `price * (1 - 2.0%)` = `18130.0`、`take_profit` は `price * (1 + 3.0%)` = `19055.0` で子注文が発注される。

### リクエスト例 2: SELL シグナル（最小限の項目）

```json
{
  "event_id": "evt-20260319-00124",
  "occurred_at": 1773935130000,
  "ticker": "BTC_JPY",
  "side": "SELL",
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
