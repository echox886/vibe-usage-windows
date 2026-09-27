# macOS ↔ Windows 对齐说明 (Parity Notes)

本项目以 `vibe-usage-app`（macOS, SwiftUI, v0.6.1）为功能与视觉基准。本文档记录 1:1 对齐的映射关系与少数平台差异。

## 视觉常量（源自 Swift 源码，落在 `tailwind.config.cjs`）

| Token | 值 | Swift 来源 |
|---|---|---|
| 面板尺寸 | 520×620，圆角 12 | `MenuBarController.panelWidth/Height`, contentView cornerRadius |
| 背景 | `#0A0A0A` | `Color(white: 0.04)` |
| 卡片 | bg `#171717` / 边框 `#292929` / 圆角 4 | `Color(white: 0.09/0.16)` |
| 文字 | `#FFFFFF` / `#A1A1A1` / `#616161` / `#808080` | `.white`, `white: 0.63/0.38/0.5` |
| 费用绿 | `#33CC80` | `(0.2, 0.8, 0.5)` |
| 活跃蓝 | `#6199FF` | `(0.38, 0.6, 1.0)` |
| 更新链接蓝 | `#66B3FF` | `(0.4, 0.7, 1.0)` |
| 清除红 | `#FF6B6B` | `(1.0, 0.42, 0.42)` |
| 配额条三段色 | `#D9D9D9` / `#F59E0B` / `#F04545`（<70 / 70–90 / ≥90） | `ProgressBar.color(for:)` |
| Donut 色板 | `#3B82F6 #0FBA83 #F59E0B #F04545 #8C5CF5 #ED4D99`，其他 `#525252` | `DistributionChartsView` |
| 开启动画 | 220ms `cubic-bezier(0.22,1,0.36,1)`，scale 0.9→1 + y4 + 70% 淡入 | `animateOpen` |
| 关闭动画 | 140ms `cubic-bezier(0.5,0,0.9,0.4)`，scale→0.94 | `animateClose` |

聚合口径（`src/lib/aggregate.ts` ↔ Swift 各 View 的 filtered/chartData）：

- 总 Token = input + output + reasoning + cachedInput（`computedTotal`）
- 趋势图 Token 三段堆叠：output+reasoning（白 0.9）/ input（白 0.5）/ cached（白 0.24）
- 模型筛选**不作用于 sessions**（活跃时长）— macOS 既有行为，保持一致
- 「今天」与「24H」同拉 `days=1`，仅客户端 midnight cutoff 不同（菜单栏/托盘统计同样应用 cutoff）
- Donut Top6 + 其他；空维度值显示「未知」

## 组件映射

