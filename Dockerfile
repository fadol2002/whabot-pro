FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY . .
EXPOSE 4000
ENV PORT=4000
CMD ["node", "server.js"]
