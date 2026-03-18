# trade-gateway

# なにをするものか

TradingView からの webhook を受けて、実際にブローカーに対して発注を行う web api を提供するアプリケーション。

また、それに必要なUIとしてOpenIDのtokenを得るためのログイン用のエンドポイント等も作成する。

データベースにはアクセストークン、リフレッシュトークンのようなもの、 webhook の重複受信対策のデータ、といったものを保持するのを想定。

## MVP スコープ
- 対象ブローカー: bitFlyer のみ
- 非対象: サクソバンク証券の実装（後続フェーズで対応）

## 仕様書
- webhook 仕様: `docs/webhook-spec.md`
- API 仕様: `docs/api-spec.md`
- DB 仕様: `docs/database-spec.md`

## webhook のスキーマ
- 初版を `docs/webhook-spec.md` で定義

## 対応ブローカー
- サクソバンク証券
- bitFlyer

# 利用する技術

## SaaS / PaaS
- Google CloudRun (予定)

## バックエンド
- Hono

## フロントエンド
- 未定

## データベース
- 未定

## 受け入れ条件（初版）
- 正常系: 妥当な webhook を受信し、重複でなければ発注キューに登録されること
- 異常系: `webhook_secret` 不正は拒否されること
- 異常系: 必須項目欠落は拒否されること
- 異常系: 同一イベントの再送は重複として拒否されること
