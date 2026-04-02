FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    iproute2 \
    iputils-ping \
    lldpd \
    procps \
    snmp \
    snmpd \
  && rm -rf /var/lib/apt/lists/*

COPY node-entrypoint.sh /usr/local/bin/node-entrypoint.sh
RUN chmod +x /usr/local/bin/node-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/node-entrypoint.sh"]
