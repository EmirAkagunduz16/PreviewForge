FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./server.mjs

USER 10001:10001
EXPOSE 8080
CMD ["node", "server.mjs"]
