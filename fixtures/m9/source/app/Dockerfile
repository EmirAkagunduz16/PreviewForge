FROM node:22.12.0-alpine3.22

WORKDIR /app
COPY server.mjs ./server.mjs

USER 10001:10001
EXPOSE 8080
CMD ["node", "server.mjs"]
