# Mimi 部署指南

本次部署使用 `hermes-volc-standalone` 的 Node 服务，包含学生练习和教师大屏。需要 Node.js 22+、可持久写入的应用目录，以及公开使用时的 HTTPS 地址。无需 npm 依赖或构建步骤。

## 启动服务

```bash
git clone https://github.com/Cr-GH0/4f7e58cb4b3dac247de1b8e6e68c1e94.git mimi
cd mimi/hermes-volc-standalone
node server.mjs
```

也可执行 `npm start`。默认监听 `3000`，由环境变量 `PORT` 改端口：

```bash
# Linux / macOS
PORT=8080 node server.mjs
```

```powershell
# Windows PowerShell
$env:PORT = '8080'
node server.mjs
```

仓库已提供 `.env.local`，服务启动时自动读取；系统环境变量优先。保留该文件，无需教师录入模型参数。服务要能访问已配置的火山 RTC、方舟模型及语音合成接口。

## HTTPS 与持续运行

将 HTTPS 反向代理指向 Node 端口。以下 Caddy 配置中的域名替换为实际域名：

```caddyfile
mimi.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

反向代理应保留 `Host`，并传递 `X-Forwarded-Proto: https`。教师手机与大屏电脑使用同一个 HTTPS 地址；`localhost` 仅指访问设备本身，不是手机访问另一台电脑的地址。

Linux 可用 systemd 持续运行。以下示例假定项目位于 `/opt/mimi`、Node 位于 `/usr/bin/node`；部署时按实际路径调整：

```ini
[Unit]
Description=Mimi
After=network-online.target

[Service]
WorkingDirectory=/opt/mimi/hermes-volc-standalone
ExecStart=/usr/bin/node server.mjs
Environment=PORT=3000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

将上述内容保存为 `/etc/systemd/system/mimi.service`，执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mimi
```

## 数据保留

同一应用目录由一个 Node 进程运行。以下运行文件不进入 Git，由服务自动创建；更新代码时保留：

- `.mimi-students.json`：账号。
- `.hermes-settings.json`：后台配置（存在时）。
- `.mimi-show-state.json`：演示状态、播放进度和本轮使用的内容。
- `.mimi-show-sources.json`：课堂大屏后台保存的 HTML 产物和 Hermes 提示词（存在时）。
- `show-audio/`：每轮讲解音频。

部署到容器或临时文件系统时，将上述运行文件所在目录放在持久存储中。学生会话内容保存在各自浏览器，换设备不会自动迁移。

## 检查服务

```bash
node probe-show.mjs https://实际部署地址
```

此命令只读检查入口、静态资源、报告、公开配置和登录边界，不创建账号或发起演示。

电脑和教师手机用账号 `sunyumeng` 登录。电脑进入头像待机；教师手机使用微信输入法将总结要求转成文字。课前在电脑页面点击一次，进入待机；收到手机消息后，大屏先播放 Mimi 的英语回应，显示四步准备过程，再打开报告并连续讲解。结束后点击头像返回待机。开始回应前在待机状态备齐报告与语音；开始回应后按同一条时间轴播放 62 秒（5 秒开场、6 秒整理、0.8 秒头像移动、49.2 秒讲解、1 秒收尾）。语音长度在浏览器中保持音高调整，无需额外部署音频工具。若本轮中断，页面提供重试和返回待机。

## 更新内容与代码

默认报告为 `public/practice-report.html`，默认讲解规则为 `show-narration-prompt.md`，数据为 `show-content.json`。教师也可从桌面待机页的“后台”编辑 HTML 和 Hermes 提示词；后台保存的内容优先生效，下一轮请求使用新内容。更改内容后同步独立样张，下一轮新会话使用新内容；不要替换正在播放的本轮内容。

```bash
git pull --ff-only
sudo systemctl restart mimi
```

已有运行数据不随代码更新删除。操作说明见仓库根目录的 [Mimi操作说明_0909.01.pdf](./Mimi操作说明_0909.01.pdf)。
