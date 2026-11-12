# The team server: hub + web app. The desktop app is not part of this image.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY server ./server
COPY web ./web
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/index.js"]
