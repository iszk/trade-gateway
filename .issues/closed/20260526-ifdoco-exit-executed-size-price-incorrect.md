# IFDOCO の exit 注文で orders_v2 に書き込まれる executed_size / executed_price の値が不正

## 概要

`orders_v2` コレクションに書き込まれたデータのうち、IFDOCO の exit（決済注文）で入ったレコードについて、`executed_size` および `executed_price` の値が正しくない。`requested_size` は正常に記録されている。

## 背景

- IFDOCO は「新規注文 → 利確注文 + 損切注文」の複合注文形式
- exit 注文が約定した際、`orders_v2` コレクションへの書き込み処理で約定数量・約定価格が誤った値になっている
- `requested_size`（注文数量）は正しく記録されているため、問題は約定情報の取得・マッピング処理に起因する可能性が高い

## 実装/修正プラン

- [x] `orders_v2` コレクションへの書き込み処理を特定する（`orders-v2.ts` など）
- [x] IFDOCO の exit 注文における約定情報（`executed_size`, `executed_price`）の取得元・マッピングロジックを調査する
- [x] 根本原因を特定: bitflyer の子注文順序依存の問題
- [x] `bitflyer.ts` の修正実施
- [x] テスト追加・修正、全テスト通過確認
- [ ] saxo の同様の箇所を調査・修正（bitflyer 修正確認後）

## ログ

### 2026-05-26 10:27:00 GitHub Copilot Claude Sonnet 4.6

**調査結果・根本原因**

`bitflyer.ts` の `getClosingExecution` と `getExecutionPrice` の両メソッドが、`GET /v1/me/getchildorders` のレスポンスの **配列インデックス** に依存していたことが原因。

具体的には：
- `getClosingExecution` で `childOrders.slice(1)` でエントリー注文（index 0 想定）をスキップし、残りを決済注文として扱っていた
- `getExecutionPrice` で `childOrders[0]` をエントリー注文として参照していた

しかし bitflyer の `getchildorders` API はレスポンスの順序を保証していないため、OCO の決済注文が先頭に返されたケースで：
- `slice(1)` にエントリー（MARKET）が含まれてしまう
- エントリーは IFDOCO 発動後は常に `COMPLETED` なので `closingChildren` に混入する
- エントリーの約定価格・数量が exit レコードの `executed_price` / `executed_size` として書き込まれる

`requested_size` は `order.requested_size`（親注文から直接コピー）なので正しいまま、という症状とも一致。

**修正内容**

`api/src/brokers/bitflyer.ts`
- `BitflyerChildOrderEntry` に `child_order_type: string` を追加
- `getClosingExecution`: `childOrders.slice(1)` → `childOrders.filter(c => c.child_order_type !== 'MARKET' && ...)` に変更
- `getExecutionPrice` (親注文フォールバック): `childOrders[0]` → `childOrders.find(c => c.child_order_type === 'MARKET')` に変更

`api/src/brokers/bitflyer.test.ts`
- 既存テストのモックデータに `child_order_type` を追加
- バグ再現テスト2件を追加:
  - `getClosingExecution`: API がエントリーを index 0 以外で返した場合でも正しい決済情報を返すこと
  - `getExecutionPrice`: API が MARKET 注文を index 0 以外で返した場合でも正しいエントリー情報を返すこと

全 141 テスト PASS 確認済み。

**今回あえて対応しなかった内容**
- saxo の同様の調査・修正: 現象が確認されていないため bitflyer 修正確認後に別途対応予定

### 2026-05-26 16:28:00 GitHub Copilot GPT-5.4

**再調査結果**

上記の順序依存問題だけでは、親注文 `0.001` に対して exit 側 `executed_size = 0.008` になる症状を十分に説明できなかったため再確認した。

その結果、bitflyer の execution/child order 照会 (`getExecutionPrice`, `getClosingExecution`) で `product_code` に渡している値が、Webhook 由来の `ticker` 生値 (`FXBTCJPY`, `BTCJPY`) のままになっていたことを確認した。

このコードでは発注時 (`sendMarketOrder`) のみ `resolveProductCode()` で `FX_BTC_JPY` / `BTC_JPY` に正規化していたが、照会時は未正規化のまま API を呼んでいた。

そのため bitflyer API 側で意図した親注文・子注文に正しく絞り込めず、別注文の約定情報を拾って `orders_v2` の exit レコードに書き込む可能性があった。親 `0.001` に対して exit `0.008` になっていた症状はこれと整合する。

**追加修正内容**

`api/src/brokers/bitflyer.ts`
- `getExecutionPrice` / `getClosingExecution` 内でも `resolveProductCode(ticker)` を使用するよう修正
- `TICKER_PRODUCT_CODE_MAP` に `FXBTCJPY -> FX_BTC_JPY`, `BTCJPY -> BTC_JPY` を追加

`api/src/brokers/bitflyer.test.ts`
- execution/closing query で `FXBTCJPY` を `FX_BTC_JPY` に正規化して API 呼び出しすることを検証するテストを追加

全 143 テスト PASS 確認済み。

### 2026-05-27 22:41:00 GitHub Copilot GPT-5.4

**追加調査結果**

`getClosingExecution` / `getExecutionPrice` で `getchildorders` に `parent_order_acceptance_id=JRF...` を渡していたが、実地確認ではこのパラメータでは絞り込みが効かず、大量の child order が返ることが確認された。

一方、`parent_order_id=JCO...` であれば正しく絞り込みされる。したがって、親注文受付ID (`JRF...`) を保持している現在の実装では、先に `getparentorder` を呼んで `parent_order_id` (`JCO...`) に解決し、その値で `getchildorders` を呼ぶ必要がある。

これは `tools/bf-order-status.py` の既存ロジックとも整合する。

**追加修正内容**

`api/src/brokers/bitflyer.ts`
- `GET /v1/me/getparentorder` を使って `JRF...` から `JCO...` を解決する `resolveParentOrderId()` を追加
- `getExecutionPrice` / `getClosingExecution` の `getchildorders` 呼び出しを `parent_order_id=JCO...` ベースに変更
- `getClosingExecution` のログに `resolvedParentOrderId` を追加

`api/src/brokers/bitflyer.test.ts`
- `getparentorder -> getchildorders(parent_order_id)` の流れを検証するよう既存テストを更新
- 親注文ID解決失敗時に `null` を返すテストを追加

全 144 テスト PASS 確認済み。
