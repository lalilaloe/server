FROM node:slim
ARG CLIENT_TAG=latest
ARG NODE_ENV=production
ARG SENTRY_DSN
ENV SENTRY_DSN=$SENTRY_DSN
ENV NEXT=1

ADD "." "/usr/local/lib/node_modules/@dwimm/server"

RUN apt-get update && \
    apt-get install -y libexpat-dev python make gcc g++ libc-dev && \
    apt-get clean && \
    adduser --system --disabled-password dwimm && \
    chown -R dwimm:nogroup /usr/local/lib/node_modules && \
    chown -R dwimm:nogroup /usr/local/bin

USER dwimm
WORKDIR "/usr/local/lib/node_modules/@dwimm/server"

RUN cd "/usr/local/lib/node_modules/@dwimm/server" && \
    npm ci && \
    npm i -g @dwimm/client-web@$CLIENT_TAG --no-audit && \
    ln -s "/usr/local/lib/node_modules/@dwimm/server/bin/database" "/usr/local/bin/dwimm-db" && \
    ln -s "/usr/local/lib/node_modules/@dwimm/server/bin/plugin" "/usr/local/bin/dwimm-plugin" && \
    ln -s "/usr/local/lib/node_modules/@dwimm/server/bin/user" "/usr/local/bin/dwimm-user" && \
    ln -s "/usr/local/lib/node_modules/@dwimm/server/server.js" "/usr/local/bin/dwimm-server"

CMD dwimm-server