# Evernear · 伴语 0.5.1

个人便携语音助手：轻量语音常驻判断，高级语音按需回答，文字模型后台推理。只配置这三组模型，数据放在程序旁边的 personal/，没有账号或独立服务。

源码仓库：[CaiKerman/Evernear](https://github.com/CaiKerman/Evernear)。

项目目标、架构、状态及开发接续见 [PROJECT.md](PROJECT.md)，修改约束见 [AGENTS.md](AGENTS.md)，交付验证记录见 [QA.json](QA.json)。

Windows x64 解压后运行 VoiceAssistant.exe。升级前退出旧程序；小补丁只替换 resources/app.asar，保留 personal/。完整包可单独解压，把原 personal/ 复制到新程序旁边。分享时排除 personal/。

先填写轻量语音的接口、密钥、模型和音色，然后开始倾听。高级语音可留空；文字推理按需要填写并启用。两个语音槽位均保留 Qwen、OpenAI Realtime、Gemini Live、Doubao 原生协议。接口握手检查只验证连接与会话配置，实际生成和播放应通过正常对话确认。

## 本轮开发计划（尚未实现）

已确认的新目标：基础语音值守并先响应，同步唤醒高级待命；首答不足时通过摘要交接，高级从实际接管后直接接收原始声音，交流结束再恢复基础。高级文字按需并行，Jev 暂不接入。

- [持续语音开发目标、V0—V6 里程碑与验收](VOICE_SCHEDULING_PLAN.md)
- [快捷输入栏需求与 M0—M4 里程碑](TASKBAR_QUICK_INPUT_PLAN.md)
- 本轮 PR 的 base 指向 feature/taskbar-quick-input；审核后整合。当前代码仍为0.5.1，下列说明与旧QA记录不代表新功能完成。

## 0.5.1 改动

- 复杂推理默认交给一个文字任务；等待时由轻量语音陪聊。高级语音用于主动选择的深入交流，文字未启用时也可独立解答复杂问题。
- 后台结果等当前前台回答生成、实际播放结束后接话；用户说完还在判断是否介入时，结果继续等待。
- 取消会撤下排队结果；补充条件会取消旧任务、合并问题后重新处理，迟到旧结果不播报。
- 修复任务重播误选过渡语、Gemini 错把生成结束上报为用户停说、千问连接取消后的清理，以及重复播放回执覆写已播报状态。
- 任务控制收敛为单个任务槽，移除高级语音额外的固定过渡播报和已不用的旧调度字段；没有增加依赖或设置项。

## 本地文件

config.json 保存三组模型配置与必要设置；memory.md 保存重要事实；instructions.md 保存个人行为偏好。history/ 只有谁、什么时间、说了什么。较早历史可摘录压缩，也可点击一次文字 AI 摘要。session.json 保留未完成任务和播放状态，诊断记录独立放在 logs/ 与 requests/，不加入日常对话历史。

## 开发

Node.js 22 以上，npm ci，npm test，npm start。源码使用 TypeScript 和 Electron，运行依赖没有新增。scripts/smoke-voice-matrix.mjs 是四协议桌面组合检查；scripts/smoke-electron.mjs 是本地服务下的播放及故障检查。

本版的自动化验证使用本地模拟接口与假麦克风。实际云端、Windows 声卡和长时间倾听仍需实机测试；不能将本地通过说成实际云端的 50002 已经消失。