| macOS (Swift) | Windows (React/Rust) |
|---|---|
| `PopoverView` | `PopoverApp` + `DashboardView` |
| `RateLimitCardView` | `components/RateLimitCard.tsx` |
| `FilterTagsView` | `components/FilterTags.tsx` |
| `SummaryCardsView` | `components/SummaryCards.tsx` |
| `BarChartView` | `components/TrendChart.tsx`（自绘 div 堆叠条） |
| `DistributionChartsView` | `components/DistributionGrid.tsx`（自绘 SVG donut） |
| 长名字 `.truncationMode(.middle)` + `.help()`（分布图例/筛选选项，同前缀项目名区分信息在尾部） | `components/MiddleTruncateLabel.tsx`（head 截断 + tail 6 字符不收缩 + `title` 悬浮全名） |
| `SettingsView` (NSWindow 460×480) | `SettingsApp`（独立 WebView 窗口 460×620，信息架构 1:1：数据同步 → 订阅配额 → 常规 → 数据目录（高级）→ 测试诊断 → 关于 → 危险操作） |
| `SettingsView.zCodeRow` / `compactQuotaStatus`（收起显示「待配置/已配置」，展开才是区域 + Key 表单） | `SettingsApp` 的 ZCode 行 + `lib/quotaProducts.ts:compactQuotaStatus` |
| `AppState` | `state/AppStateContext.tsx` + Rust `AppCtx` |
| `APIClient` | `services/api_client.rs` |
| `SyncEngine`（npx/bun x，120s） | `services/sync_engine.rs`（内置 CLI + node，120s，CREATE_NO_WINDOW） |
| 设置中的隔离运行时目录（Codex / Grok / Antigravity） | 原生文件夹选择器 + 同一组 CLI `config roots/add-root/remove-root` 命令 |
| `SyncScheduler`（30 分钟） | `services/scheduler.rs` |
| 七产品订阅配额目录与任意数量选择 | Codex / Claude 原生适配；Kimi / ZCode / Grok / OpenCode Go 使用版本化 typed CLI bridge（OpenCode Go 的凭据读取由内置 CLI 负责：2.x 凭据表 → 1.x `auth.json` 回退）；Cursor 独立显示待接入 |
| `RateLimitCardView`：`QuotaTabStripView`（整目录图标 Tab：已生效彩色在前、未生效置灰在后、可拖动排序、最右齿轮进设置、已启用但非 ok 加琥珀点）+ 一行两张 240px 卡片横滑，Tab 与横滑双向联动（点 Tab 滑过去、滑动时高亮跟随前缘卡片）；卡片只属于已启用产品，全部关闭时只剩图标行 | `components/RateLimitCard.tsx` + `components/QuotaTabStrip.tsx`：同一模型（HTML5 拖放排序、前缘卡片经滚动位置判定、`quotaTabOrder` 顺序与 `quotaProductOrder` 持久化、齿轮调 `open_settings_window`） |
| `RateLimitCardView.emptyStateText(for:isDetected:)` / `ProviderRateLimit.EmptyReason` | `lib/quotaProducts.ts:quotaEmptyStateText` + Rust `RateLimitEmptyReason`（`crates/core/src/rate_limit/mod.rs`） |
| `RateLimitCardView.ProviderIcon`（官方 28/56px 资产，卡片与设置共用） | `components/ProviderIcon.tsx`（`src/assets/*-icon.png` 为官方资产 @2x=56px，卡片 14px 显示）+ 符号兜底 |
| ZCode 两区域 Key | BigModel / Z.ai 分开存入 Windows Credential Manager；只向明确选择的区域请求注入 |
| `RuntimeDetector` | `crates/core/runtime.rs`（Windows 路径 + 捆绑 node 兜底） |
| `CodexRateLimitReader` | `crates/core/rate_limit/codex.rs` |
| `ClaudeRateLimitReader` | `crates/core/rate_limit/claude.rs` |
| 旧 `StatuslineHook` | `crates/core/statusline_hook.rs` 仅用于安全退休本应用可证明归属的旧 hook |
| `MenuBarController`（NSStatusItem + NSPanel） | `tray.rs` + `panel.rs`（托盘 + 标准主窗口） |
| Sparkle | `services/updater.rs`（latest.json + SHA-256 + NSIS） |
| `SMAppService`（登录项） | `auto-launch` crate（HKCU Run 注册表键） |

## 平台差异（有意为之）

