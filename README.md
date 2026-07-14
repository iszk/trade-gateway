# trade-gateway

## なにをするものか

TradingView からの webhook を受けて、実際にブローカーに対して発注を行う Web API を提供するアプリケーション。

また、それに必要な UI として OpenID の token を得るためのログイン用エンドポイントも提供する。

データベースには暗号化したアクセストークン・リフレッシュトークンと、webhook の重複受信対策データを保持する。

Node.js workspace 構成を採用しており、`api` と `ui` をルート `package.json` / `package-lock.json` でまとめて管理する。

## MVP スコープ

- 対象ブローカー: bitFlyer のみ（現物・成行 BUY/SELL）
- 非対象: サクソバンク証券の実装（後続フェーズで対応）
- Webhookレスポンス: broker送信成否に関わらず `202 Accepted`

## 仕様書

- このプロジェクの構成仕様: `docs/structure.md`
- webhook 仕様: `docs/webhook-spec.md`
- API 仕様: `docs/api-spec.md`
- DB 仕様: `docs/database-spec.md`

## 対応ブローカー

- dummy
- bitFlyer
- サクソバンク証券（後続）

## 実装方針（MVP）

- `src/index.ts` は broker 非依存（Webhook検証・重複判定・レスポンス制御に集中）
- broker固有処理は dispatcher 経由で分離
- 抽象化は軽量構成（dispatcher + broker handler）に留める

## 利用する技術

### SaaS / PaaS

- Google Cloud Run
- Google Firestore（Native mode, MVP 採用）
- Google Secret Manager（Saxo token 暗号鍵の保管・Cloud Run への注入）
- Node.js `crypto` の AES-256-GCM（Saxo token のアプリケーション暗号化）

### バックエンド

- Hono

### フロントエンド

- Honox
- Vite

## セットアップ / 開発

- セットアップ: `mise run setup`
- テスト: `mise run test`
- 型チェック: `mise run typecheck`
- API 開発: `mise run dev`
- UI 開発: `mise run dev:ui`

### データベース

- Firestore（Native mode）

## Firestore 採用理由（MVP）

- スタート時の固定費を抑えやすい（従量課金中心）
- Cloud Run と相性がよく運用構成を単純にできる
- MVP 要件で必要なデータアクセスが単純で、過剰な複雑性を避けられる

## 運用前提（MVP）

- UTC で日時を保存する
- event_id を重複判定キーとし、同一 event_id は 409 で拒否する
- トークン平文保存は禁止し、暗号化済みデータのみ保存する
- 保持期間を過ぎたデータは TTL で自動削除する

Saxo token の暗号化方式、Secret Manager の準備、既存平文 document の読み取り時移行、rollback 制約は [Saxo 連携メモ](./docs/saxo.md#saxo-oauth-token-暗号化運用) を参照する。

## 受け入れ条件（初版）

- 正常系: 妥当な webhook を受信し、重複でなければ broker dispatch が実行されること
- 異常系: `webhook_secret` 不正は拒否されること
- 異常系: 必須項目欠落は拒否されること
- 異常系: 同一イベントの再送は重複として拒否されること
- 異常系: broker dispatch が失敗しても Webhook 応答は `202 Accepted` を返すこと

## TODO

- source_ip のチェックをオンオフ可能に
- ログのエラーをgcp からわかるように
- access time が離れてたら蹴るように
- BF の secret とかを gcp secret にいれる、手元でのテストをなんとかする
