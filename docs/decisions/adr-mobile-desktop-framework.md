# ADR: 移动端与桌面端框架选择

- **状态**：已采纳
- **日期**：2026-03-08
- **决策者**：团队

## 背景

CoClaw 前端（`ui`）是基于 Vue 3 + Vite + Nuxt UI 4 的 SPA，采用移动端优先设计。需要将其包装为 Android/iOS App 以及 Windows/macOS 桌面应用。

选型要求：框架稳定可靠、久经考验、社区口碑良好、仍在积极更新。

## 决策

### 移动端（Android + iOS）：Capacitor

- **原理**：将现有 SPA 打包到原生 WebView 中运行，通过插件桥接调用原生能力
- **与项目契合度**：专为"已有 Web 应用 → 原生 App"场景设计，对 Vue 3 + Vite 开箱即用
- **成熟度**：Ionic 团队维护，2019 年发布 v1，当前 v6+，npm 周下载量百万级
- **社区**：活跃，GitHub 12k+ stars，文档完善，插件生态丰富（相机、推送、文件系统等）
- **迁移成本**：极低，几乎不需要改动现有前端代码

### 桌面端（Windows + macOS）：Tauri v2

- **原理**：Rust 后端 + 系统原生 WebView（Windows 用 WebView2，macOS 用 WKWebView），不捆绑 Chromium
- **与项目契合度**：原生支持 Vite 前端，集成简单
- **成熟度**：v2 于 2024 年 10 月正式发布，GitHub 90k+ stars，CrabNebula 公司全职维护
- **体积优势**：安装包通常 5-15 MB（Electron 同类应用 80-150 MB）
- **社区**：非常活跃，更新频繁

### 整体架构

| 平台 | 框架 | 改动量 |
|------|------|--------|
| Android / iOS | Capacitor | 几乎零改动，加壳打包 |
| Windows / macOS | Tauri v2 | 少量配置，前端代码共用 |

两个框架都直接消费 `vite build` 的产物，前端代码完全共用。

## 排除的方案

| 方案 | 排除原因 |
|------|----------|
| Cordova | 已进入维护模式，社区萎缩，Capacitor 是其精神继承者 |
| Tauri v2 Mobile | 移动端支持 2024 年才正式发布，生态和踩坑经验远不如 Capacitor |
| React Native / Flutter | 需要重写 UI 层，不适合已有 Vue SPA |
| Electron | 捆绑完整 Chromium，包体积大（80-150 MB）、内存占用高，CoClaw 不需要其底层浏览器定制能力 |
