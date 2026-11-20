export function renderLoginPage(params: {
  loginId: string;
  role: string;
  status: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>绑定微信 · 家庭 AI</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #18323a;
        --muted: #657b80;
        --line: #dbe5e2;
        --paper: #f4f7f5;
        --teal: #0f766e;
        --teal-soft: #e3f1ed;
      }
      * { box-sizing: border-box; }
      body {
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        min-height: 100vh;
        padding: 28px 18px;
        background: var(--paper);
        color: var(--ink);
        display: grid;
        place-items: center;
      }
      .wrap {
        width: min(100%, 520px);
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 30px;
        box-shadow: 0 18px 48px rgba(24, 50, 58, .09);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 11px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 700;
        letter-spacing: .03em;
        text-transform: uppercase;
      }
      .brand-mark {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        border-radius: 10px;
        background: #173a43;
        color: #b8f0dd;
        font-size: 16px;
        font-weight: 800;
      }
      h1 {
        margin: 24px 0 8px;
        font-size: 27px;
        letter-spacing: 0;
      }
      .lead {
        color: var(--muted);
        margin: 0 0 22px;
        line-height: 1.65;
      }
      p {
        line-height: 1.6;
        margin: 8px 0;
      }
      .meta {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin: 20px 0;
      }
      .meta-item {
        padding: 12px 13px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #f7faf8;
      }
      .meta-label {
        display: block;
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .05em;
        margin-bottom: 4px;
        text-transform: uppercase;
      }
      .status {
        color: var(--teal);
        font-weight: 750;
      }
      .qr-frame {
        display: grid;
        place-items: center;
        min-height: 330px;
        padding: 18px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: #fbfdfc;
      }
      img {
        display: block;
        width: 292px;
        max-width: 100%;
        margin: 0 auto;
        border: 8px solid #fff;
        border-radius: 12px;
        background: #fff;
        box-shadow: 0 10px 24px rgba(24, 50, 58, .10);
      }
      code {
        font-size: 13px;
        color: #355860;
        background: var(--teal-soft);
        padding: 2px 6px;
        border-radius: 5px;
        word-break: break-all;
      }
      .hint {
        margin-top: 18px;
        color: var(--muted);
        font-size: 13px;
        text-align: center;
      }
      .security {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 22px;
        padding-top: 16px;
        border-top: 1px solid var(--line);
        color: var(--muted);
        font-size: 12px;
      }
      @media (max-width: 520px) {
        body { padding: 14px; place-items: start center; }
        .wrap { padding: 22px 18px; margin-top: 3vh; }
        h1 { font-size: 24px; }
        .meta { grid-template-columns: 1fr; }
        .qr-frame { min-height: 280px; }
        img { width: 250px; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="brand"><span class="brand-mark">B</span><span>Baotuo AI Family</span></div>
      <h1>绑定微信账号</h1>
      <p class="lead">使用微信扫描下方二维码，完成账号接入。此页面会自动更新登录状态。</p>
      <div class="meta">
        <div class="meta-item"><span class="meta-label">登录任务</span><code>${params.loginId}</code></div>
        <div class="meta-item"><span class="meta-label">账号角色</span><span id="role">${params.role}</span></div>
      </div>
      <div class="qr-frame"><img id="qrcode" src="/api/logins/${encodeURIComponent(params.loginId)}/qrcode.png?ts=${Date.now()}" alt="微信登录二维码" /></div>
      <p class="hint" id="hint">二维码有效期内请完成扫码，页面每 3 秒检查一次。</p>
      <div class="security"><span aria-hidden="true">●</span><span>登录状态仅用于当前绑定任务，不会在此页面保存凭据。</span></div>
    </div>
    <script>
      const loginId = ${JSON.stringify(params.loginId)};
      const statusEl = document.getElementById("status");
      const hintEl = document.getElementById("hint");
      const imageEl = document.getElementById("qrcode");

      async function refreshStatus() {
        try {
          const response = await fetch("/api/logins/" + encodeURIComponent(loginId), { cache: "no-store" });
          const payload = await response.json();
          const login = payload.login || {};
          statusEl.textContent = login.status || "unknown";
          if (login.error) {
            hintEl.textContent = login.error;
          }
          if (login.status === "waiting" || login.status === "scanned") {
            imageEl.src = "/api/logins/" + encodeURIComponent(loginId) + "/qrcode.png?ts=" + Date.now();
          }
          if (login.status === "confirmed") {
            hintEl.textContent = "登录成功，可以回到终端继续下一步。";
          }
        } catch (error) {
          hintEl.textContent = "状态刷新失败，请稍后手动刷新页面。";
        }
      }

      setInterval(refreshStatus, 3000);
      refreshStatus();
    </script>
  </body>
</html>`;
}
