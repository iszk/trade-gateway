# API 仕様（MVP）

## 目的
Webhook 受信、認証開始、ヘルスチェックを含む現行 API の概要を定義する。

OpenAPI は全 endpoint を一括で定義していない。機械可読な契約は、対象限定の [注文更新 API OpenAPI](./openapi/order-updates.openapi.yaml) のみを提供する。

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
- 役割: 各証券会社から現在のポジション一覧を取得する。bitFlyer は `tradable_symbols` に登録された bitFlyer 銘柄ごとに取得し、登録がない場合や取得に失敗した場合は bitFlyer のポジション取得をスキップする。

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

### 5. トレード統計取得
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

### 6. トレード記録一覧取得
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

### 7. ヘルスチェック
- Method/Path: `GET /api/health`
- 認証: 不要

#### 成功レスポンス
- `200 OK`

```json
{
  "status": "ok"
}
```

### 8. Orders V2 統計取得
- Method/Path: `GET /api/v2/orders/stats`
- 認証: 必要（Bearerトークン）
- 役割: `orders_v2` の注文を strategy 単位で集計する。期間指定は `executed_at` を基準にする。

#### Query Parameters
- `from` (optional, `YYYY-MM-DD`): JST 日付の期間開始（デフォルト: 直近 30 日）
- `to` (optional, `YYYY-MM-DD`): JST 日付の期間終了日（デフォルト: 今日）

#### 補足
- `status=EXECUTED` の注文は `executed_at` が必須。欠落している既存データは集計対象外とし、`created_at` へはフォールバックしない。
- `open_orders` は期間指定とは独立して、現在の `PENDING` 注文を strategy 単位で集計する。

### 9. Orders V2 一覧取得
- Method/Path: `GET /api/v2/orders`
- 認証: 必要（Bearerトークン）
- 役割: `orders_v2` の注文を `executed_at` 降順で一覧取得する。

#### Query Parameters
- `from` (optional, `YYYY-MM-DD`): JST 日付の期間開始（デフォルト: 直近 30 日）
- `to` (optional, `YYYY-MM-DD`): JST 日付の期間終了日（デフォルト: 今日）
- `strategy` (optional): strategy の完全一致で絞り込み
- `limit` (optional, number, 1–200): 1 ページあたり件数（デフォルト: 50）
- `page` (optional, number): ページ番号（デフォルト: 1）

#### 補足
- 期間指定は `executed_at` を基準にする。`executed_at` が欠落している注文は一覧対象外とし、`created_at` へはフォールバックしない。

<a id="order-updates-api"></a>

### 注文更新 API（対象限定）
- Method/Path: `GET /api/order-updates`
- 認証: 必要（`API_SECRET` の Bearer トークン）
- 役割: `orders_v2.updated_at` の期間内に更新された、全 lifecycle status の現在注文 snapshot を bot の差分同期に利用する
- 機械可読な HTTP 契約: [docs/openapi/order-updates.openapi.yaml](./openapi/order-updates.openapi.yaml)

このセクションとリンク先の OpenAPI は注文更新 API だけを対象とし、trade-gateway 全 API の OpenAPI ではない。query、response schema、status code、enum、required / nullable は OpenAPI を正とし、以下では bot が誤同期しないための運用上の意味だけを説明する。

#### Query Parameters
- `updated_from` (optional, ISO 8601 date-time with timezone): 範囲の開始。実装は分精度（例: `2026-07-15T09:00+09:00`）、または秒・小数秒を含む形式を受理する。`updated_at >= updated_from` の inclusive 条件で、未指定時は `updated_to` または取得時刻から 30 日前
- `updated_to` (optional, ISO 8601 date-time with timezone): 範囲の終了。実装は分精度、または秒・小数秒を含む形式を受理する。`updated_at < updated_to` の exclusive 条件で、未指定時は取得時刻
- `limit` (optional, integer, 1–200): 1 ページあたり件数（デフォルト: 50）
- `page` (optional, integer, 1 以上): 1 始まりのページ番号（デフォルト: 1）
- `updated_from` と `updated_to` は同じ request で解釈した時刻範囲が空にならないよう、開始が終了より前でなければならない

#### Bot の差分同期
1. bot は webhook 送信前に、自身が生成した `event_id` と送信時刻をローカルに保存する。gateway の注文 `id` は通常この `event_id` だが、照合時は `id` と `event_id` を明示的に比較し、暗黙の時刻・銘柄一致で代用しない。
2. 前回成功同期の watermark を `updated_to` にせず、次回は安全な overlap（例: 数分）を含む `updated_from` から取得する。range は半開区間なので、境界時刻の更新を取りこぼさないよう overlap 分だけ重複取得する。
3. `total_pages` と `page` を使って全ページを取得する。各 response は現在の mutable snapshot であり、request 間に新しい更新や既存注文の更新が入るため、ページをまたいだ一貫した snapshot や repeatable read は保証されない。
4. 取得した各注文を `id` を主キーとして local store に idempotent upsert し、同じ `id` の重複を deduplicate する。overlap と mutable pagination により同じ注文が複数回返ることは正常である。
5. 全ページを処理し、照合・upsert が成功してから次回の watermark を進める。失敗時は watermark を進めず、同じ overlap を再取得する。`page` の値だけを永続化して再開位置にする設計は、mutable pagination のため避ける。

