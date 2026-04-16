# 構成

## ディレクトリ構成

- package.json / package-lock.json
  - npm workspace のルート。依存関係と共通スクリプトを管理する
- api/
  - APIアプリケーションが入っている
- ui/
  - UI アプリケーションが入っている

## サーバ構成

### ローカル

- firebase
  - docker の firebase network 上に存在している
  - 8080 で firestore が上がっている
  - 他のサービスからも接続される
  - 各サービスが自由に読み書きするので、内容は破壊されることもある
