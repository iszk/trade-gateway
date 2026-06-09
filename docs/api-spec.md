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

### 5. 残高一覧取得
- Method/Path: `GET /api/balances`
- 認証: 必要（Bearerトークン）
- 役割: 実装済み証券会社から現在の残高・評価額情報を取得し、日次スナップショットとして保存する
- 対象 broker: `bitflyer`, `saxo`

#### 成功レスポンス
- `200 OK`

```json
{
  "balances": [
    {
      "broker": "bitflyer",
      "balances": [
        { "asset": "JPY", "amount": 100000 },
        { "asset": "CFD_JPY", "amount": 50000 }
      ],
      "updatedAt": 1672531200000
    },
    {
      "broker": "saxo",
      "balances": [
        { "asset": "USD", "amount": 1000 },
        { "asset": "USD_AVAILABLE_FOR_TRADING", "amount": 750 },
        { "asset": "USD_TOTAL_VALUE", "amount": 1250 }
      ],
      "updatedAt": 1672531200000
    }
  ],
  "updated_at": 1672531200000
}
```

#### 補足
- Saxo は `/port/v1/balances/me` の `CashBalance`, `CashAvailableForTrading`, `TotalValue`, `NetEquity` を非ゼロ項目のみ返す

#### エラーレスポンス
- `401 Unauthorized`: 認証トークン不足・不正
- `500 Internal Server Error`: 証券会社との通信エラー等

### 6. トレード統計取得
- Method/Path: `GET /api/trade-records/stats`
- 認証: 必要（Bearerトークン）
- 役割: `orders_v2` の EXECUTED 注文から再構成したクローズ済みトレードの統計を、strategy 単位で返す

#### Query Parameters
- `from` (optional, ISO 8601): 期間開始（デフォルト: 直近 30 日）
- `to` (optional, ISO 8601): 期間終了（デフォルト: 現在）
- `strategy` (optional): 絞り込み
- `ticker` (optional): 絞り込み
- `broker` (optional): 絞り込み

#### 成功レスポンス
- `200 OK`

```json
{
  "groups": [
    {
      "strategy": "MA Crossover",
      "total": 10,
      "win_count": 7,
      "loss_count": 3,
      "win_rate": 0.7,
      "total_pnl": 50000,
      "avg_pnl": 5000,
      "avg_win": 10000,
      "avg_loss": 3333.33,
      "profit_factor": 2.33,
      "max_drawdown": 8000,
      "sharpe_ratio": 1.5
    }
  ],
  "from": "2026-03-28T00:00:00.000Z",
  "to": "2026-04-27T00:00:00.000Z"
}
```

#### エラーレスポンス
- `400 Bad Request`: 日付パラメーターが不正
- `401 Unauthorized`: 認証トークン不足・不正
- `500 Internal Server Error`

### 7. トレード記録一覧取得
- Method/Path: `GET /api/trade-records`
- 認証: 必要（Bearerトークン）
- 役割: `orders_v2` の EXECUTED 注文から FIFO で再構成したクローズ済みトレード記録を一覧取得する（ページネーション付き）

#### Query Parameters
- `from` (optional, ISO 8601): 期間開始（デフォルト: 直近 30 日）
- `to` (optional, ISO 8601): 期間終了（デフォルト: 現在）
- `strategy` (optional): 絞り込み
- `ticker` (optional): 絞り込み
- `broker` (optional): 絞り込み
- `limit` (optional, number, 1–200): 1 ページあたり件数（デフォルト: 50）
- `page` (optional, number): ページ番号（デフォルト: 1）

#### 成功レスポンス
- `200 OK`

```json
{
  "records": [
    {
      "docId": "abc123",
      "strategy": "MA Crossover",
      "ticker": "BTC_JPY",
      "broker": "bitflyer",
      "entry_side": "BUY",
      "entry_price": 10000000,
      "exit_price": 11000000,
      "size": 0.01,
      "pnl": 10000,
      "entry_event_id": "evt-entry",
      "exit_event_id": "evt-exit",
      "opened_at": "2026-01-01T00:00:00.000Z",
      "closed_at": "2026-01-02T00:00:00.000Z"
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 50,
  "total_pages": 1,
  "from": "2026-03-28T00:00:00.000Z",
  "to": "2026-04-27T00:00:00.000Z"
}
```

#### エラーレスポンス
- `400 Bad Request`: 日付パラメーターが不正
- `401 Unauthorized`: 認証トークン不足・不正
- `500 Internal Server Error`

### 8. ヘルスチェック
- Method/Path: `GET /api/health`
- 認証: 不要

#### 成功レスポンス
- `200 OK`

```json
{
  "status": "ok"
}
```

### 9. Symbol 一覧・更新
- Method/Path: `GET /api/symbols`
- 認証: 必要（Bearerトークン）
- 役割: broker + ticker のメタデータと売買停止状態を一覧取得する

#### 成功レスポンス
- `200 OK`

```json
{
  "symbols": [
    {
      "id": "bitflyer:BTC_JPY",
      "broker": "bitflyer",
      "ticker": "BTC_JPY",
      "display_name": "BTC/JPY",
      "currency": "JPY",
      "trade_control": {
        "status": "active",
        "updated_at": "2026-06-03T00:00:00.000Z",
        "updated_by": "ui"
      },
      "created_at": "2026-06-03T00:00:00.000Z",
      "updated_at": "2026-06-03T00:00:00.000Z"
    }
  ],
  "updated_at": 1780444800000
}
```

### 10. Symbol 更新
- Method/Path: `PUT /api/symbols/:symbol_id`
- 認証: 必要（Bearerトークン）
- 補足: `symbol_id` は `broker:ticker` を URL encode した値

#### リクエスト

```json
{
  "display_name": "BTC/JPY",
  "currency": "JPY",
  "note": "main symbol"
}
```

### 11. Symbol 売買停止/再開
- Method/Path: `PATCH /api/symbols/:symbol_id/trade-control`
- 認証: 必要（Bearerトークン）

#### リクエスト

```json
{
  "status": "paused",
  "reason": "manual stop"
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
- `NOT_FOUND`

## ログ方針
- Webhook 関連ログは 1 行 JSON で出力する
- 各ログは `event` と `request_id` を含む
- `webhook_secret` は `payload` と `rawBody` の両方で `[REDACTED]` にマスクする
