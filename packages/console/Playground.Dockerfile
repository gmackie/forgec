FROM node:24-slim
WORKDIR /app
COPY packages/console/generated/playground/server.mjs ./server.mjs
COPY packages/console/generated/playground/app.json ./app.json
ENV BUNDLE_PATH=/app/app.json
USER node
EXPOSE 8080
CMD ["node","server.mjs"]
