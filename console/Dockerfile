FROM mcr.microsoft.com/devcontainers/base:trixie

ENV TZ=Asia/Tokyo
ENV LANG=C.UTF-8

ARG USER_UID=2001
ARG USER_GID=2001

RUN groupmod -g ${USER_GID} vscode
RUN usermod -u ${USER_UID} vscode

USER vscode

RUN mkdir -p ~/.local/bin
RUN curl https://mise.run | sh
RUN ~/.local/bin/mise use --global fzf
RUN ~/.local/bin/mise use --global ripgrep
RUN ~/.local/bin/mise use --global aqua:go-task/task@latest

CMD ["bash"]
