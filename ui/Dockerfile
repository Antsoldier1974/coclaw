# UI 静态文件镜像
# 使用前须先在本地执行 pnpm --filter @coclaw/ui build
FROM busybox:stable
# OCI labels：写入单架构 image config，供 docker inspect 等读取
# 多架构构建时 GHCR 需要 manifest index 级 annotations 才能自动关联仓库，
# 由 build-ui.sh 的 --annotation 参数补充，两处需保持一致
LABEL org.opencontainers.image.source="https://github.com/coclaw/coclaw"
LABEL org.opencontainers.image.description="CoClaw UI"
LABEL org.opencontainers.image.licenses="SEE LICENSE IN LICENSE"
WORKDIR /dist
COPY ui/dist/ .
