# 実装コメント・メモ帳

実装時に気になった点や残しておくべき事項を日時とともに追記していきます。

## 2026-05-25: Phase 1 (データモデルと型の定義) 完了
- `api/src/types/order-v2.ts` に `OrderV2` 型を定義しました。
- `api/src/services/orders-v2.ts` に Firestore CRUD 関数を実装しました。
- 気になる点:
  - Timestamp の取り扱いは、Admin SDK に Date を渡し、読み取り時に `.toDate()` で Date に戻す形で実装しました。

## 2026-05-25: Phase 2 (デュアルライト追加) 完了
- `api/src/index.ts` を修正し、Webhook受付時に既存の `open_trades` への保存と並行して、新設した `orders_v2` へ `PENDING` ステータスとして記録（デュアルライト）するようにしました。
- 注文タイプについて、`stop_loss` と `take_profit` が指定されている場合は `IFDOCO` とし、それ以外は `MARKET` とする判別ロジックを採用しました。
- `api/src/index.test.ts` にも `addOrderV2` をモックして検証するアサーションを追加しました。

## 2026-05-25: Phase 3 (ステータス同期バッチの実装) 完了
- `api/src/services/cron-tasks.ts` に `fetchAndUpdatePendingOrdersV2` を実装し、10分おきの Cron タスク内で `PENDING` ステータスの `orders_v2` ドキュメントの約定確認と `EXECUTED` への更新を行うようにしました。
- 気になる点:
  - IFD-OCO のような複合注文の場合、Webhook での生成時は `provider_order_ids` が配列として記録されますが、現在の同期ロジックでは簡易的に「最初の注文ID (親注文)」のみを利用して API 照会しています。子注文の約定確認も含めた厳密な同期は今後の課題とします。
  - 約定数量 (`executed_size`) についても、APIから部分約定などを正確に拾うのではなく、簡易的に要求数量 (`requested_size`) を設定するようにしています。

## 2026-05-25: Phase 4 (新しい集計ロジックの実装) 完了
- `api/src/services/stats-v2.ts` を新設し、`orders_v2` の時系列履歴（`EXECUTED`ステータス）をリプレイして現在のポジション数、平均取得単価、実現損益（PnL）、勝率などを動的に算出する Streaming Calculator を実装しました。
- `api/src/index.ts` に `/api/v2/stats` エンドポイントを追加し、指定した strategy の PnL および勝率等を返すようにしました。
- 気になる点:
  - 計算時、要求数量と実約定数量の差異をより厳密に扱う場合は API クライアントからのデータ取得側も対応する必要があります。現状は簡易的にフォールバック (`order.executed_size || order.requested_size`) しています。
  - 今回は指定した `strategy` のみの集計ですが、後から複数戦略を同時に返却できるような拡張も視野に入れた方が良さそうです。

## 2026-05-25: 部分約定への対応と戦略スキャンの動的化
- `orders_v2` の同期ロジックを強化し、決済注文（IFD-OCO の exit 側）の部分約定に対応しました。
  - `BitflyerClient.getClosingExecution` において、全ての決済子注文の約定履歴を合算して返すように修正しました。
  - `syncExecutionsForExecutedIfdOrders` において、既に exit レコードが存在する場合でも、Broker 側の約定数量が増加していれば `executed_size` と `executed_price` を更新するようにしました。
- IFD-OCO の同期対象とする戦略のハードコードを廃止しました。
  - `orders_v2` コレクションに対し、`status: "EXECUTED"` かつ `order_type: "IFDOCO"` なドキュメントを直接クエリする `getActiveIfdOrdersV2` 関数を導入しました。
  - これにより、新しい戦略が追加された場合でも、ソースコードの変更なしに自動的に同期対象に含まれるようになりました。
- 気になる点:
  - Firestore クエリ (`status == "EXECUTED" AND order_type == "IFDOCO"`) は、件数が増えた場合に複合インデックスが必要になる可能性がありますが、現状の運用規模では問題ない見込みです。
  - `stats-v2.ts` による再計算時、レコードの更新 (`updated_at`) が発生するため、キャッシュ等の最適化を行う場合は考慮が必要です。

## 2026-05-25: Phase 5 (UI対応と旧システムのフェードアウト) について
- バックエンドの API エンドポイントまで完成したため、要件にある「一旦共存を考えている」という方針に基づき、新旧データの並行蓄積を開始する状態としました。
- 旧システムのロジック (`open_trades`, `trade_records` のペアリング処理など) は削除せずに残してあります。
- 今後、`orders_v2` に十分なデータが蓄積され、V2 API `/api/v2/stats` への疎通・UI表示の構築が完了した段階で、旧システムのコードとCronジョブのフェードアウト（Phase 5 の最終段階）を実施することをおすすめします。
