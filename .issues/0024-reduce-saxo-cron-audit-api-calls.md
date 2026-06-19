---
title: Saxo の cron 約定同期を audit orderactivities の一括取得に寄せて API call 数を削減する
status: done
---

# 概要

Saxo の cron 約定同期では、現在 `orders_v2` の PENDING 注文や IFDOCO exit 注文ごとに `/cs/v1/audit/orderactivities?OrderId=...` を呼び出している。

Saxo の `ExternalReference` を trade-gateway 由来注文の識別補助として付与しつつ、API call 削減の主手段は `ExternalReference` 検索ではなく、`/cs/v1/audit/orderactivities` を時間範囲または poll cursor で一括取得してローカルの `OrderId` / metadata と突合する方式に変更する。

対象:

- `api/src/brokers/saxo.ts`
- `api/src/services/cron-tasks.ts`
- `api/src/types/broker-order-metadata.ts`
- `api/src/brokers/saxo.test.ts`
- `api/src/services/cron-tasks.test.ts`
- 必要に応じて Saxo 同期仕様を記載しているドキュメント

# 背景

調査した Saxo OpenAPI 仕様では、発注時の `ExternalReference` は指定可能で、open orders や audit orderactivities のレスポンスにも返る。

ただし、open orders / positions / netpositions / audit orderactivities の検索パラメータには `ExternalReference` がなく、`ExternalReference=trade-gateway` のような条件で Saxo 側を直接検索して一括取得することは公式仕様上できない。

一方で `/cs/v1/audit/orderactivities` は以下のような条件で一括取得できる。

- `ClientKey`
- `AccountKey`
- `FromDateTime`
- `ToDateTime`
- `Status`
- `EntryType`
- `$top`
- `$skiptoken`
- `OrderId`
- `CorrelationKey`

またレスポンスには `OrderId`, `ExternalReference`, `Amount`, `AveragePrice`, `ExecutionPrice`, `FillAmount`, `FilledAmount`, `PositionId`, `RelatedPositionId`, `ActivityTime` などが含まれるため、ローカルの Saxo 注文 metadata と突合して約定情報を更新できる可能性が高い。

# 方針

`ExternalReference` は固定文字列だけではなく、trade-gateway 由来かつローカル注文に対応できる短い値にする。

例:

- `tg:<orders_v2 id の短縮値>`
- `tg:<event id の短縮値>`

Saxo の上限は 50 文字で、ユニークである必要はないが、運用確認や audit 突合のために可能な範囲で一意性を持たせる。

API call 削減は、注文ごとの audit call を減らし、cron 1 回あたり以下のような一括取得に寄せる。

- 前回 polling 位置または安全な lookback window から `orderactivities` を取得する
- `Status=Fill` など必要な status に絞る
- ページングまたは `__nextPoll` / `$skiptoken` を処理する
- 取得した activities を `OrderId` で `broker_order_metadata` の entry / exits と突合する
- `ExternalReference` は `tg:` prefix の確認や補助的な検証に使う

# 実装/修正プラン

- [x] Saxo 発注時に entry order と related/OCO child orders へ `ExternalReference` を付与する
- [x] `SaxoOrderMetadata` に `external_reference` など、必要な識別情報を保存する
- [x] Saxo audit activities を一括取得するメソッドを追加する
- [x] `OrderId` ごとの fill activity を集約し、価格・数量・約定時刻を算出するロジックを追加する
- [x] `cron-tasks` の Saxo PENDING / IFDOCO exit 同期で、可能な場合は一括取得結果を使って更新する
- [x] `OrderId` 単位の個別 audit call はフォールバックまたは移行期間用に限定する
- [x] rate limit 時は既存の cooldown 挙動を維持する
- [x] 一括取得で取りこぼしにくいように lookback window / cursor 保存方針を決める
- [x] Saxo API レスポンス例を使った単体テストを追加する
- [x] `mise run test` を通す

# 注意点

- `ExternalReference` は Saxo 側の検索キーとして使える前提にしない
- 固定値 `trade-gateway` だけだとローカル注文との対応が弱いため避ける
- `ExternalReference` は最大 50 文字のため、長い `orders_v2.id` をそのまま入れない
- audit の `FillAmount` / `FilledAmount` / `ExecutionPrice` / `AveragePrice` の扱いは、部分約定と複数 fill を考慮する
- IFDOCO exit は take profit / stop loss のどちらが fill されたかを `OrderId` で判定する
- polling cursor を Firestore に保存する場合、巻き戻し用 lookback を併用して一時的な取得漏れに備える

# 参考

- Saxo order placement `ExternalReference`
  - https://developer.saxobank.com/openapi/referencedocs/trade/v2/orders/post__trade
- Saxo related/OCO order `ExternalReference`
  - https://developer.saxobank.com/openapi/referencedocs/trade/v2/orders/post__trade/schema-placerelatedorocoorder
- Saxo open orders filter
  - https://developer.saxobank.com/openapi/referencedocs/port/v1/orders/get__port
- Saxo net positions filter
  - https://developer.saxobank.com/openapi/referencedocs/port/v1/netpositions/get__port
- Saxo audit orderactivities
  - https://developer.saxobank.com/openapi/referencedocs/cs/v1/audit-orderactivities/get__cs_audit_orderactivities
- Saxo audit orderactivities response fields
  - https://developer.saxobank.com/openapi/referencedocs/cs/v1/audit-orderactivities/get__cs_audit_orderactivities/schema-orderactivitiesresponse

# ログ

## 2026-06-19 Codex

起票した。Saxo の `ExternalReference` は識別補助として使い、API call 削減は `audit/orderactivities` の一括 polling と `OrderId` / metadata 突合で進める方針。

## 2026-06-19 16:11 Codex GPT-5

内容精査後、以下の方針で実装を進めた。

- Saxo は現状どおり 1アカウント前提とし、`accounts[0].clientKey` を `orderactivities` batch polling に使う
- 複数アカウント対応時に `account_key` / `client_key` の metadata 保存と polling 状態分離が必要な旨を `docs/saxo.md` に記載する
- `cron_metadata/saxo_orderactivities_poll_state` に `last_poll_at` / `next_poll_url` を保存する
- 前回 polling から30分以内で cursor がある場合は `__nextPoll` を使い、30分を超える場合は `last_poll_at` から30分巻き戻した時間範囲で取得する
- 初回は48時間 lookback で取得する
- orders_v2 の Saxo 同期は注文ごとの audit call ではなく、同一 client 内の batch cache から `OrderId` 突合する
- `ExternalReference` は `tg:<event id 短縮値>` として entry / related orders に付与し、検索キーではなく識別補助として扱う
- `mise run test` で typecheck と API/UI test が通過した
