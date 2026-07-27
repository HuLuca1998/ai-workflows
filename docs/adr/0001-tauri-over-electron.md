# ADR-0001：桌面壳用 Tauri 2，不用 Electron / 纯 SwiftUI

- 状态：已采纳
- 日期：2026-07-27

## 背景

产品是本地优先的常驻工具：用户会让它挂着等审批数小时。同时要求同一套业务界面
既能做 macOS App，也能做 Web。

## 决策

桌面壳用 **Tauri 2**（Rust + WKWebView），业务界面用 React，两种形态共用。

## 理由

- 常驻内存约为 Electron 的三分之一，包体约 15 MB。对一个整天开着的工具，这是每天都在兑现的收益
- 路径守卫、子进程隔离、Keychain 访问可以直接用 Rust 写在壳里，不必跨语言绕一圈
- 纯 SwiftUI 方案下画布要写两套（macOS 一套、Web 一套），维护成本翻倍

## 代价

- WKWebView 与 Chromium 有行为差异，画布与虚拟化必须在两端各跑一次基准
- Node 生态的能力（ACP adapter）要以 sidecar 子进程引入，不能直接 require

## 备选

- **Electron**：生态最省事，但内存与包体不可接受
- **纯 SwiftUI**：原生体验最好，但放弃 Web 形态，或者画布写两遍
- **折中方案（已采纳的部分）**：壳与系统集成（通知、快捷指令、菜单栏）用原生 API，业务界面共用 React
