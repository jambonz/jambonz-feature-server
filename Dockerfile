FROM node:17.9-slim
WORKDIR /opt/app/
COPY package.json package-lock.json ./
RUN npm ci
RUN npm prune
COPY . /opt/app
ARG NODE_ENV
ENV NODE_ENV $NODE_ENV

CMD [ "npm", "start" ]
