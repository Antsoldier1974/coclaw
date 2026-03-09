# CoClaw Documentation

## Architecture

Core design documents describing the system's structure and protocols.

- [Architecture Overview](architecture/overview.md) - Component view, API map, binding/unbind sequences, invariants
- [Bot Binding & Auth](architecture/bot-binding-and-auth.md) - Binding flow, token-based auth, data models
- [Gateway Agent RPC Protocol](architecture/gateway-agent-rpc-protocol.md) - Two-phase response protocol specification

## Decisions (ADR)

Architecture Decision Records capturing key design choices.

- [Bot Online Status](decisions/bot-online-status.md) - Bot status sensing and display approaches
- [Media Attachment Support](decisions/media-attachment-support.md) - File attachment support gap analysis
- [Plugin Consolidation](decisions/plugin-consolidation.md) - Merger of tunnel + session-manager into single plugin
- [Session Navigation](decisions/session-navigation.md) - Session navigation design options and recommendation

## Operations

Deployment, configuration, and operational guides.

- [Deploy Operations](operations/deploy-ops.md) - Internal deployment runbook
- [Deployment Plan](operations/deployment-plan.md) - Docker Compose topology, TLS/Nginx, env strategy
- [Nginx Config References](operations/nginx-conf-refs/) - Reference Nginx configurations

## OpenClaw Research

OpenClaw 平台机制研究与 CoClaw 集成经验。

- [核心架构与 Session 机制](openclaw-research/core-architecture.md) - 三层模型、Channel 插件、Session Key/ID/dmScope、Gateway 架构
- [Gateway 通信协议与交互机制](openclaw-research/gateway-protocols.md) - RPC 协议（chat.send vs agent）、队列/流式、Transcript 格式、附件处理
- [集成要点与已知限制](openclaw-research/integration-notes.md) - 主会话 bootstrap、orphan 续聊、session 滚动检测、附件/vision 限制