#### 注文・約定状態の扱い
- `status` は注文の現在 lifecycle であり、`PENDING`、`EXECUTED`、`FAILED`、`CANCELED` を返す。`fill_status` は約定数量から導出した `UNFILLED`、`PARTIALLY_FILLED`、`FILLED` で、`status` とは別の軸である。
- 未約定は `executed_size=0`、`executed_price=null`、`executed_at=null` になり得る。一部約定は `status=PENDING` のまま `executed_size`、平均 `executed_price`、`executed_at` が更新される。要求数量に到達した注文だけが `fill_status=FILLED` となる。
- `updated_at` は現在 snapshot の更新時刻であり、状態遷移履歴や個別 fill の履歴ではない。履歴が必要な bot は自分の upsert 前 snapshot を保存する。

#### Commission semantics
- `execution_costs.commission` は broker execution が返した明示 commission の累積値だけを表す。`0` は broker が返した known zero で、`null` は legacy order、broker 未対応、取得不能などの unknown である。
- `null` を `0` に補完してはならない。entry と exit の各注文値を個別に保持し、両方が必要な集計では unknown を明示的に伝播させる。
- spread、funding、slippage、売買価格差、その他の推定コストは commission に含まれない。これらを commission として逆算してはならない。

#### エラーレスポンス
- `400 Bad Request`: query の形式・範囲・pagination が不正
- `401 Unauthorized`: Bearer トークン不足・不正
- `500 Internal Server Error`: reader / Firestore 取得失敗
- body は既存の `{ "error": { "code": "...", "message": "..." } }` envelope。bot は `message` の文言ではなく `code` と HTTP status を判定に使う。

### 10. Symbol 一覧・更新
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

### 11. Symbol 更新
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

### 12. Symbol 売買停止/再開
- Method/Path: `PATCH /api/symbols/:symbol_id/trade-control`
- 認証: 必要（Bearerトークン）

#### リクエスト

```json
{
  "status": "paused",
  "reason": "manual stop"
}
```

### 13. Saxo portfolio snapshot 取得
- Method/Path: `GET /api/saxo/portfolio-snapshot`
- 認証: 必要（Bearerトークン）
- 役割: Saxo の現在の口座・現金残高・建玉を `portfolio-snapshot.v1` 形式で返す。

#### 補足
- 出力契約は equinaut の `portfolio-snapshot.v1` に合わせる。
- FX rate は初期実装では通貨コードごとの固定値を使う: `JPY=1`, `USD=160`, `HKD=20`。
- cash balance は `/port/v1/balances/me` の `CashBalance` を Saxo 側で JPY 換算済みの client aggregate とみなし、`valueJpy` へそのまま入れる。口座別 cash breakdown は初期実装では取得しない。
- 固定 FX rate が未対応で `valueJpy` を算出できない position はスキップし、`sourceMetadata.skippedPositions` に理由を保持する。
- CFD / FX / Future などのレバレッジ商品は、口座純資産として理解しやすいように `valueJpy` へ未実現損益を入れる。未実現損益が取得できない場合は `valueJpy=0` とし、`sourceMetadata.valuationStatus` に理由を保持する。
- レバレッジ商品の notional exposure は `sourceMetadata.notionalValueJpy` に保持する。notional の FX rate が未対応の場合でも position は返し、`sourceMetadata.notionalValueStatus` に理由を保持する。
- レバレッジ商品以外で market value / price が取得できない場合は `valueJpy=0` とし、`sourceMetadata.valuationStatus` に `missing_market_value` を保持する。
- Saxo instrument details の取得に失敗した場合は snapshot 全体を失敗させず、`AssetType:Uic` を `symbol` の fallback として使う。

#### 成功レスポンス
- `200 OK`

```json
{
  "schemaVersion": "portfolio-snapshot.v1",
  "source": {
    "id": "saxo-bank",
    "provider": "Saxo Bank",
    "exporter": "trade-gateway"
  },
  "generatedAt": "2026-07-06T00:00:00.000Z",
  "dataAsOf": "2026-07-06T00:00:00.000Z",
  "baseCurrency": "JPY",
  "accounts": [
    {
      "sourceAccountId": "account-1",
      "name": "Main Account",
      "baseCurrency": "JPY"
    }
  ],
  "cashBalances": [
    {
      "sourceAccountId": "client:client-1",
      "currency": "JPY",
      "amount": "100000",
      "valueJpy": "100000",
      "fxRateToJpy": "1",
      "sourceBalanceId": "client:client-1:JPY:CashBalance",
      "sourceMetadata": {
        "sourceEndpoint": "/port/v1/balances/me",
        "sourceField": "CashBalance",
        "sourceScope": "client",
        "currencyAssumption": "client_aggregate_jpy",
        "reportedCurrency": "JPY"
      }
    }
  ],
  "positions": [
    {
      "sourceAccountId": "account-1",
      "sourcePositionId": "CfdOnIndex:111111__account-1",
      "sourceInstrumentId": "CfdOnIndex:111111",
      "assetClass": "cfd",
      "symbol": "US500.I",
      "quantity": "2",
      "side": "long",
      "price": "5500",
      "priceCurrency": "USD",
      "valueJpy": "32000",
      "unrealizedPnlJpy": "32000",
      "sourceMetadata": {
        "valuationBasis": "equity_contribution",
        "notionalValueJpy": "1760000"
      }
    }
  ]
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
