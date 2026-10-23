# 开发接续入口

稳定版本为 **0.5.1**。正式仓库：[CaiKerman/Evernear](https://github.com/CaiKerman/Evernear)，集成分支 `feature/taskbar-quick-input`，`main` 保留稳定基线。

先读 [PROJECT.md](PROJECT.md) 与 [AGENTS.md](AGENTS.md)。本轮M1 文字闭环与 M2 局部上下文已实现并通过本地验证，新增/回归测试 120 项通过；详细改动、桌面验证、待验收项与下一步见 [QUICK_INPUT_STATUS.md](QUICK_INPUT_STATUS.md)。持续语音 V0—V6 与快捷栏 M3 音频能力尚未实现。

没有新 Windows 运行包，未执行 Windows 实机或 Defender 扫描。原 QA 中的包哈希只属于历史交付。个人目录和构建产物继续排除，不加入源码仓库。
