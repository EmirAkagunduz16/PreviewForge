FROM node:22.12.0-alpine3.22

WORKDIR /app
COPY . ./

# This failure is intentional and belongs only to the M8 disposable fixture.
RUN printf '%s\n' 'intentional M8 fixture build failure' >&2 && exit 42
