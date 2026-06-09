---
title: bitFlyer と Saxo のブローカー実装世代差を解消する
status: wip
---

# 概要

bitFlyer と Saxo のブローカー実装を棚卸しし、`orders_v2` 前提で必要な注文追跡・約定同期・残高取得などの機能差を解消する。

現時点で確認できた差分は少なくとも 5 系統ある。

| 系統 | bitFlyer | Saxo | 影響 |
|---|---|---|---|
| `orders_v2` entry 約定同期 | `getExecutionPriceForOrderV2(order)` があり、broker metadata を解決・更新できる | `getExecutionPrice(orderId, ticker)` の旧形のみ | Saxo は order 全体の context を使えず、親子注文や将来の metadata 更新に対応しづらい |
| `orders_v2` exit 約定同期 | `getClosingExecutionForOrderV2(order)` があり、IFD/IFDOCO の複数 exit を集計できる | `getClosingExecution` / `getClosingExecutionForOrderV2` がない | Saxo の IFDOCO 相当注文は production の exit 同期対象にならない |
| broker metadata | `bitflyer_parent_order_v1` で entry / TP / SL の expected/resolved acceptance id を保持する | Saxo 用 metadata 型がない | Saxo の関連注文 ID、entry/exit の紐付け、再同期状態を永続化できない |
| production cron 登録 | `executionPriceFetchers` と `closingExecutionFetchers` の両方に登録される | `executionPriceFetchers` のみ。`closingExecutionFetchers` には未登録 | Saxo の exit レコード作成・更新が通常経路で走らない |
| 残高取得 | `getBalances()` / `getCollateral()` と `BalanceFetcher` がある | 残高取得がない | `/balances` や日次残高保存が bitFlyer 専用になっている |

# 背景

- `api/src/brokers/bitflyer.ts` は `getExecutionPriceForOrderV2` / `getClosingExecutionForOrderV2` を持ち、`OrderV2` と broker metadata を使って親注文・子注文の解決を行う新しい世代の実装になっている
- `api/src/brokers/saxo.ts` は `sendMarketOrder` で関連注文 (`Orders`) を送れる一方、戻り値は `providerOrderId` のみで、関連注文を後追いするための metadata を保存していない
- `SaxoClient.getExecutionPrice` は audit の `AveragePrice` と時刻を返すが、数量は `0` として返し、呼び出し側の `requested_size` フォールバックに依存している
- `api/src/index.ts` の cron context では Saxo が `executionPriceFetchers` にだけ登録され、`closingExecutionFetchers` には bitFlyer だけが登録されている
- 既存 issue [0008](./0008-support-saxo-ifdoco-in-orders-v2.md) は Saxo IFDOCO 対応に絞った issue なので、本 issue ではより広い broker capability parity と共通 interface 整理を追う

# 実装/修正プラン

- [ ] `ExecutionPriceFetcherLike` / `ClosingExecutionFetcherLike` を `orders_v2` 前提に寄せ、旧形メソッドを残す場合も互換用途に限定する
- [x] Saxo 用の `BrokerOrderMetadata` 型を追加し、entry / related orders / exit の紐付けに必要な ID と期待条件を保存できるようにする
- [x] Saxo の `sendMarketOrder` で stop loss / take profit 付き注文を出した場合、関連注文を後続同期できる metadata を `OrderDispatchResult` に含める
- [x] Saxo に `getExecutionPriceForOrderV2(order)` を追加し、entry 約定の価格・数量・約定時刻を `OrderV2` context と metadata から解決する
- [x] Saxo に `getClosingExecutionForOrderV2(order)` を追加し、利確・損切のどちらが約定したか、部分約定があるか、残注文がどう扱われるかを反映する
- [x] Saxo の exit 同期が安全に動く状態になったら `api/src/index.ts` の `closingExecutionFetchers` に Saxo を登録する
- [ ] Saxo の残高・証拠金取得要否を確認し、必要なら `BalanceFetcher` を broker 別実装へ分割して Saxo を追加する
- [ ] bitFlyer 固有の `getPositions()` が `FX_BTC_JPY` 固定になっている点も、broker parity の一部として symbol 設定ベースに直すか別 issue に切り出す
- [x] 既存 issue 0008 と重複する作業は、0008 側を Saxo IFDOCO 詳細設計、本 issue を共通 interface / production 登録 / 横断差分の親 issue として扱う
- [ ] bitFlyer / Saxo の両方について、entry 約定、exit 約定、部分約定、metadata 更新、未約定時の no-op をテストで固定する

# ログ

## 2026-06-08 00:43 Codex GPT-5

起票した。bitFlyer と Saxo の実装を比較したところ、`getExecutionPriceForOrderV2` / `getClosingExecutionForOrderV2` / broker metadata / cron の fetcher 登録 / 残高取得で世代差または片側実装が確認できた。特に Saxo は related orders を送信できるにもかかわらず、その後の exit 同期に必要な metadata と closing execution fetcher がなく、`orders_v2` の IFDOCO exit 追跡が production path で動かない。既存 issue 0008 は Saxo IFDOCO 個別設計として残し、本 issue では broker capability parity と共通 interface 整理を親スコープとして追う。

## 2026-06-09 00:39 Codex GPT-5

実装に着手し、Saxo 用 `broker_order_metadata` (`saxo_order_v1`) を追加する方針にした。まずは production path の差が大きい `orders_v2` entry/exit 同期と cron 登録を優先する。Saxo の発注レスポンスで related order id が取得できないケースは `resolved.order_id = null` として保持し、exit 同期では安全に no-op する。残高取得と bitFlyer の `getPositions()` 銘柄固定は、この変更と API 仕様確認の粒度が異なるため今回の実装範囲には含めない。

## 2026-06-09 10:36 Codex GPT-5

0008 と重複する Saxo IFDOCO 範囲を整理し、0008 側を詳細設計・完了判断用の issue として更新した。追加で、Saxo の片側 related order だけが約定し、もう片側に audit activity がない場合に約定済み側だけを exit 同期するテストを追加した。Saxo IFDOCO の entry/exit metadata、同期経路、未解決 related order id の no-op 方針は `docs/ifdoco-exit-flow.md` に追記済み。0015 側には残高・ポジション銘柄固定・横断 interface 整理の未完了項目を残す。
