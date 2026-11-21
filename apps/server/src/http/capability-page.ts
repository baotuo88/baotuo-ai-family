/** Static additions to the dashboard; data is rendered through DOM text nodes. */
export const CAPABILITY_PANELS = `
<section id="images" class="tab" hidden><div class="card"><h2>生图设置</h2><p class="muted">独立配置兼容 Images API 的接口。每次只生成一张图片；保存仅校验配置格式，不会提交付费请求。修改后，新任务使用新配置，已开始的任务按原配置完成。</p>
<form id="image-form"><div class="grid">
<div><label for="image-enabled">画图功能</label><select id="image-enabled"><option value="false">关闭</option><option value="true">开启</option></select></div>
<div><label for="image-url">API 地址</label><input id="image-url" type="url" required placeholder="https://供应商地址/v1" maxlength="2048"></div>
<div><label for="image-key">生图 API Key <small id="image-key-state"></small></label><input id="image-key" type="password" autocomplete="new-password" placeholder="留空保留已有 Key"></div>
<div><label for="image-model">生图模型 ID</label><input id="image-model" required maxlength="200" placeholder="填写供应商支持的图片模型"></div>
<div><label for="image-size">尺寸</label><input id="image-size" required placeholder="1024x1024 或 auto"></div>
<div><label for="image-quality">质量</label><select id="image-quality"><option>auto</option><option>low</option><option>medium</option><option>high</option><option>standard</option><option>hd</option></select></div>
<div><label for="image-format">响应格式</label><select id="image-format"><option value="b64_json">请求 base64（b64_json）</option><option value="auto">供应商默认（不发送 response_format）</option></select></div>
<div><label for="image-timeout">等待时间（秒）</label><input id="image-timeout" type="number" min="10" max="300" required></div>
<div><label for="image-limit">全站每日画图次数</label><input id="image-limit" type="number" min="1" max="10000" required></div>
<div><label for="image-concurrency">同时生成数量</label><input id="image-concurrency" type="number" min="1" max="4" required></div>
</div><p class="muted">Key 不会自动继承聊天配置。尺寸、质量需符合供应商要求；原生返回 base64 的接口可选择“供应商默认”。图片链接仅支持公共 HTTPS 地址。成员画图权限需要在“成员管理”中单独开启。</p><div class="actions"><button class="primary" type="submit">保存生图设置</button></div></form></div></section>
<section id="members" class="tab" hidden><div class="card"><h2>成员管理</h2><p class="muted">按微信账号和联系人分别设置。新成员默认允许聊天、关闭画图。额度按北京时间自然日统计，包含已提交但失败或结果不确定的请求，用于限制调用次数，不代表供应商账单。已授权且处于管理员模式的联系人不受成员额度限制，仍受全站生图上限约束。</p><div id="member-list" class="table-wrap"></div></div>
<div class="card"><h2>成员权限与每日额度</h2><form id="member-form"><div class="grid">
<div><label for="member-account">微信账号</label><select id="member-account" required></select></div><div><label for="member-contact">联系人 ID</label><input id="member-contact" required maxlength="256" placeholder="发送 /whoami 获取，或点击上方编辑"></div>
<div><label for="member-chat">聊天权限</label><select id="member-chat"><option value="true">允许</option><option value="false">关闭</option></select></div>
<div><label for="member-images">画图权限</label><select id="member-images"><option value="false">关闭</option><option value="true">允许</option></select></div>
<div><label for="member-chat-limit">每天聊天次数（0 表示不限）</label><input id="member-chat-limit" type="number" min="0" max="100000" value="0" required></div>
<div><label for="member-image-limit">每天画图次数</label><input id="member-image-limit" type="number" min="1" max="100000" value="3" required></div>
</div><div class="actions"><button type="submit" class="primary">保存成员设置</button></div></form></div></section>
<section id="works" class="tab" hidden><div class="card"><h2>图片作品</h2><p class="muted">生成状态与发送状态分开记录。发送接口接受不代表用户已读。补发会向原联系人发送已有图片，不会重新生成；发送结果不确定时，请先确认对方是否收到。服务重启后，中断的生成任务需要人工检查，不会自动再次扣费生成。</p><div id="media-list" class="table-wrap"></div></div></section>
<section id="diagnostics" class="tab" hidden><div class="card"><h2>调用诊断</h2><p class="muted">按微信回复中的诊断编号定位问题。此处仅记录分类与时间，不包含提示词、密钥或上游原始错误。</p><div id="diagnostic-list" class="table-wrap"></div></div></section>`;

