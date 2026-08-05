FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# Mount a volume at /data in the cloud; set DATA_DIR=/data to persist.
ENV DATA_DIR=/data
RUN mkdir -p /data
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "require('http').get('http://localhost:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" || exit 1
EXPOSE 3000
CMD ["node", "server.js"]
