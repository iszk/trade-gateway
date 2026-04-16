# Justfile: タスクランナー Just の設定ファイル

# デフォルトタスク: タスク一覧を fzf で選択して実行する
default:
    @just --choose

# すべてデプロイする
deploy: api-deploy

# API をデプロイする
api-deploy:
    echo "project = $DEPLOY_GOOGLE_CLOUD_PROJECT"
    : ${DEPLOY_GOOGLE_CLOUD_PROJECT:?"DEPLOY_GOOGLE_CLOUD_PROJECT が設定されていません。"}
    just api-build-and-push
    just api-deploy-from-registry

# API をビルドして Google Container Registry にプッシュする
api-build-and-push:
    gcloud builds submit . \
        --config api/cloudbuild.yml \
        --project $DEPLOY_GOOGLE_CLOUD_PROJECT

# API を Google Cloud Run にデプロイする
api-deploy-from-registry:
    gcloud run deploy trade-gateway \
        --project $DEPLOY_GOOGLE_CLOUD_PROJECT \
        --image asia-northeast1-docker.pkg.dev/$DEPLOY_GOOGLE_CLOUD_PROJECT/repos/trade-gateway \
        --region asia-northeast1 \
        --set-secrets "API_SECRET=API_SECRET:latest" \
        --set-secrets "WEBHOOK_SECRET=WEBHOOK_SECRET:latest" \
        --set-secrets "BITFLYER_API_KEY=BITFLYER_API_KEY:latest" \
        --set-secrets "BITFLYER_API_SECRET=BITFLYER_API_SECRET:latest" \
        --set-secrets "SAXO_APP_KEY=SAXO_APP_KEY:latest" \
        --set-secrets "SAXO_APP_SECRET=SAXO_APP_SECRET:latest" \
        --env-vars-file=api/prod.env.yml \
        --allow-unauthenticated
