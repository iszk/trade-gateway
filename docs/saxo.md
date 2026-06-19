# Saxo 連携メモ

## 前提

現状の実装は Saxo の 1 アカウント運用を前提にする。`saxo_auth_data/saxo_auth.accounts[0]` の `ClientKey` を audit 取得に使い、発注時の account 選択も既存実装どおり、対象 `AssetType` を扱える最初の account を使う。

複数アカウント運用に拡張する場合は、少なくとも以下を見直す。

- `broker_order_metadata.saxo_order_v1` に発注時の `account_key` / `client_key` を保存する
- `cs/v1/audit/orderactivities` の polling 状態を account/client ごとに分離する
- cron の Saxo 同期で account/client ごとの activity batch を取得し、対象注文の metadata と突合する
- 既存注文で account/client metadata がない場合の移行または同期対象外方針を決める

## ExternalReference

Saxo 発注時は entry order と related/OCO child order に `ExternalReference` を付与する。値は `tg:<event id の短縮値>` とし、Saxo の 50 文字上限に収める。

`ExternalReference` は Saxo 側の検索条件としては使わない。audit や運用確認時の識別補助として扱い、同期の主キーは `OrderId` とローカルの `broker_order_metadata` にする。

## Audit OrderActivities Polling

cron の orders_v2 同期では、Saxo の `cs/v1/audit/orderactivities` を注文ごとに呼ばず、時間範囲または poll cursor で一括取得した activity を `OrderId` で突合する。

polling 状態は `cron_metadata/saxo_orderactivities_poll_state` に保存する。

- `last_poll_at`: 最後に batch polling を試行した時刻
- `next_poll_url`: Saxo の `__nextPoll` URL。空文字の場合は未保持として扱う

前回 polling から 30 分以内で `next_poll_url` がある場合は cursor を使う。30 分を超えている場合は cursor を捨て、`last_poll_at` から 30 分巻き戻した `FromDateTime` と現在時刻の `ToDateTime` で再取得する。初回は 48 時間 lookback で取得する。

約定数量は `FillAmount` を優先して合算し、価格は約定数量による加重平均にする。`FillAmount` がない場合は `FilledAmount` / `Amount` を累積数量として扱う。古いレスポンスなどで数量がない場合のみ、注文 metadata の expected size を互換 fallback として使う。
