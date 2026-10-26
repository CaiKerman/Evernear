# 本轮整合开发状态

目标：按持续语音与快捷栏计划，在一个 PR 中交付剩余实现并复用原 M1/M2 提交。目标分支 feature/taskbar-quick-input，稳定 main 保留 0.5.1。

已完成：基础首答/高级待命并行，高级原生接收和回交，版本/迟到/暂停清理，任务继承/修订合并/取消待交付结果/当前语音交付，隔离转写、手动播音与缓存，使用说明、验收映射、Windows 构建和扫描流程。没有新增运行依赖或第四个配置槽位。

最终本地证据：135 项单元/协议测试，8 组快捷桌面、8 组核心语音桌面、四组厂商桌面接管通过，页面错误 0；Windows x64 交叉构建成功。都是 Linux、本地接口、假麦克风，不是 Windows/真实云端验收。

已提交整合 PR #3： https://github.com/CaiKerman/Evernear/pull/3 。远程 CI 已对 976a504 完成 Linux/Windows 各 135 项测试、Linux 桌面以及 Windows 原生构建/Defender 扫描（未发现威胁）。当前接续：基于 docs/acceptance.md 继续 Windows 交互、真实云端/声卡、30 分钟混合和 2 小时值守、目标电脑实际使用检查。缺少这些证据，V5/V6、M0/M4 的整体验收保持未完成。详见 CURRENT_STATUS.md、QA.json。
