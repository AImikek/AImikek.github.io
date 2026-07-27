FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY public ./public
COPY data/.gitkeep ./data/.gitkeep

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 8787

CMD ["node", "server.mjs"]
