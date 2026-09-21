FROM node:22-slim
RUN npm install -g wrangler@4.135.0
ENV WRANGLER_SEND_METRICS=false CI=true
WORKDIR /app
COPY packages/console/dist/runner.mjs ./runner.mjs
EXPOSE 8790
CMD ["node","runner.mjs"]
