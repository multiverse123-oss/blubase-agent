FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

COPY . .

RUN chmod +x /app/pocketbase || true
RUN mkdir -p /app/pb_instances /app/data

EXPOSE 10000

CMD ["node", "src/index.js"]
