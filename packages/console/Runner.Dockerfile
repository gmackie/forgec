FROM node:22-slim
WORKDIR /app
COPY packages/console/dist/runner.mjs ./runner.mjs
EXPOSE 8790
CMD ["node","runner.mjs"]
