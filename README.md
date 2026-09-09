# Mimi 语音教练

Mimi 用于学生英语练习，以及教师手机触发的课堂大屏反馈。当前发布入口是 `hermes-volc-standalone/server.mjs`：Node.js 22+，无需安装 npm 依赖。

[部署指南](./DEPLOY.md) · [简短操作说明（PDF）](./Mimi操作说明_0909.01.pdf)

## 启动

```bash
git clone https://github.com/Cr-GH0/4f7e58cb4b3dac247de1b8e6e68c1e94.git mimi
cd mimi/hermes-volc-standalone
node server.mjs
```

默认地址为 `http://localhost:3000`，也可执行 `npm start`。配置文件 `.env.local` 已随仓库提供。公开访问时将 Node 服务接到 HTTPS 反向代理后；端口、持久数据和更新方法见部署指南。

## 当前功能

- 学生：注册得到四位账号；直接输入英文，或用手机输入法把语音转成文字。停顿后自动发送，Mimi 用声音回应。会话和提纲保存在当前浏览器。
- 教师：电脑与手机使用教师账号 `sunyumeng`。电脑显示动态头像待机；手机新会话的第一条消息发起本轮总结。
- 大屏：报告占满窗口，头像移到角落并保持动效；Mimi 连续讲解，结束后保留报告。大屏没有聊天栏或台词字幕。
- 声音：新演示自动生成英文讲解、合成音频并播放；同一演示刷新保留讲解与播放位置。教师不需要手动合成声音或逐段点击。
- 后台：`/admin` 可调整模型、声音和自动发送停顿时长；管理密码由现有运行配置提供。

课堂大屏使用约定课堂情境和两个案例，不读取二十名学生的真实聊天作统计。HTML 内容固定为当前确认的报告；每轮讲解由模型重新组织措辞。这是演示通道的现有范围。

## 内容与实现

| 文件 | 用途 |
| --- | --- |
| `hermes-volc-standalone/public/practice-report.html` | 应用实际展示的报告 |
| [呈现页样张_0909.01.html](./呈现页样张_0909.01.html) | 与运行报告一致的独立副本 |
| `hermes-volc-standalone/show-narration-prompt.md` | 动态讲解的角色、内容关系和输出要求 |
| `hermes-volc-standalone/show-content.json` | 同步的报告数据、声音选项和入口配置 |
| `hermes-volc-standalone/public/classroom-display.js` | 大屏状态、报告与连续播放流程 |
| `hermes-volc-standalone/public/show-audio.js` | 音频加载、解码、播放和音量反馈 |
| [呈现产物与旁白提示词.md](./呈现产物与旁白提示词.md) | 内容维护说明 |

修改报告时同步 HTML、独立副本和内容 JSON；改变讲解范围时同步提示词。保持 `narrationMode: "dynamic"` 和空的 `narration` 数组。无需预先生成或提交 `show-audio/`。

`呈现页样张.html` 为早期样张；`worker.js` 和 `wrangler.toml` 为其他运行方式的存留文件，本次完整课堂大屏以 Node 入口为准。

## 检查

在项目指定备份副本中执行自动回归：

```bash
node --test probe-show-playback.mjs probe-show-narration.mjs
```

已启动的服务可执行只读检查：

```bash
node probe-show.mjs http://localhost:3000
```

该检查访问页面、资源和接口，不创建账号、不发起演示、不调用收费模型或语音服务。文件与接口检查不代替真实设备的外放试听。
