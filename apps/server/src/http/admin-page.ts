import { randomBytes } from "node:crypto";

/** Static shell: all server/user values are inserted with textContent by the client. */
export function renderAdminPage(): { html: string; csp: string } {
  const nonce = randomBytes(18).toString('base64');
  return {
    csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>家庭 AI · 管理后台</title>
<style nonce="${nonce}">
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#172b3a;background:#f4f7fa;font-size:15px}*{box-sizing:border-box}body{margin:0}header{background:#102d3a;color:white;padding:22px max(20px,calc((100vw - 1120px)/2));display:flex;justify-content:space-between;align-items:center;gap:20px}h1{font-size:22px;margin:0 0 5px}header p{margin:0;color:#b4ccd5;font-size:13px}main{max-width:1160px;margin:auto;padding:24px 20px 60px}nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}button{font:inherit;cursor:pointer;border:1px solid #b9cbd4;border-radius:8px;background:white;color:#173747;padding:9px 16px}button:hover{border-color:#167d88}button:disabled{opacity:.5;cursor:wait}nav button[aria-selected=true],.primary{background:#146c78;color:white;border-color:#146c78}.card{background:white;border:1px solid #dce5eb;border-radius:12px;padding:22px;margin-bottom:18px;box-shadow:0 3px 12px #102d3a05}h2{font-size:19px;margin:0 0 14px}h3{font-size:16px}p{line-height:1.65}.muted{color:#5a7180;font-size:13px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.stat{background:#f2f7f8;border-radius:8px;padding:16px}.stat strong{display:block;font-size:25px;color:#146c78;margin-top:8px}label{display:block;font-weight:600;margin-bottom:7px}input,select,textarea{width:100%;border:1px solid #bccdd5;background:#fff;border-radius:7px;padding:10px;font:inherit;color:inherit}input:focus,select:focus{outline:2px solid #a1d5dc}small{font-weight:normal}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:18px}.notice{padding:14px 18px;background:#e6f2f3;border-left:4px solid #16818b;border-radius:6px;margin-bottom:18px}.notice.error{background:#fff0ee;border-color:#bb4033}.notice[hidden],[hidden]{display:none!important}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:11px;border-bottom:1px solid #e5edf1;vertical-align:top;word-break:break-word}th{white-space:nowrap;color:#647a86}td button{font-size:12px;padding:6px 10px}pre{white-space:pre-wrap;word-break:break-all;font-size:12px;background:#f4f7fa;padding:16px;border-radius:8px;max-height:420px;overflow:auto}#qr{width:260px;max-width:100%;display:block;margin:18px auto}footer{font-size:12px;color:#6a808c;margin-top:25px}a{color:#126e79}@media(max-width:650px){.grid{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}header{align-items:flex-start}.card{padding:16px}main{padding:16px 12px}button{padding:9px 12px}}
</style><style nonce="${nonce}">
:root{--ink:#18323a;--ink-soft:#5c7076;--paper:#f4f7f5;--surface:#fff;--line:#dbe5e2;--teal:#0f766e;--teal-dark:#0b5d58;--teal-soft:#e3f1ed;--amber:#a86416;--red:#b43c36;--shadow:0 12px 32px rgba(24,50,58,.07)}
body{background:var(--paper);color:var(--ink);min-height:100vh}
header{position:relative;padding:26px max(22px,calc((100vw - 1240px)/2));background:#173a43;border-bottom:1px solid #2c545b;box-shadow:0 8px 24px rgba(24,50,58,.14)}
header:after{content:"";position:absolute;inset:auto 0 0;height:3px;background:#4bb79d}
header>div{display:flex;align-items:center;gap:14px}header>div:before{content:"B";display:grid;place-items:center;width:40px;height:40px;border:1px solid rgba(255,255,255,.28);border-radius:12px;background:#23525a;color:#b8f0dd;font-weight:800;font-size:19px;letter-spacing:0}.header-actions{display:flex;align-items:center;gap:8px}
h1{font-size:21px;letter-spacing:0;margin:0 0 4px}header p{color:#b8d2d0}
header button{border-color:rgba(255,255,255,.26);background:rgba(255,255,255,.1);color:#fff}header button:hover{border-color:#9be1ce;background:rgba(255,255,255,.16)}
main{max-width:1240px;padding:28px 22px 64px}
nav{gap:6px;margin:0 0 24px;padding:5px;border:1px solid var(--line);border-radius:12px;background:#e9efec;box-shadow:0 4px 14px rgba(24,50,58,.04)}
nav button{border-color:transparent;background:transparent;color:var(--ink-soft);font-weight:650;padding:10px 16px}nav button:hover{border-color:transparent;background:#f8fbfa;color:var(--ink)}nav button[aria-selected=true]{background:var(--surface);color:var(--teal-dark);border-color:var(--line);box-shadow:0 2px 6px rgba(24,50,58,.08)}
.tab{animation:show-tab .18s ease-out}@keyframes show-tab{from{opacity:.35;transform:translateY(3px)}to{opacity:1;transform:none}}
.card{border-color:var(--line);border-radius:8px;padding:24px;margin-bottom:18px;box-shadow:var(--shadow)}.card>h2{color:var(--ink);letter-spacing:0}.card>h2:after{content:"";display:block;width:28px;height:3px;margin-top:10px;border-radius:99px;background:#4bb79d}
#overview,#accounts{display:grid;gap:18px;align-items:start}#overview{grid-template-columns:minmax(280px,.78fr) minmax(0,1.22fr)}#accounts{grid-template-columns:minmax(0,1.04fr) minmax(0,.96fr)}#overview>.card,#accounts>.card{margin-bottom:0}#models .card,#jobs .card{max-width:1120px}
.muted{color:var(--ink-soft)}p{line-height:1.7}.notice{border:1px solid #b8ded4;border-left:4px solid var(--teal);border-radius:10px;background:var(--teal-soft);box-shadow:0 5px 16px rgba(15,118,110,.06)}.notice.error{border-color:#ecc4c0;border-left-color:var(--red);background:#fff0ee}
.stats{gap:14px}.stat{border:1px solid var(--line);border-radius:8px;background:#f7faf8;padding:17px}.stat strong{color:var(--teal-dark);font-size:27px;letter-spacing:0}.stat span{color:var(--ink-soft)}
label{color:#36535a;font-size:13px;letter-spacing:0}input,select,textarea{border-color:#c8d8d4;border-radius:8px;padding:11px 12px;transition:border-color .15s,box-shadow .15s}input:focus,select:focus,textarea:focus{outline:0;border-color:#54aa98;box-shadow:0 0 0 3px rgba(75,183,157,.18)}
button{border-color:#c5d5d1;border-radius:9px;transition:background .15s,border-color .15s,transform .15s,box-shadow .15s}button:hover:not(:disabled){border-color:#70b7a5;box-shadow:0 3px 8px rgba(24,50,58,.08);transform:translateY(-1px)}button:focus-visible{outline:3px solid rgba(75,183,157,.35);outline-offset:2px}.primary{background:var(--teal);border-color:var(--teal)}.primary:hover:not(:disabled){background:var(--teal-dark);border-color:var(--teal-dark)}
.actions{margin-top:20px}.inline-field{display:flex;gap:8px}.inline-field input{min-width:0;flex:1}.inline-field button{white-space:nowrap;padding-inline:12px}.table-wrap{border:1px solid var(--line);border-radius:8px;background:#fff}table{font-size:13px}th,td{padding:13px 14px}th{background:#f6f9f7;color:#567078;font-size:12px;letter-spacing:0;text-transform:uppercase}tr:last-child td{border-bottom:0}td button{background:#fff}
pre{border:1px solid var(--line);background:#f6f9f7;border-radius:8px}.job-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:16px 0}.job-toolbar p{margin:0}.job-toolbar label{display:flex;align-items:center;gap:8px;white-space:nowrap}.job-toolbar select{width:auto;min-width:150px;padding:8px 10px}.status-stack{display:grid;gap:4px}.status-stack strong{font-size:13px}.status-stack small{color:var(--ink-soft)}.status-pill{display:inline-flex;align-items:center;width:max-content;padding:3px 8px;border-radius:999px;background:#edf2f0;color:#49636a;font-size:12px;font-weight:700}.status-pill.warning{background:#fff1d8;color:#8a5a13}.status-pill.danger{background:#ffe8e5;color:#9b342d}.status-pill.success{background:#e1f3eb;color:#176b57}#qr{width:272px;padding:12px;border:1px solid var(--line);border-radius:8px;background:#fff;box-shadow:0 8px 24px rgba(24,50,58,.08)}footer{color:#70848a;border-top:1px solid var(--line);padding-top:20px}
@media(max-width:820px){#overview,#accounts{grid-template-columns:1fr}#overview>.card,#accounts>.card{margin-bottom:0}}
@media(max-width:650px){header{padding:20px 16px}header>div{align-items:flex-start}.header-actions{gap:5px;align-self:flex-start;flex-wrap:wrap;justify-content:flex-end}header>div:before{width:34px;height:34px;border-radius:10px;font-size:16px}h1{font-size:19px}main{padding:20px 12px 48px}nav{overflow:auto;flex-wrap:nowrap}nav button{white-space:nowrap;padding:9px 13px}.card{padding:18px}.stats{gap:9px}.stat{padding:13px}.table-wrap{margin-left:-2px;margin-right:-2px}.job-toolbar{align-items:stretch;flex-direction:column;gap:10px}.job-toolbar label{justify-content:space-between}.job-toolbar select{flex:1}}
</style></head><body>
<header><div><h1>家庭 AI · 管理后台</h1><p>微信接入、模型配置与运行诊断</p></div><span class="header-actions"><button id="refresh">↻&nbsp; 刷新状态</button><button id="logout">退出登录</button></span></header>
<main><div id="message" class="notice" role="status" aria-live="polite" hidden></div>
<nav aria-label="管理导航"><button data-tab="overview" aria-selected="true">运行概览</button><button data-tab="models">模型设置</button><button data-tab="accounts">微信与权限</button><button data-tab="jobs">任务管理</button></nav>
<section id="overview" class="tab"><div class="card"><h2>开始使用</h2><p>① 配置模型并测试连接 → ② 扫码绑定微信 → ③ 按需授权管理员联系人。</p><p class="muted">后台已通过管理令牌认证。无需在浏览器保存 Key；查看模型设置时不会回显已有密钥。</p><button class="primary" id="start">配置模型</button></div><div class="card"><h2>运行状态</h2><div id="stats" class="stats"></div><p id="readiness" class="muted">加载中…</p><div id="alerts" class="notice" hidden></div><div id="polls" class="table-wrap"></div></div><div class="card"><h2>模型路由</h2><p class="muted">只显示聚合运行数据，不包含消息正文、会话或密钥。</p><div id="model-metrics" class="table-wrap"></div></div></section>
<section id="models" class="tab" hidden><div class="card"><h2>模型设置</h2><p class="muted">按角色分别配置。后台保存后优先于环境变量和微信内模型/供应商覆盖；重启保留。连接测试会发送一条小请求，可能消耗额度，仅检查 API，不检查 ACP 沙箱。</p>
<form id="model-form"><div class="grid"><div><label for="model-role">配置角色</label><select id="model-role"><option value="family">家庭用户 family</option><option value="admin">管理员 admin</option></select></div><div><label for="backend">执行方式</label><select id="backend"><option value="acp">ACP 工具模式（家庭普通聊天仍优先 API）</option><option value="api">纯 API 聊天（不执行工具任务）</option></select></div><div><label for="base-url">API 地址</label><div class="inline-field"><input id="base-url" type="url" required placeholder="https://api.openai.com/v1" maxlength="2048"><button type="button" id="list-models">获取模型</button></div></div><div><label for="api-key">API Key <small id="key-state"></small></label><input id="api-key" type="password" autocomplete="new-password" maxlength="8192" placeholder="首次填写；留空保留已有 Key"></div><div><label for="model-name">模型名称</label><input id="model-name" list="model-options" required maxlength="200" placeholder="供应商支持的模型 ID"><datalist id="model-options"></datalist></div><div><label for="wire-api">接口协议</label><select id="wire-api"><option value="auto">自动选择（推荐）</option><option value="responses">Responses API</option><option value="chat">Chat Completions</option></select></div><div><label for="reasoning">思考强度</label><select id="reasoning">${['none','minimal','low','medium','high','xhigh','max','ultra'].map(value => `<option value="${value}">${value}</option>`).join('')}</select></div></div><p class="muted">自动模式下 API 后端会按 Responses → Chat Completions 回退；ACP 自动模式使用其 provider 默认协议。</p><div class="actions"><button type="button" id="test-model">测试连接</button><button class="primary" type="submit">保存并生效</button><span id="model-source" class="muted"></span></div></form><p class="muted">正在执行任务时不允许修改，稍后重试。API Key 加密保存在数据卷；卷内加密密钥也需保护。后台管理员可设置自定义上游地址，请仅信任授权管理员。</p></div></section>
<section id="accounts" class="tab" hidden><div class="card"><h2>微信账号</h2><div class="actions"><select id="login-role" aria-label="新账号角色"><option value="family">家庭用户 family</option><option value="admin">管理员 admin</option></select><button class="primary" id="new-login">添加账号 / 获取二维码</button></div><div id="login-panel" hidden><img id="qr" alt="微信登录二维码"><p id="login-status" role="status"></p></div><div id="account-list" class="table-wrap"></div></div>
<div class="card"><h2>管理员联系人授权</h2><p class="muted">只有 admin 账号 + 已授权联系人同时满足，才获得管理员能力。先向机器人发送 /whoami 获取 ID，也可从最近联系人列表选择。</p><form id="grant-form"><div class="grid"><div><label for="grant-account">账号</label><select id="grant-account" required></select></div><div><label for="grant-contact">联系人 ID</label><input id="grant-contact" required></div></div><div class="actions"><button class="primary" type="submit">确认授权</button></div></form><h3>已授权</h3><div id="grants" class="table-wrap"></div><h3>最近联系人（最多 200 条）</h3><div id="contacts" class="table-wrap"></div></div></section>
<section id="jobs" class="tab" hidden><div class="card"><h2>任务管理</h2><div class="job-toolbar"><p class="muted">优先显示待人工检查任务。投递状态只表示服务端确认的发送结果，不代表用户已读。</p><label for="job-filter">筛选<select id="job-filter"><option value="all">全部任务</option><option value="needs_review">待人工检查</option><option value="running">执行中</option><option value="queued">排队中</option><option value="succeeded">已完成</option><option value="failed">已关闭</option></select></label></div><div id="job-list" class="table-wrap"></div><h3>任务详情</h3><pre id="job-detail">选择任务查看详情（不包含聊天正文和凭据）。</pre></div></section>
<footer>管理端默认仅允许本机访问。远程管理请使用 SSH 隧道或 HTTPS 反向代理，不要直接公开 HTTP 端口。管理会话 12 小时后过期，结束管理后请主动退出。</footer></main>
<script nonce="${nonce}">${ADMIN_SCRIPT}</script></body></html>`,
  };
}

const ADMIN_SCRIPT = String.raw`
'use strict';
const $ = id => document.getElementById(id);
let models = null, loginTimer = null;
function notice(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); $('message').hidden = false; }
async function api(url, body) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gateway-Request': 'dashboard' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || data.message || data.error || '请求失败');
  return data;
}
async function action(button, task) {
  button.disabled = true;
  try { await task(); } catch (error) { notice(error.message || '请求失败', true); }
  finally { button.disabled = false; }
}
function tab(id) {
  document.querySelectorAll('.tab').forEach(el => el.hidden = el.id !== id);
  document.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-selected', String(el.dataset.tab === id)));
  load(id).catch(error => notice(error.message, true));
}
document.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => tab(el.dataset.tab)));
$('start').onclick = () => tab('models');
function cell(value) { const el = document.createElement('td'); if (value instanceof Node) el.append(value); else el.textContent = value ?? '—'; return el; }
function button(text, task) { const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.onclick = () => action(el, task); return el; }
function table(id, headers, rows) {
  const target = $(id); target.replaceChildren();
  if (!rows.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '暂无数据'; target.append(p); return; }
  const table = document.createElement('table'), head = document.createElement('tr');
  headers.forEach(text => { const th = document.createElement('th'); th.textContent = text; head.append(th); }); table.append(head);
  rows.forEach(row => { const tr = document.createElement('tr'); row.forEach(value => tr.append(cell(value))); table.append(tr); }); target.append(table);
}
async function overview() {
  const data = await api('/api/status'), runtime = data.runtime;
  $('stats').replaceChildren();
  for (const [name, count] of [['排队中',data.jobs.counts.queued],['执行中',data.jobs.counts.running],['待检查',data.jobs.counts.needs_review],['已完成',data.jobs.counts.succeeded]]) {
    const box = document.createElement('div'); box.className = 'stat'; box.textContent = name;
    const number = document.createElement('strong'); number.textContent = count; box.append(number); $('stats').append(box);
  }
  $('readiness').textContent = (runtime?.ready ? '微信轮询正常。' : '微信轮询尚未就绪：请检查是否绑定账号、网络与账号状态。') + ' 此状态不代表模型或工具沙箱已验证。';
  const alerts = data.alerts || [];
  const alertNames = { queue_size_high: '任务队列积压', queue_wait_too_long: '任务等待时间过长', jobs_need_review: '有任务需要人工检查', account_poll_unhealthy: '微信账号轮询异常' };
  $('alerts').hidden = alerts.length === 0;
  $('alerts').textContent = alerts.length ? alerts.map(alert => (alertNames[alert.code] || '运行告警') + (alert.count ? '（' + alert.count + '）' : '')).join(' · ') : '';
  table('polls', ['账号','最近成功','连续失败'], (runtime?.accounts || []).map(a => [a.accountId, a.lastSuccessAt, a.consecutiveFailures]));
  const routeNames = { admin: '管理员', 'family-api': '家庭 API', 'family-acp': '家庭 ACP' };
  table('model-metrics', ['日期','路由','请求','成功','失败','平均耗时','最大耗时','Token'], (data.modelMetrics || []).map(metric => [
    metric.date, routeNames[metric.route] || metric.route, metric.requests, metric.successes, metric.failures,
    metric.average_duration_ms + ' ms', metric.max_duration_ms + ' ms',
    metric.usage_reported_requests ? metric.total_tokens : '未报告',
  ]));
}
function fillModel() {
  if (!models) return;
  const value = models.roles[$('model-role').value];
  $('base-url').value = value.baseUrl; $('model-name').value = value.model; $('reasoning').value = value.reasoningEffort;
  $('backend').value = value.backend === 'api' ? 'api' : 'acp'; $('wire-api').value = value.wireApi || 'auto'; $('api-key').value = '';
  $('model-options').replaceChildren();
  $('key-state').textContent = value.hasApiKey ? '（已有，不回显）' : '（尚未配置）';
  $('model-source').textContent = '当前来源：' + (value.source === 'dashboard' ? '后台持久配置' : '环境变量');
}
$('model-role').onchange = fillModel;
function modelBody() { return { role: $('model-role').value, baseUrl: $('base-url').value, apiKey: $('api-key').value,
  model: $('model-name').value, reasoningEffort: $('reasoning').value, backend: $('backend').value, wireApi: $('wire-api').value }; }
$('list-models').onclick = () => action($('list-models'), async () => {
  notice('正在获取模型列表…');
  const result = await api('/api/settings/models/list', { role: $('model-role').value, baseUrl: $('base-url').value, apiKey: $('api-key').value });
  const options = $('model-options'); options.replaceChildren();
  result.models.forEach(model => { const option = document.createElement('option'); option.value = model; options.append(option); });
  if (result.models.length && !result.models.includes($('model-name').value)) $('model-name').value = result.models[0];
  notice(result.detail, !result.ok);
});
$('test-model').onclick = () => action($('test-model'), async () => {
  if (!$('model-form').reportValidity()) return;
  notice('正在测试连接…'); const result = await api('/api/settings/models/test', modelBody()); notice(result.detail, !result.ok);
});
$('model-form').onsubmit = event => { event.preventDefault(); action(event.submitter, async () => {
  models = await api('/api/settings/models', modelBody()); fillModel(); notice('已保存并生效；重启后仍然保留。另一角色需要单独配置。');
}); };
async function accounts() {
  const [data, grants, contacts] = await Promise.all([api('/api/accounts'), api('/api/admin-contacts'), api('/api/contacts')]);
  const select = $('grant-account'), previous = select.value; select.replaceChildren();
  data.accounts.forEach(a => { const option = document.createElement('option'); option.value = a.id; option.textContent = a.id + ' (' + a.role + ')'; select.append(option); });
  if (data.accounts.some(a => a.id === previous)) select.value = previous;
  table('account-list', ['账号','角色','状态','操作'], data.accounts.map(a => [a.id, a.role, a.status, button('切换为 ' + (a.role === 'admin' ? 'family' : 'admin'), async () => {
    if (!confirm('确认修改账号角色？管理员仍需要联系人授权。')) return;
    await api('/api/accounts/' + encodeURIComponent(a.id) + '/role', { role: a.role === 'admin' ? 'family' : 'admin' }); await accounts();
  })]));
  table('grants', ['账号','联系人','操作'], grants.contacts.map(c => [c.wechat_account_id, c.contact_id, button('撤销', async () => {
    if (!confirm('确认撤销管理员权限？')) return;
    await api('/api/admin-contacts', { accountId: c.wechat_account_id, contactId: c.contact_id, allowed: false }); await accounts();
  })]));
  table('contacts', ['账号','联系人','最近联系','操作'], contacts.contacts.map(c => [c.wechat_account_id, c.contact_id, c.last_seen_at, button('填入授权表', async () => {
    $('grant-account').value = c.wechat_account_id; $('grant-contact').value = c.contact_id;
  })]));
}
$('grant-form').onsubmit = event => { event.preventDefault(); action(event.submitter, async () => {
  if (!confirm('确认授予该联系人管理员能力？可执行高权限工具操作。')) return;
  await api('/api/admin-contacts', { accountId: $('grant-account').value, contactId: $('grant-contact').value, allowed: true });
  notice('联系人已授权。'); await accounts();
}); };
$('new-login').onclick = () => action($('new-login'), async () => {
  clearTimeout(loginTimer); const { login } = await api('/api/logins', { role: $('login-role').value });
  $('login-panel').hidden = false;
  async function poll() {
    try {
      const data = await api('/api/logins/' + encodeURIComponent(login.id)); const current = data.login;
      $('login-status').textContent = '登录状态：' + current.status;
      if (['waiting','scanned'].includes(current.status)) {
        $('qr').src = '/api/logins/' + encodeURIComponent(login.id) + '/qrcode.png?t=' + Date.now(); loginTimer = setTimeout(poll, 3000);
      } else if (current.status === 'confirmed') { $('qr').removeAttribute('src'); notice('微信绑定成功；管理员账号还需要授权联系人。'); await accounts(); }
      else { notice('登录未完成，请重新获取二维码。', true); }
    } catch (error) { notice(error.message, true); }
  }
  await poll();
});
async function jobs() {
  const data = await api('/api/jobs');
  const statusNames = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '已关闭', needs_review: '待人工检查' };
  const phaseNames = { queued: '等待调度', processing: '准备中', executing: '执行中', delivering: '投递中' };
  const deliveryNames = { not_attempted: '尚未发送', sending: '发送中', accepted: '发送接口已接受', uncertain: '投递结果不确定', not_required: '无需发送' };
  const deliveryTone = { accepted: 'success', uncertain: 'danger', sending: 'warning' };
  const filter = $('job-filter').value;
  const statusPriority = { needs_review: 0, running: 1, queued: 2, succeeded: 3, failed: 4 };
  const jobsToShow = data.jobs
    .filter(job => filter === 'all' || job.status === filter)
    .sort((left, right) => (statusPriority[left.status] ?? 9) - (statusPriority[right.status] ?? 9) || Number(right.id) - Number(left.id));
  table('job-list', ['ID','执行状态','投递状态','账号','更新时间','操作'], jobsToShow.map(job => {
    const controls = document.createElement('div');
    controls.append(button('详情', async () => { $('job-detail').textContent = JSON.stringify((await api('/api/jobs/' + job.id)).job, null, 2); }));
    if (job.status === 'needs_review') controls.append(button('关闭', async () => {
      const note = prompt('确认已核实副作用后，填写关闭原因（不重跑）：'); if (!note) return;
      await api('/api/jobs/' + job.id + '/resolve', { action: 'dismiss', confirm: true, note }); notice('任务已关闭，不会重新执行。'); await jobs();
    }));
    const execution = document.createElement('div'); execution.className = 'status-stack';
    const executionStatus = document.createElement('span'); executionStatus.className = 'status-pill ' + (job.status === 'needs_review' ? 'danger' : job.status === 'succeeded' ? 'success' : ''); executionStatus.textContent = statusNames[job.status] || job.status; execution.append(executionStatus);
    const executionPhase = document.createElement('small'); executionPhase.textContent = phaseNames[job.phase] || job.phase; execution.append(executionPhase);
    const delivery = document.createElement('span'); delivery.className = 'status-pill ' + (deliveryTone[job.delivery_status] || ''); delivery.textContent = deliveryNames[job.delivery_status] || job.delivery_status || '未知';
    return [job.id, execution, delivery, job.wechat_account_id, job.updated_at, controls];
  }));
}
async function load(id) { if (id === 'overview') await overview(); if (id === 'models') { models = await api('/api/settings/models'); fillModel(); } if (id === 'accounts') await accounts(); if (id === 'jobs') await jobs(); }
$('refresh').onclick = () => action($('refresh'), () => load(document.querySelector('[aria-selected=true]').dataset.tab));
$('job-filter').onchange = () => jobs().catch(error => notice(error.message, true));
$('logout').onclick = () => action($('logout'), async () => { await api('/api/auth/logout', {}); location.assign('/admin/login'); });
overview().catch(error => notice(error.message, true));
`;
