# 开发接续入口

当前开发版本 **0.6.0-dev**，稳定基线仍为 `main` 的 0.5.1。本轮将已有 M1/M2 提交与持续语音、M3 音频整合为一个 PR，目标分支 `feature/taskbar-quick-input`。

先读 [PROJECT.md](PROJECT.md)、[AGENTS.md](AGENTS.md)，完整设计见 [VOICE_SCHEDULING_PLAN.md](VOICE_SCHEDULING_PLAN.md) 和 [TASKBAR_QUICK_INPUT_PLAN.md](TASKBAR_QUICK_INPUT_PLAN.md)。[协议与最小支持路径](docs/voice-capabilities.md)、[验收映射](docs/acceptance.md)、[快捷栏状态](QUICK_INPUT_STATUS.md)、[QA.json](QA.json) 区分实现、本地验证和未验证项。

已实现基础首答并行待命、高级原生麦克风接收/回交、任务继承与当前语音交付、隔离转写及手动播音。源码本地验证完成；Windows 实际声卡/任务栏、真实云端语义与费用、全天运行、便携包和 Defender 结果须以实测证据为准。Windows CI 构建/扫描记录将随构建产物输出；未执行不算通过。

远程 CI 追加证据：代码提交 `976a504` 的 Linux/Windows 各 135 项测试、Linux 桌面和 Windows 便携构建/Defender 扫描通过，未发现威胁。运行及下载地址见 docs/acceptance.md；真实用户 Windows 桌面/声卡与云端验证仍待完成。

2026-10-27 PR #3 审核修正：已修复终态任务在交接时重算、文字不可用时高级后续 delegate 无回答、结束后失败提示越权播音。新增 15 项回归，本地 150 项及 8/8/4 组桌面检查通过；本轮 Windows CI 随提交重新运行，原 135 项/扫描记录保留其旧提交范围。
