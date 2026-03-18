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

## 受け入れ観点
- 正常系: 正常 payload + 正しい `webhook_secret` + 許可 IP + 未処理 event_id で `202`
- 異常系: `webhook_secret` 不正で `401`
- 異常系: 許可外 IP で `403`
- 異常系: 必須欠落で `400`
- 異常系: 同一 event_id 再送で `409`
