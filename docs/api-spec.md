# API 仕様（MVP）

## 目的
Webhook 受信、認証開始、ヘルスチェックの最小 API 契約を定義する。

## 共通方針
- Base Path: `/api`
- 形式: `application/json`
- 時刻形式: Unix time（milliseconds, UTC）
- 認証が必要な API は Bearer トークンを要求する
- すべてのレスポンスは `X-Request-Id` ヘッダを返す。リクエストの `X-Request-Id` があればそれを引き継ぎ、なければサーバで採番する

## エンドポイント一覧

### 1. TradingView webhook 受信
- Method/Path: `POST /api/webhooks/tradingview`
- 認証: body の `webhook_secret` + 送信元 IP allowlist
- リクエスト補足: `broker` は任意。未指定時は `bitflyer` 扱い
- 詳細: `docs/webhook-spec.md`

#### 成功レスポンス
- `202 Accepted`

#### エラーレスポンス
- `400` `401` `403` `409` `500`

### 2. OpenID ログイン開始
- Method/Path: `GET /api/auth/login`
- 認証: 不要
- 役割: OpenID Provider への認可画面 URL を返す

#### 成功レスポンス
- `200 OK`

```json
{
  "authorization_url": "https://example-idp/authorize?...",
  "state": "opaque-state"
}
```

### 3. OpenID コールバック
- Method/Path: `GET /api/auth/callback`
- 認証: 不要
- 役割: 認可コードを交換し、アクセストークン/リフレッシュトークンを保存する

#### 成功レスポンス
- `200 OK`

```json
{
  "status": "linked"
}
```

#### エラーレスポンス
- `400 Bad Request`: state/code 不正
- `502 Bad Gateway`: IdP 通信失敗

### 4. ポジション一覧取得
- Method/Path: `GET /api/positions`
- 認証: 必要（Bearerトークン）
- 役割: 各証券会社から現在のポジション一覧を取得する

#### Query Parameters
- `broker` (optional): `bitflyer`, `saxo`, `dummy`. 指定がない場合は全ての証券会社から取得する

#### 成功レスポンス
- `200 OK`

```json
{
  "positions": [
    {
      "broker": "bitflyer",
      "ticker": "BTC_JPY",
      "side": "BUY",
      "size": 0.01,
      "price": 10000000,
      "pnl": 500
    }
  ],
  "updated_at": 1672531200000
}
```

#### エラーレスポンス
- `401 Unauthorized`: 認証トークン不足・不正
- `500 Internal Server Error`: 証券会社との通信エラー等

### 5. ヘルスチェック
- Method/Path: `GET /api/health`
- 認証: 不要

#### 成功レスポンス
- `200 OK`

```json
{
  "status": "ok"
}
```

## エラー形式

すべてのエラーは以下を返す。

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "size must be greater than 0"
  }
}
```

## エラーコード（MVP）
- `INVALID_REQUEST`
- `INVALID_WEBHOOK_SECRET`
- `FORBIDDEN_SOURCE_IP`
- `DUPLICATED_EVENT`
- `UPSTREAM_AUTH_ERROR`
- `INTERNAL_ERROR`

## ログ方針
- Webhook 関連ログは 1 行 JSON で出力する
- 各ログは `event` と `request_id` を含む
- `webhook_secret` は `payload` と `rawBody` の両方で `[REDACTED]` にマスクする
