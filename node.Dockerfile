FROM node:20-alpine

WORKDIR /usr/src/app

# Install ffmpeg and its dependencies
RUN apk add --no-cache ffmpeg

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:node"]
