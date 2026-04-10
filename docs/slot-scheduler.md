# スロットスケジューラー（Slot Scheduler）

## 概要

Cloud Run は Cloud Scheduler により **1分間隔** で起動される。このメイン処理の中で「10分に1回」「1時間に1回」といった、より低頻度なサブタスクを実行したい場合に用いる仕組みが **スロットスケジューラー** である。

Cloud Run はステートレスであるため、直前の実行履歴を保持できない。また Cloud Scheduler の起動時刻には数秒のジッター（前後誤差）が生じる可能性がある。これらの課題を解決するために、Firestore を用いて「最後に実行した時間枠（スロット）」を管理し、**重複実行や実行漏れを防止する**。

---

## スロット計算ロジック

```
slot_id = floor((nowSeconds - 30) / intervalSeconds)
```

- `nowSeconds`: 現在時刻（Unixタイムスタンプ、秒単位）
- `intervalSeconds`: 実行周期（例: 600秒 = 10分、3600秒 = 1時間）
- `30秒を引く理由`: Cloud Scheduler のジッターを吸収するため。実際の境界より30秒前後にずれていても、同じスロットIDが算出される

### ジッター耐性の例（10分タスク）

| 実際の起動時刻  | nowSeconds | slot_id |
|----------------|-----------|---------|
| 09:00:01       | 32401     | 53      |
| 09:00:00       | 32400     | 53      |
| 08:59:59       | 32399     | 53      |
| 09:00:30       | 32430     | 54      | ← 次のスロット

09:00:30 以降に初めて slot_id = 54 に切り替わるため、09:00:xx 付近のジッターはすべて同一スロットとして扱われる。

---

## Firestore による状態管理

Firestore のドキュメント `cron_metadata/task_status` に、各タスクが最後に実行したスロットIDを保持する。

```
cron_metadata/task_status
  last_slot_10m: <number>   // 10分タスクが最後に実行されたスロットID
  last_slot_1h:  <number>   // 1時間タスクが最後に実行されたスロットID
```

Firestore のトランザクションを使用し、以下の条件を満たす場合のみタスクを実行する：

```
currentSlot > lastSlot
```

条件を満たした場合は `lastSlot` を `currentSlot` で更新してからタスクを実行する。これにより Cloud Scheduler が同一周期内に複数回トリガーされた場合でも、タスクの重複実行を防止できる。

---

## エラーハンドリング

- Firestore への接続エラーやトランザクション失敗は `runIfNewSlot` 内部でキャッチし、`warn` ログを出力して **リスローしない**
- スロットスケジューラー全体で予期しない例外が発生した場合も、`/api/cron` ハンドラーの外側の `try/catch` でキャッチし、メインの毎分処理（200レスポンス）を妨げない

---

## 実装ファイル構成

| ファイル | 役割 |
|----------|------|
| `src/services/slot-scheduler.ts` | スロット計算・Firestoreトランザクション・`SlotScheduler` インターフェース |
| `src/services/slot-scheduler.test.ts` | スロット計算ロジックと `runIfNewSlot` の単体テスト |
| `src/services/cron-tasks.ts` | 各周期タスクの実装（`executeTenMinutelyTask`, `executeHourlyTask`） |
| `src/index.ts` `/api/cron` | スロットスケジューラーを呼び出し、サブタスクを実行するエントリポイント |

---

## 新しい周期タスクを追加する手順

### 1. `SlotKey` 型に新しいキーを追加する

`src/services/slot-scheduler.ts` の `SlotKey` 型に、新しいスロットキーを追加する。

```typescript
// Before
export type SlotKey = 'last_slot_10m' | 'last_slot_1h'

// After（例: 30分タスクを追加する場合）
export type SlotKey = 'last_slot_10m' | 'last_slot_1h' | 'last_slot_30m'
```

### 2. タスク関数を `cron-tasks.ts` に追加する

`src/services/cron-tasks.ts` にタスクの実装を追加する。現状はログ出力のみでよいが、実際の処理はこの関数に実装する。

```typescript
export const executeThirtyMinutelyTask = async (logger: Logger): Promise<void> => {
    logger.info({ event: 'cron:thirty_minutely_task' }, '30-minute task executed')
    // ここに実際の処理を追加する
}
```

### 3. `/api/cron` ハンドラーでスロットスケジューラーを呼び出す

`src/index.ts` の `/api/cron` ハンドラー内の `Promise.all` にエントリを追加する。

```typescript
await Promise.all([
    slotScheduler.runIfNewSlot({
        nowMs,
        intervalSeconds: 600,
        slotKey: 'last_slot_10m',
        task: () => executeTenMinutelyTask(logger),
        logger,
    }),
    slotScheduler.runIfNewSlot({
        nowMs,
        intervalSeconds: 3600,
        slotKey: 'last_slot_1h',
        task: () => executeHourlyTask(logger),
        logger,
    }),
    // 追加: 30分タスク
    slotScheduler.runIfNewSlot({
        nowMs,
        intervalSeconds: 1800,
        slotKey: 'last_slot_30m',
        task: () => executeThirtyMinutelyTask(logger),
        logger,
    }),
])
```

### 4. テストを追加する（任意だが推奨）

`src/services/slot-scheduler.test.ts` に、新しいスロットキーに関するテストを追加する必要はないが、`src/index.test.ts` の `/api/cron` テストで新しいスロットキーが正しく呼ばれることを確認することを推奨する。

---

## 注意事項

- `intervalSeconds` と `slotKey` は対応させること（例: interval=600 ↔ `last_slot_10m`）。  
  誤った組み合わせ（例: interval=600 に `last_slot_1h` を指定）は、スロット計算の誤りを招く。
- 同一の `slotKey` に異なる `intervalSeconds` を使用してはならない。Firestoreに保存されるスロットIDは interval によって異なるため、一貫性が保てなくなる。
- Cloud Scheduler の最小実行間隔は1分であるため、`intervalSeconds` は60以上（かつ60の倍数）を推奨する。