export const CAPABILITY_SCRIPT = String.raw`
const failureNames = { not_configured: '尚未配置：检查对应角色或生图设置', authentication: '鉴权失败：检查 Key 和接口权限',
  quota_exceeded: '额度不足：检查成员上限、全站上限和供应商余额', rate_limited: '上游限流：稍后再试或降低并发',
  model_unavailable: '模型或接口不可用：核对模型 ID 与协议', timeout: '等待超时：检查上游结果后再处理', cancelled: '已停止：上游可能仍在处理',
  network: '连接失败：检查服务端网络与接口地址', invalid_response: '响应不可用：检查图片格式和大小',
  provider_error: '上游服务异常：检查供应商状态', permission: '权限不足：检查成员权限',
  interrupted_generation: '生成中断：需人工检查上游结果', delivery_uncertain: '发送结果不确定：确认接收后再补发', upload_failed: '图片上传失败：可补发已有作品' };
async function setup() {
  const data = await api('/api/setup');
  table('setup-list', ['用途','API 配置','当前配置 API 测试','操作'], ['family','admin'].map(role => {
    const value = data.roles?.[role];
    const checked = value?.check;
    return [role === 'family' ? '家庭聊天' : '管理员', value?.configured ? '已配置' : '待配置',
      checked ? (checked.ok ? '通过 · ' : '失败 · ' + (failureNames[checked.code] || '请检查配置') + ' · ') + checked.checkedAt : '未验证（改 Key、模型或协议后需重新测试）',
      button('配置 / 测试', async () => { tab('models'); $('model-role').value = role; fillModel(); })];
  }));
  $('setup-extra').textContent = '已绑定微信 ' + data.accounts.length + ' 个；管理员联系人授权 ' + data.adminContacts + ' 个。工具沙箱需通过实际受控任务单独验证。生图' + (data.images?.enabled ? '已开启，请检查成员权限。' : '尚未开启。');
}
$('copy-family').onclick = () => action($('copy-family'), async () => {
  if (!confirm('确认将已保存的管理员 API 地址、Key 和模型复制给家庭聊天？会覆盖家庭模型配置，家庭使用纯 API 模式；请确认供应商允许共享额度。')) return;
  models = await api('/api/settings/models/copy', { confirm: true }); $('model-role').value = 'family'; fillModel();
  notice('已复制为家庭聊天配置，请测试连接。');
});
async function images() {
  const data = await api('/api/settings/images');
  $('image-enabled').value = String(data.enabled); $('image-url').value = data.baseUrl; $('image-key').value = '';
  $('image-model').value = data.model; $('image-size').value = data.size; $('image-quality').value = data.quality;
  $('image-format').value = data.responseFormat; $('image-timeout').value = data.timeoutMs / 1000;
  $('image-limit').value = data.dailyLimit; $('image-concurrency').value = data.maxConcurrent;
  $('image-key-state').textContent = data.hasApiKey ? '（已有，不回显）' : '（尚未配置）';
}
$('image-form').onsubmit = event => { event.preventDefault(); action(event.submitter, async () => {
  await api('/api/settings/images', { enabled: $('image-enabled').value === 'true', baseUrl: $('image-url').value,
    apiKey: $('image-key').value, model: $('image-model').value, size: $('image-size').value, quality: $('image-quality').value,
    responseFormat: $('image-format').value, timeoutMs: Number($('image-timeout').value) * 1000,
    dailyLimit: Number($('image-limit').value), maxConcurrent: Number($('image-concurrency').value) });
  await images(); notice('生图配置已保存。为成员开启画图权限后，可在微信发送 /画图 提示词。');
}); };
async function members() {
  const [data, accounts] = await Promise.all([api('/api/members'), api('/api/accounts')]);
  const select = $('member-account'), previous = select.value; select.replaceChildren();
  accounts.accounts.forEach(a => { const option = document.createElement('option'); option.value = a.id; option.textContent = a.id; select.append(option); });
  if (accounts.accounts.some(a => a.id === previous)) select.value = previous;
  table('member-list', ['账号 / 联系人','聊天','画图','今日使用（聊天 / 画图）','操作'], data.members.map(m => [
    m.accountId + ' / ' + m.contactId, m.chatEnabled ? '允许 · ' + (m.dailyChatLimit || '不限') : '已关闭',
    m.imagesEnabled ? '允许 · ' + m.dailyImageLimit : '已关闭', m.chatUsed + ' / ' + m.imagesUsed,
    button('编辑', async () => { $('member-account').value = m.accountId; $('member-contact').value = m.contactId;
      $('member-chat').value = String(m.chatEnabled); $('member-images').value = String(m.imagesEnabled);
      $('member-chat-limit').value = m.dailyChatLimit; $('member-image-limit').value = m.dailyImageLimit;
      $('member-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('member-contact').focus(); })]));
}
$('member-form').onsubmit = event => { event.preventDefault(); action(event.submitter, async () => {
  await api('/api/members', { accountId: $('member-account').value, contactId: $('member-contact').value,
    chatEnabled: $('member-chat').value === 'true', imagesEnabled: $('member-images').value === 'true',
    dailyChatLimit: Number($('member-chat-limit').value), dailyImageLimit: Number($('member-image-limit').value) });
  notice('成员权限与额度已保存，对后续调用生效。'); await members();
}); };
async function works() {
  const data = await api('/api/media');
  const statuses = { queued: '排队中', generating: '生成中', generated: '已生成', failed: '失败', needs_review: '待人工检查' };
  const deliveries = { not_attempted: '尚未发送', sending: '发送中', accepted: '发送接口已接受', uncertain: '发送结果不确定' };
  table('media-list', ['作品 / 时间','接收人','生成','发送','说明','操作'], data.media.map(m => {
    const controls = document.createElement('div'); controls.className = 'actions';
    if (m.has_result) {
      const link = document.createElement('a'); link.href = '/api/media/' + encodeURIComponent(m.id) + '/content';
      link.target = '_blank'; link.rel = 'noopener'; link.textContent = '查看 / 保存图片'; controls.append(link);
      if (m.status === 'generated' && m.delivery_status !== 'sending') controls.append(button('补发', async () => {
        if (!confirm('确认向原联系人补发这张已有图片？如果此前已送达，对方会再次收到。不会重新生成。')) return;
        await api('/api/media/' + encodeURIComponent(m.id) + '/redeliver', { confirm: true }); notice('补发接口已接受。'); await works();
      }));
    }
    return [m.id + '\n' + m.created_at, m.account_id + ' / ' + m.contact_id, statuses[m.status] || m.status,
      deliveries[m.delivery_status] || m.delivery_status, failureNames[m.error_code] || (m.size_bytes ? Math.ceil(m.size_bytes / 1024) + ' KB' : '—'), controls];
  }));
}
async function diagnostics() {
  const data = await api('/api/diagnostics');
  table('diagnostic-list', ['诊断编号','角色','任务','问题与处理建议','时间'], data.diagnostics.map(d => [d.id, d.role, d.job_id, failureNames[d.code] || d.code, d.created_at]));
}
`;
