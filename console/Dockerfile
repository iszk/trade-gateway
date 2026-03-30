FROM mcr.microsoft.com/devcontainers/typescript-node:24-trixie

RUN apt-get update && apt-get upgrade -y

RUN echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list && curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && apt-get update -y && apt-get install google-cloud-cli -y
RUN apt-get update && apt-get install google-cloud-cli -y


ARG USERNAME=vscode
ARG GROUPNAME=vscode
ARG UID=2001
ARG GID=2001
# FIXME 将来的に直す
#  これはDockerfileの中で定数として定義するべきではない
#  ユーザーとグループのIDは、ホストマシンのユーザーと一致させる必要がある
#  そうしないと、ホストマシンとコンテナ間でファイルの所有権が正しく設定されない可能性がある

RUN groupadd -g $GID $GROUPNAME && \
    useradd -m -s /bin/bash -u $UID -g $GID $USERNAME

USER $USERNAME
