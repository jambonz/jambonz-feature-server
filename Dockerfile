FROM node:alpine as builder
RUN apk update && apk add --no-cache python make g++
WORKDIR /opt/app/
COPY package.json ./
RUN npm install
RUN npm prune

FROM node:alpine as app
WORKDIR /opt/app
COPY . /opt/app
COPY --from=builder /opt/app/node_modules ./node_modules

ARG NODE_ENV
ENV NODE_ENV $NODE_ENV

CMD [ "npm", "start" ]
