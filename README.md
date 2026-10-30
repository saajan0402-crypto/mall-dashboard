# モール横断ダッシュボード

Amazon・楽天を横断して、案件（ブランド・店舗）ごとの売上・粗利・広告・在庫を見るための社内ツール。

- 利用者：社内4名
- モールへの書き込みは行わない（取り込み方向の一方向のみ）
- 広告の入札変更は人が管理画面で行い、このツールは分析と提案だけを担う

## 構成

| 役割 | 使うもの |
|---|---|
| 画面・処理 | Cloudflare Workers |
| データベース | Cloudflare D1 (`DB`) |
| ファイル保存 | Cloudflare R2 (`FILES`) |
| 定期実行 | Cron Triggers（毎朝6時 JST） |
| ログイン | Cloudflare Access（メール確認コード） |
| AI | Claude API |
| 通知 | Slack |

## セットアップ（初回のみ）

### 1. D1 データベース  ✅ 作成済み

- 名前：`mall-dashboard`
- Database ID：`ef5c1072-423b-45ae-9f2e-d1a018596b95`（作成済み。`wrangler.jsonc` に設定済み）

### 2. R2 バケット  ✅ 作成済み

- 名前：`mall-dashboard-files`（作成済み）

### 3. リポジトリを Workers に接続する

Cloudflare ダッシュボード → Workers & Pages → Create → Import a repository

- このリポジトリを選ぶ
- Build command：`npm install`
- Deploy command：`npx wrangler d1 migrations apply mall-dashboard --remote && npx wrangler deploy`

デプロイのたびに未適用のマイグレーションが先に流れるので、スキーマ変更を別途手で流す必要はない。

以後、`main` に変更が入るたびに自動でデプロイされる。
プルリクエストごとに確認用の URL も作られるので、本番に出る前に動きを確認できる。

### 4. シークレットを登録する

```bash
npx wrangler secret put CLAUDE_API_KEY
npx wrangler secret put SLACK_WEBHOOK_URL
npx wrangler secret put SECRET_KEY        # 案件ごとの接続情報を暗号化する親鍵
```

ダッシュボードから登録する場合：Workers & Pages → mall-dashboard → Settings → Variables and Secrets

**キーはコード・リポジトリ・チャットのいずれにも置かない。**
案件ごとの接続情報（SP-API / RMS）は、アプリの接続画面から登録し、`SECRET_KEY` で暗号化して D1 に保存する。

### 5. ログインを有効にする

Workers & Pages → mall-dashboard → Settings → Domains & Routes → Enable Cloudflare Access

Zero Trust 側で、社員4名のメールアドレスを許可する。本番 URL と確認用 URL の両方に掛かる。

### 6. 接続を確認する

公開された URL を開くと、D1・R2・シークレットの状態が一覧で出る。すべて OK になれば土台は完成。

## 開発

```bash
npm install
npx wrangler d1 migrations apply mall-dashboard --local   # 手元のDBにテーブルを作る
npm run dev                                               # http://localhost:8787
```

手元で動かすぶんには課金は発生しない。

## ディレクトリ

```
src/index.ts          Worker 本体（API と日次バッチ）
migrations/           D1 のスキーマ
public/               画面（静的ファイル）
wrangler.jsonc        バインディングと cron の設定
```

## データの持ち方

- 金額はすべて「円」の整数。小数は使わない
- すべてのデータは案件（`case_id`）に属する。Claude に渡す文脈は必ず1案件分に限定する
- 取り込んだ生データは R2 に残す。計算ロジックを変えても、そこから作り直せる
- 原価・料率など「事実の設定」は適用開始日を持たせ、過去を塗り替えない
- 粗利の費目など「構成の設定」は変更時に全期間を再計算する
