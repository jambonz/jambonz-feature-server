FROM --platform=linux/amd64 node:24-alpine AS base

RUN apk --update --no-cache add --virtual .builds-deps build-base python3

WORKDIR /opt/app/

FROM base AS build

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

FROM base

COPY --from=build /opt/app /opt/app/

ARG NODE_ENV

ENV NODE_ENV=$NODE_ENV

CMD [ "node", "app.js" ]
