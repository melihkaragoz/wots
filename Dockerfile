FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY db ./db
COPY routes ./routes
COPY middleware ./middleware
COPY game ./game
COPY admin ./admin
COPY snake ./snake

EXPOSE 3000

CMD ["node", "server.js"]
