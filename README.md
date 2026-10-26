# Evernear · 伴语 0.6.0-dev

个人便携助手：基础语音值守和首答，高级语音接管连续交流，文字模型后台分析。另有快捷输入栏，可翻译、追问、主动录入及手动播放。

这是开发源码，稳定基线为 0.5.1。完整设计和状态见 [PROJECT.md](PROJECT.md)、[CURRENT_STATUS.md](CURRENT_STATUS.md)、[验收映射](docs/acceptance.md)，修改约束见 [AGENTS.md](AGENTS.md)。

## 使用

Windows 便携包解压后运行 VoiceAssistant.exe。退出旧程序后升级，保留程序旁的 personal/；分享时排除 personal/。不能用旧版补丁哈希证明当前包通过安全检查。

基础语音填写地址、密钥、模型及音色后开始倾听；高级语音与文字按需配置。高级接管后麦克风只上传高级，结束后恢复基础；全局暂停会停止全部听说并取消进行中的语音分析。隐藏/最小化不会暂停。

快捷输入栏从主窗口或托盘开启，右键进入设置。仅填写文字接口并保存也可使用，不必启用语音或自动委托文字。上下文默认关闭，与主会话隔离。回车发送，Shift+Enter 换行；支持取消、复制、三种预设与参数 JSON，错误直接显示。

“录入”只转写，结束后可编辑再发送，当前仅支持千问内置输入转写；其固定 ASR 子能力可能单独计费。录音期间暂挂当前语音上传，不自动回答或发送。播放只在点击后调用基础语音，复用已有 PCM；忙时提示，不叠音、不串主历史。详见 [快捷栏状态](QUICK_INPUT_STATUS.md)。

## 开发与验证

```bash
npm ci
npm test
npm start
npm run package:win
```

Node.js 22+。桌面模拟另需 Playwright：

```bash
node scripts/smoke-quick-input.mjs
node scripts/smoke-electron.mjs
node scripts/smoke-voice-matrix.mjs
```

PR 工作流包含 Windows 测试、便携构建、哈希和 Defender 检查；对应产物在 Actions。Defender 不可用会明确写未验证，不冒充通过。

本地测试使用 Linux、模拟接口与假麦克风。Windows 任务栏/输入法/声卡、真实云端语义与费用、长期运行均未验证。四厂商实现差异和额外会话开销见 [协议能力](docs/voice-capabilities.md)。
