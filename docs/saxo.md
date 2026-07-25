# Saxo 連携メモ

## Saxo OAuth token 暗号化運用

### 実装方式

Saxo の `accessToken` と `refreshToken` は単一 JSON payload にして、Node.js `crypto` の AES-256-GCM で暗号化する。Firestore の `saxo_auth_data/saxo_auth.encryptedTokens` には version 1 envelope を保存し、平文 token field は保存しない。暗号鍵は Cloud KMS ではなく Secret Manager の `SAXO_TOKEN_ENCRYPTION_KEY` に保管し、Cloud Run へ環境変数として注入する。

鍵は 32 byte の canonical base64、IV は暗号化ごとに生成する 12 byte、authentication tag は 16 byte である。AAD は `saxo_auth_data/saxo_auth:v1` に固定する。document schema の詳細は [DB 仕様](./database-spec.md#6-saxo_auth_data) を参照する。

### 初回導入手順

以下は運用者が対象 project、region、Cloud Run service、runtime service account を確認して実施する。実値や生成した鍵を shell output、チャット、issue、CI log、Git 管理下のファイルへ残さない。

1. 対象を明示する。

   ```bash
   export PROJECT_ID="<production-project-id>"
   export REGION="asia-northeast1"
   export SERVICE="trade-gateway"
   export SECRET_NAME="SAXO_TOKEN_ENCRYPTION_KEY"
   export RUNTIME_SERVICE_ACCOUNT="<cloud-run-runtime-service-account>"
   ```

   `RUNTIME_SERVICE_ACCOUNT` は deploy 実行者ではなく、Cloud Run revision が実行時に使用する service account を指定する。現在値は次で確認できる。

   ```bash
   gcloud run services describe "$SERVICE" \
     --project "$PROJECT_ID" \
     --region "$REGION" \
     --format='value(spec.template.spec.serviceAccountName)'
   ```

2. 安全な端末で 32 byte key を一時ファイルへ生成する。既存 secret がある場合は新しい鍵を生成せず、後述の rotation 制約を先に確認する。

   ```bash
   umask 077
   openssl rand -base64 32 > /tmp/saxo-token-encryption-key
   ```

   出力は改行を含み得るが、アプリケーションの設定読込時に前後空白を除去する。base64 decode 後が 32 byte であることを、値を表示せず確認する。

   ```bash
   test "$(openssl base64 -d -A -in /tmp/saxo-token-encryption-key | wc -c | tr -d ' ')" = 32
   ```

3. Secret Manager secret を作成し、key を version として登録する。secret が既に存在する場合、単一鍵運用中は安易に version を追加しない。

   ```bash
   gcloud secrets create "$SECRET_NAME" \
     --project "$PROJECT_ID" \
     --replication-policy=automatic
   gcloud secrets versions add "$SECRET_NAME" \
     --project "$PROJECT_ID" \
     --data-file=/tmp/saxo-token-encryption-key
   ```

4. runtime service account に対象 secret だけの参照権限を付与する。

   ```bash
   gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
     --project "$PROJECT_ID" \
     --member="serviceAccount:$RUNTIME_SERVICE_ACCOUNT" \
     --role="roles/secretmanager.secretAccessor"
   ```

5. 一時ファイルを安全に削除し、deploy する。`api/Justfile` は `SAXO_TOKEN_ENCRYPTION_KEY=SAXO_TOKEN_ENCRYPTION_KEY:latest` を Cloud Run に設定する。

   ```bash
   rm /tmp/saxo-token-encryption-key
   DEPLOY_GOOGLE_CLOUD_PROJECT="$PROJECT_ID" just api deploy
   ```

6. 新 revision の起動成功と、Secret Manager access denied、暗号鍵 validation error、`saxo_auth:migration_failed` がないことを Cloud Run log で確認する。鍵がない・不正・既存 envelope を復号できない場合、アプリケーションは fail-closed する。平文保存へ戻して回避してはいけない。

7. 認証済み API secret を安全に環境変数へ設定し、Saxo token を読む API を 1 回呼ぶ。`/api/saxo/portfolio-snapshot` は認証状態を読み、必要なら legacy document を transaction 内で encrypted v1 へ移行する。

   ```bash
   curl --fail-with-body \
     --header "Authorization: Bearer $API_SECRET" \
     "https://<service-url>/api/saxo/portfolio-snapshot"
   ```

8. Firestore console で `saxo_auth_data/saxo_auth` の field 名だけを確認する。`encryptedTokens.version = 1` と `algorithm = aes-256-gcm` が存在し、top-level の `accessToken` と `refreshToken` が消失していることを確認する。token、ciphertext、鍵を log や作業記録へコピーしない。

9. Saxo API 呼び出しが成功し、refresh が必要な場合も token 更新後に平文 field が再作成されないことを確認する。migration 完了の記録には project/environment、確認日時、encrypted v1、平文 field なしという結果だけを残す。

### 読み取り時移行と fail-closed

legacy document は `accessToken` / `refreshToken` と metadata を検証した後、transaction 内でもう一度最新 document を読み、まだ legacy の場合だけ encrypted v1 へ全置換する。別 instance の refresh が先に commit した場合は transaction を再実行し、最新の encrypted token を返す。

encrypted/plaintext の混在、不正 schema、鍵の未設定・不正、wrong key、envelope 改ざんでは plaintext fallback しない。migration の parse、暗号化、commit が失敗した場合も legacy document を変更せず request を失敗させる。OAuth token endpoint の失敗では raw response body を破棄し、Error / log には HTTP status と固定メッセージだけを残す。

### Rollback と再認証の判断

- 0030-3 の revision だけを戻す場合は、encrypted v1 を読める 0030-2 以降の revision と同じ secret version へ rollback する。
- 一度 encrypted v1 へ移行した後は、平文 field を前提とする暗号化対応前 revision へ rollback しない。旧 revision は encrypted document を読めない。
- migration commit が失敗しただけなら legacy document は残る。正しい鍵、IAM、Firestore 状態を復旧して同じ read を再試行し、先に再認証や手動 document 編集を行わない。
- secret version を誤って変更して復号不能になった場合は、旧鍵を保持する secret version へ Cloud Run の参照を戻す。旧 version を disable/destroy してはいけない。
- encrypted document の旧鍵を復旧できない、または Saxo token 自体が失効・無効な場合は復号による回復はできない。正しい現行鍵を注入した revision で `/api/auth/saxo/login` から再認証し、新しい encrypted v1 document で全置換する。再認証前に対象環境と鍵を再確認する。
- rollback や再認証の確認中も production Firestore document を手動で平文へ戻さない。

### 鍵 rotation の制約

現行 envelope は `keyId` を持たず、アプリケーションも単一鍵しか読み込まない。既存 document を旧鍵で復号できる仕組みなしに `SAXO_TOKEN_ENCRYPTION_KEY` の `latest` を新しい鍵へ差し替えると、既存 token は即座に復号不能になる。旧鍵なしで secret を差し替えてはいけない。

rotation を行うには、旧鍵と新鍵を同時に読める keyring、envelope の key ID、旧鍵で復号して新鍵で再暗号化する移行、全環境の移行完了確認、旧鍵廃止の順序を別設計として実装する必要がある。Cloud KMS、automatic key rotation、複数鍵対応は現行スコープ外である。

### Legacy reader の削除候補

legacy reader は遅延移行のための一時的な互換経路であり、恒久化しない。すべての active environment で固定 document が encrypted v1 になり、平文 field が存在せず、一定の運用期間で migration failure がないことを確認した後、`parseLegacyDocument` と読み取り時 migration 分岐、その専用テストを削除して plaintext document を常に拒否する follow-up task を起票する。

## 前提

現状の実装は Saxo の 1 アカウント運用を前提にする。`saxo_auth_data/saxo_auth.accounts[0]` の `clientKey`（Saxo API レスポンス上は `ClientKey`）を audit 取得に使い、発注時の account 選択も既存実装どおり、対象 `AssetType` を扱える最初の account を使う。

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

- `last_poll_at`: 全ページの取得に成功した最後の batch polling 時刻
- `next_poll_url`: Saxo の `__nextPoll` URL。空文字の場合は未保持として扱う

前回 polling から 30 分以内で `next_poll_url` がある場合は cursor を使う。30 分を超えている場合は cursor を捨て、`last_poll_at` から 30 分巻き戻した `FromDateTime` と現在時刻の `ToDateTime` で再取得する。初回は 48 時間 lookback で取得する。

取得 page size は Saxo の推奨範囲上限である `$top=500`、1 poll の上限は20ページとする。`__next` がある限り全ページを取得し、途中の HTTP failure、payload parse failure、または20ページ到達時は batch 全体を incomplete として破棄する。incomplete batch の partial activity は約定同期に使わず、`last_poll_at` と `next_poll_url` も更新しない。`__nextPoll` は全ページ取得に成功した場合だけ保存する。

activity は `LogId` で重複排除し、`ActivityTime` と時系列性が保証された `LogId` で正規化してから注文単位で解決する。同じ `LogId` が複数ページや overlap 範囲に含まれても約定数量へ二重加算しない。

約定集約は履歴の完全性を明示して使い分ける。OrderId direct照会とhourly range reconciliationの `COMPLETE_HISTORY` では、全 confirmed fill に有効な `FillAmount` と価格がある場合だけ fill ごとの合計と数量加重平均価格を使う。1件でも欠落する場合は一部のfillだけを合算せず、最大の `FilledAmount` / `Amount` と、その累積値に対応する最新の平均価格へ fallback する。cursor poll batchとrecent activityの `INCREMENTAL_SNAPSHOT` では差分 `FillAmount` を合算せず、`FilledAmount` / `Amount` と価格で注文全体の累積snapshotを確定できる場合だけ約定を返す。数量または価格が確定できないfillは誤同期を避けるため未確定として扱う。有効な時刻を持つfillのうち最新の時刻を約定時刻にする。

broker state は `Status` と `SubStatus` を組み合わせて解決する。confirmed の `FinalFill` / `Fill` / `Cancelled` / `Expired`、`Placed + Rejected`、進行中の placement/change/working と、未知または曖昧な activity を区別する。既存 payload 互換のため `SubStatus` 欠落時の fill は認識するが、requested/rejected fill は約定へ集約しない。confirmed fill は placement rejection より優先し、confirmed cancel/expire と部分約定が共存する場合は約定 snapshot を保持したまま `orders_v2` を `CANCELED` にする。`Placed + Rejected` は confirmed fill または confirmed placement がない場合だけ `FAILED` にし、rejected cancel/change と `DoneForDay` は非終端として `PENDING` を継続する。未知または cancel と expire が矛盾する activity は安全側で `PENDING` とする。

Saxo の execution sync result は、約定 snapshot、終端 status（`CANCELED` / `FAILED`）、固定された terminal reason、broker metadata で構成する。cron は execution が要求数量へ到達した場合を常に `EXECUTED` とし、同一 snapshot の再取得では Firestore を更新しない。execution が要求数量未満で confirmed cancel/expire の場合は `executed_price`、`executed_size`、`executed_at`、既知の commission を保持して `CANCELED` にする。overfill は status と execution のいずれも保存しない。

### Batch miss recovery

10分 cron は PENDING orders_v2 を broker 単位で渡し、Saxo の bulk contract は account-wide cursor batch を1回だけ取得する。batch に entry の `OrderId` がない注文だけを direct candidate とし、`ClientKey`、`OrderId`、`EntryType=All`、`$top=500` を付けた orderactivities endpoint を最大5ページまで取得する。batch hit では direct call を発生させない。

direct recovery は1 sessionあたり最大10注文、HTTP request最大20回（paging/retry込み）、audit request共有同時数2で実行する。network error/5xx は budget 内で1回だけ指数 backoff + jitter retry し、429 は `Retry-After` または既存 cooldown を設定して同一 session 内で再試行しない。page limit、途中HTTP failure、parse failureの場合はその注文のpartial activityを適用しない。

direct candidate は runtime validation 済みの `saxo_order_v1` metadata を持つ注文（同一 session で合成した単体 MARKET を含む）に限る。provider order ID がない、`DRY_RUN`、補完不能な metadata の注文では外部APIを呼ばない。candidate は OrderId の安定順で並べ、`cron_metadata/saxo_orderactivities_reconciliation_state` の位置から round-robin する。direct callを1件以上開始した場合だけ最後に開始した OrderId と時刻を保存し、state write failure は注文同期を失敗扱いにしない。

session結果は `saxo:orderactivities_reconciliation_summary` へ1件に集約し、pending、valid metadata、recoverable / generated metadata、unrecoverable reason 別件数、batch matched、direct candidates、attempted、deferred、recovered、no-match、failed、rate-limited、terminal counts、最大5件の sample OrderId を出力する。24時間を超えた MARKET PENDING も stale skip せず、以後の session で最大10件ずつ救済する。

### Legacy MARKET metadata recovery

10分の entry 同期は、Saxo の単体 `MARKET` で `broker_order_metadata` が完全に欠落している legacy order に限り自己修復する。対象は Saxo、非空で `DRY_RUN` ではない先頭 `provider_order_ids`、`BUY` / `SELL` の side、正の `requested_size` を持つ注文である。`MARKET` 以外、特に metadata 欠落 IFDOCO、provider ID 欠落、別 broker、別 kind、malformed data、provider ID・entry ID・side・size・external reference が矛盾する既存 `saxo_order_v1` は補完しない。

生成する値は次の最小 schema だけで、発注時の根拠がない `external_reference` は生成しない。

```text
kind: saxo_order_v1
order_id: provider_order_ids[0]
entry.expected: { side: order.side, order_type: Market, size: order.requested_size }
entry.resolved: { order_id: provider_order_ids[0] }
exits: []
```

生成後も status を推測せず、既存 resolver が confirmed fill、cancel/expire、placement rejection を返した場合だけ execution / terminal status を更新する。no-match、未確定、deferred、429、batch/direct failure でも metadata-only result を共通 transaction へ渡すため、次回から通常の entry sync 対象へ復帰する。summary では valid metadata、recoverable / generated metadata、unrecoverable reason 別件数、最大5件の provider OrderId sample を execution recovered counter と分けて記録する。

合成 metadata は transaction 内で未設定時だけ保存する。同一 metadata が先行保存済みなら lifecycle の単調差分を継続し、別 metadata が先行保存済みなら metadata・execution・status を上書きしない。10分同期の batch cursor、direct recovery、single fallback が同じ分類を使い、bulk reject 時も各 order を single fallback へ隔離して渡す。

### Hourly range reconciliation

1時間 cron は、10分 cursor polling および direct lookup とは独立して、Saxo の entry PENDING 注文を直近48時間の range で再照合する。呼び出しには `ClientKey`、`FromDateTime`、`ToDateTime`、`EntryType=All`、`$top=500` を指定し、最大20ページを取得する。`Status` filter は指定しない。

range の対象は有効な `saxo_order_v1` metadata と entry `OrderId` を持つ注文で、range end 時点の作成日時が24時間以内のものに限る。24時間を超える stale 注文は range の不完全な履歴で上書きせず、10分 cron の OrderId direct recovery に任せる。IFDOCO の exit related order は hourly range reconciliation の対象外である。

各ページは共通 audit concurrency limiter（最大2）を通し、`LogId` で全ページの重複を除去してから entry OrderId ごとに共通 activity resolver へ渡す。途中 HTTP failure、parse failure、page limit 到達、または429では全 activity を破棄し、結果を orders_v2 に適用しない。429 は既存 cooldown を設定し、同一 run では再試行しない。

reconciliation state は `cron_metadata/saxo_orderactivities_reconciliation_state` に保存する。`INCOMPLETE` または `RATE_LIMITED` の場合は保存済み window を次回最優先で再試行し、complete の場合だけ `last_reconciliation_completed_at` を更新して次回の新しい48時間 windowへ進む。既存の `direct_lookup_after_order_id` と `last_direct_lookup_at` は同じ document 内で保持する。range response の `__nextPoll` は保存せず、`saxo_orderactivities_poll_state.last_poll_at` と `next_poll_url` は一切変更しない。

complete result のみを shared execution apply helper に渡すため、fill、cancel、expire、rejection の status 更新は direct/cursor と同じ規則で冪等に適用される。同一 window の再取得では同じ snapshot を Firestore に再更新しない。poll batchでfill activityはあるが累積snapshotを確定できない注文は、暫定値を保存せずdirect candidateへ回す。direct capまたはrequest budgetの対象外になった場合は次回sessionへdeferする。summary log には window、pending、eligible、activity、matched、executed、partial、canceled、failed、no-match、page count、outcome を記録する。
