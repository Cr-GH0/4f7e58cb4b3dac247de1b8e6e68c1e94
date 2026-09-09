# Mimi 部署指南

## 前提

- Node.js 22 或更高版本（零 npm 依赖，不需要 `npm install`）
- 一个 HTTPS 域名或地址（手机麦克风和 RTC 通话要求安全上下文；`localhost` 例外）

## 一分钟部署

```bash
git clone https://github.com/Cr-GH0/4f7e58cb4b3dac247de1b8e6e68c1e94.git mimi
cd mimi/hermes-volc-standalone
node server.mjs
```

服务启动在 `http://localhost:3000`（改端口：`PORT=8080 node server.mjs`）。

仓库已附 `.env.local`（含火山引擎凭据和管理密码），无需另行配置。如果要在别的机器上运行，确认 `.env.local` 随仓库一起到达即可。

## 生产部署（HTTPS）

Mimi 只是一个普通 Node HTTP 服务，不需要特殊运行时。最简单的生产部署：

```bash
# 服务器上
git clone https://github.com/Cr-GH0/4f7e58cb4b3dac247de1b8e6e68c1e94.git /opt/mimi
cd /opt/mimi/hermes-volc-standalone

# 用 systemd 持续运行
sudo tee /etc/systemd/system/mimi.service << 'EOF'
[Unit]
Description=Mimi voice coach
After=network.target

[Service]
WorkingDirectory=/opt/mimi/hermes-volc-standalone
ExecStart=/usr/bin/node server.mjs
Restart=always
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now mimi
```

然后在前面挂一层 HTTPS 反向代理（Caddy 最简）：

```bash
# Caddyfile
mimi.example.com {
    reverse_proxy localhost:3000
}
```

## 课前准备清单

1. **换演出内容**：编辑 `hermes-volc-standalone/show-content.json`（两个案例、方法论、旁白文案；用 *词* 标改动处）
2. **合成演出语音**：打开 `https://<部署地址>/admin`，登录后点 "Regenerate show audio"
3. **大屏电脑**：浏览器打开部署地址 → 输入 `sunyumeng` 登录 → 宽屏待命
4. **教师手机**：同一地址 → `sunyumeng` 登录 → 新会话 → 说一句话即触发

## 排障

- 学生手机进不了语音：浏览器打开 `https://<部署地址>/diagnose`，逐项自检并复制报告
- 服务器自检：`node probe-show.mjs https://<部署地址>`（30 项检查，含一次真实语音合成）
