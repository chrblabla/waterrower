FROM node:22

WORKDIR /app

RUN npm i npm

COPY package* ./

RUN npm ci

COPY . ./

CMD npm start
