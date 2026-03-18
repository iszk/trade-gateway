# API 仕様（MVP）

## 目的
Webhook 受信、認証開始、ヘルスチェックの最小 API 契約を定義する。

## 共通方針
- Base Path: `/api`
- 形式: `application/json`
- タイムゾーン: UTC
- 認証が必要な API は Bearer トークンを要求する

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

### 4. ヘルスチェック
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
