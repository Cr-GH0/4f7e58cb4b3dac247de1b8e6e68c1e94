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
- 教师：电脑与手机使用教师账号 `sunyumeng`。电脑显示动态头像待机；教师在 iOS Safari 中使用微信输入法将语音转成文字，停顿后发送总结请求。
- 大屏：Mimi 先用英语回应，再显示四步准备过程及俏皮的英文工作状态；随后报告占满窗口，头像飞到右下角并随声音保持动效。Mimi 连续讲解，结束后保留报告；点击头像返回待机。工作状态只显示，不朗读。
- 时长：从大屏开始回应到头像可点击为止固定 62 秒：开场 5 秒、整理已有发现 6 秒、头像移动 0.8 秒、讲解 49.2 秒、收尾 1 秒。页面先在待机状态备齐报告和语音，再由同一条音频时间轴驱动画面；讲解逐轮生成，按时长压缩篇幅并保持音高调整语音长度。
- 声音：新演示自动生成英文讲解、合成音频并播放；同一页面内播放中断可继续；关闭后重新打开、刷新或重新进入桌面时回到待机，等待教师发起新一轮。教师不需要手动合成声音或逐段点击。
- 课堂大屏后台：教师桌面待机时点击左下角“后台”，可导入、编辑和预览 HTML 产物，并修改本部分的 Hermes 提示词。两项一起保存，从下一轮演示生效；当前演示继续使用发起时的内容。
- 模型设置：`/admin` 可调整模型、声音和自动发送停顿时长；管理密码由现有运行配置提供。

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

通过课堂大屏后台修改后，服务使用 `.mimi-show-sources.json` 中保存的 HTML 和提示词；仓库中的原始文件保留。直接维护默认源文件时，修改报告需同步 HTML、独立副本和内容 JSON，改变讲解范围需同步提示词。保持 `narrationMode: "dynamic"` 和空的 `narration` 数组。无需预先生成或提交 `show-audio/`。

`呈现页样张.html` 为早期样张；`worker.js` 和 `wrangler.toml` 为其他运行方式的存留文件，本次完整课堂大屏以 Node 入口为准。

## 检查

在项目指定备份副本中执行自动回归：

```bash
npm test
```

已启动的服务可执行只读检查：

```bash
node probe-show.mjs http://localhost:3000
```

该检查访问页面、资源和接口，不创建账号、不发起演示、不调用收费模型或语音服务。文件与接口检查不代替真实设备的外放试听。
