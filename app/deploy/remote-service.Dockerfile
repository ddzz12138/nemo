# Hosted control plane only. This image contains no desktop assets, chats or model keys.
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NEMO_REMOTE_BIND=0.0.0.0 \
    NEMO_REMOTE_PORT=8790 \
    NEMO_REMOTE_DATA_FILE=/var/lib/nemo-remote/state.json
WORKDIR /app
COPY --chown=node:node remote-service.mjs ./
COPY --chown=node:node lib/remote-cloud-auth.mjs lib/remote-cloud-provider.mjs lib/remote-cloud-service.mjs lib/remote-cloud-store.mjs ./lib/
RUN mkdir -p /var/lib/nemo-remote && chown node:node /var/lib/nemo-remote && chmod 700 /var/lib/nemo-remote
USER node
EXPOSE 8790
VOLUME ["/var/lib/nemo-remote"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.NEMO_REMOTE_PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "remote-service.mjs"]
