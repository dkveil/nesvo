FROM node:24.20.0-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server systemd \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
    && passwd -d node \
    && ln -sf /usr/local/bin/node /usr/bin/node \
    && mkdir -p /workspace /var/lib/nesvo /run/sshd \
    && touch /smoke-authorized-key.pub

COPY entrypoint.sh /usr/local/bin/nesvo-remote-smoke
RUN chmod 755 /usr/local/bin/nesvo-remote-smoke

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/nesvo-remote-smoke"]