1. **托盘文本**：macOS 菜单栏支持图标旁文字；Windows 托盘不支持。Windows 始终使用高对比 32×32 图标，开启「显示费用/Token」时完整数值显示在托盘悬停提示中，避免小尺寸任务栏图标变得不可读。
2. **「在 Dock 中显示」**：Windows 无 Dock，省略此设置项。托盘右键菜单提供「打开面板/立即同步/设置/退出」（Windows 惯例，macOS 无右键菜单，属增强）。
3. **运行时**：macOS 版要求用户自装 Node/Bun 并用 `npx --yes` 每次联网解析；Windows 版捆绑打过补丁的 CLI 与 Node 22 运行时，离线可同步、版本可控（检测顺序：捆绑 node → 系统 node ≥22.5 → 系统 node ≥20 → bun）。
4. **Claude 配额**：使用受限的只读官方 CLI 探测，不安装 statusline；启动时只退休旧版本可证明归属的包装器。
5. **自更新**：Sparkle → 自研（GitHub Releases latest.json、SHA-256 校验、启动 NSIS 安装器）。UI 入口一致（footer「发现更新」+ 设置「检查更新」）。
6. **面板关闭按钮**：macOS footer「关闭」= 退出应用（`NSApplication.terminate`）；Windows 同义（退出到无进程）。托盘常驻由开机自启保证。
7. **配额悬停 tooltip**：交互与内容 1:1；Windows 使用 mouse enter/leave（无 NSTrackingArea 差异）。
8. **配额卡片数量**：与 0.6.1 相同，不设上限、不折叠；选择顺序即卡片顺序，多于两张时横向滚动。首次启动勾选全部「已检测且已就绪」的产品（ZCode 未配置 Key 时除外，与 macOS 一致）。
9. **设置页「托盘」分组**：macOS 的「菜单栏」对应 Windows 的「托盘」，两项合并进「常规」，不单列分组。
10. **官方图标资产**：六家图标直接复用 macOS 已验收的官方标准资产（@2x 56px，透明底 + 官方容器），本仓库不改色、不加边框；卡片与设置页共用同一个 `ProviderIcon`。

## CLI Windows 补丁（vendored，见 `scripts/vendor-cli.mjs`）

上游 `@vibe-cafe/vibe-usage@0.11.0`（快照版本以 `package.json` 的 `vibeUsageCliVersion` 为准）的 Windows 问题，vendor 时自动打补丁（补丁锚点丢失会构建失败，防止 CLI 升级后静默失效）：

1. `src/init.js` `openBrowser`：`execFile('start')` → `cmd /c start ""`（`start` 是 cmd 内建命令）
2. `src/parsers/codex.js` `extractProject` 与 `src/parsers/qwen-code.js`：`split('/')` → `split(/[\\/]/)`（Windows cwd 反斜杠）
3. `src/opencode-roots.js` 默认根列表：在 XDG 根之后追加 `%LOCALAPPDATA%\opencode`（0.10.31 起上游把根解析移出 parser，故补丁 rebase 到该文件；语义为追加候选根，XDG 仍排首位）
4. `src/parsers/amp.js`：增加 `%LOCALAPPDATA%\amp\threads` 探测（原 XDG 路径保底）
5. `src/state.js`：`STATE_DIR` 增加 `VIBE_USAGE_CONFIG_DIR` 回退，使 CLI 状态与配置落在同一应用配置目录；`src/config.js` / `src/state.js` 另含 `config.json` / `state.json` 路径被误创建为目录时的 EISDIR 自愈

其中 `VIBE_USAGE_CONFIG_DIR` 的支持程度在两个文件上并不相同：`src/config.js` 的 `CONFIG_DIR` 上游（0.10.31 起，含 0.11.0）已原生读取该变量，而 `src/state.js` 的 `STATE_DIR` 上游只识别 `VIBE_USAGE_STATE_DIR`，故第 5 项的回退仍由本仓库补丁提供，不能因上游版本较新而删除。以上补丁建议同步提交上游 PR；合并后 vendor 脚本的补丁会因锚点变化自动报错提醒移除。

## 共享文件契约（与 CLI / macOS 版一致）

| 文件 | 说明 |
|---|---|
| `%USERPROFILE%\.vibe-usage\config.json` | `apiKey` / `apiUrl` / `hostname`（camelCase，与 CLI 互写） |
| `%USERPROFILE%\.vibe-usage\state.json` | CLI 增量同步状态；「重置配置」时一并删除（修复 macOS/CLI 的 reset 不清 state 问题） |
| `%USERPROFILE%\.vibe-usage\claude-rate-limits.json` | 旧版本缓存，仅作安全回退；新版本不安装 statusline |
| `%USERPROFILE%\.codex\sessions\` | Codex 配额读取（只读） |
| `%APPDATA%\ai.vibecafe.vibe-usage.windows\settings.json` | 应用设置（对应 macOS UserDefaults） |

## 验收清单

见仓库根 `../VIBE-USAGE-WINDOWS-PLAN.md` §11（40+ 项逐条勾验）。
