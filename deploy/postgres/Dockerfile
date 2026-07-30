# syntax=docker/dockerfile:1.7

ARG PG_MAJOR=17
ARG AGE_COMMIT=e1467f12e0b1d15dd35d3ab93f057a7112d425b8

FROM postgres:${PG_MAJOR}-bookworm AS age-builder

ARG PG_MAJOR
ARG AGE_COMMIT

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bison \
      build-essential \
      flex \
      postgresql-server-dev-${PG_MAJOR} \
    && rm -rf /var/lib/apt/lists/*

ADD https://github.com/apache/age.git#${AGE_COMMIT} /tmp/age

RUN make -C /tmp/age PG_CONFIG=/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config \
    && make -C /tmp/age PG_CONFIG=/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config install

FROM pgvector/pgvector:0.8.5-pg17-bookworm

ARG PG_MAJOR

COPY --from=age-builder /usr/lib/postgresql/${PG_MAJOR}/lib/age.so /usr/lib/postgresql/${PG_MAJOR}/lib/
COPY --from=age-builder /usr/share/postgresql/${PG_MAJOR}/extension/age* /usr/share/postgresql/${PG_MAJOR}/extension/

CMD ["postgres", "-c", "shared_preload_libraries=age"]
