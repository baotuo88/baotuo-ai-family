import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import test from 'node:test';
import { AppDatabase } from '../dist/apps/server/storage/database.js';
import { usageDay } from '../dist/apps/server/storage/capabilities.js';
import { loadConfig } from '../dist/apps/server/config/load-config.js';
import { ModelSettingsStore } from '../dist/apps/server/settings/model-settings.js';
import { routeHttpRequest } from '../dist/apps/server/http/routes.js';
import { generateImage } from '../dist/apps/server/media/image-provider.js';
import { isPublicMediaAddress, downloadProviderImage } from '../dist/apps/server/media/provider-download.js';
import { ImageGenerationService, parseImagePrompt, resolveGeneratedFile } from '../dist/apps/server/media/image-service.js';

const require = createRequire(import.meta.url);
const factory = require.resolve('../dist/apps/server/codex/factory.js');
let backendCalls = 0;
require.cache[factory] = { id: factory, filename: factory, loaded: true, exports: {
  createCodexBackend: () => ({ dispose() {}, clearSession() {}, cancel() {}, async run() {
    backendCalls++; return { exitCode: 0, stdout: '聊天成功', stderr: '', timedOut: false };
  } }),
} };
const { WechatWorker } = require('../dist/apps/server/transport/ilink/worker.js');
const model = { baseUrl: 'https://model.invalid/v1', apiKey: 'chat-key-secret', model: 'chat-model', wireApi: 'chat', reasoningEffort: 'high', backend: 'api' };
const image = { enabled: true, baseUrl: 'https://image.invalid/v1', apiKey: 'image-key-secret', model: 'image-model',
  size: '1024x1024', quality: 'auto', responseFormat: 'b64_json', timeoutMs: 10000, maxConcurrent: 1, dailyLimit: 20 };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-capabilities-'));
  const config = loadConfig(); config.server.dataDir = root; config.server.adminToken = 'a'.repeat(40);
  config.codex.admin.workspace = path.join(root, 'admin'); config.codex.family.workspace = path.join(root, 'family');
  config.familyPolicy.allowFileSend = true; config.codex.family.backend = 'api';
  const database = new AppDatabase(path.join(root, 'gateway.sqlite')); database.initialize();
  database.saveAccount({ id: 'account', role: 'family', authToken: 'test-token', uin: 'owner' });
  const settings = new ModelSettingsStore(root, config);
  settings.save('family', model);
  const worker = new WechatWorker({ config, database, settings });
  const service = new ImageGenerationService({ config, database, settings });
  t.after(async () => { await worker.stop(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, config, database, settings, worker, service };
}
async function call(f, method, url, body, headers = {}) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  request.url = url; request.method = method;
  request.headers = { authorization: `Bearer ${'a'.repeat(40)}`, 'content-type': 'application/json', 'x-gateway-request': 'dashboard', ...headers };
  const response = { status: 200, headers: {}, body: '', setHeader(k,v) { this.headers[k] = v; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
  await routeHttpRequest({ ...f, request, response, loginManager: {}, startedAt: '',
    saveModelSettings: (role,value) => f.worker.saveModelSettings(role,value), redeliverMedia: id => f.worker.redeliverMedia(id) });
  return response;
}
function policy(f, contact = 'member', changes = {}) {
  f.database.capabilities.savePolicy('account', contact, { chatEnabled: true, imagesEnabled: true, dailyChatLimit: 2, dailyImageLimit: 2, ...changes });
}
function session(f, contact = 'member') {
  return f.database.saveSession({ id: `session-${contact}`, wechatAccountId: 'account', contactId: contact, role: 'family',
    status: 'active', summaryText: '', memoryJson: '{}', contextToken: 'latest-context', lastActiveAt: new Date().toISOString() });
}
function mockTransport(t, { failSend = false, generate } = {}) {
  let submissions = 0;
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) === image.baseUrl + '/images/generations') {
      submissions++;
      if (generate) return generate(url, options);
      return Response.json({ data: [{ b64_json: png.toString('base64') }] });
    }
    assert.match(String(url), /cdn\.invalid/);
    return new Response('', { status: 200, headers: { 'x-encrypted-param': 'encrypted-result' } });
  };
  t.after(() => { globalThis.fetch = original; });
  const client = { getConfig: async () => ({}), cdnBaseUrl: 'https://cdn.invalid', getUploadUrl: async body => {
    assert.equal(body.media_type, 1); return { upload_param: 'upload' };
  }, sendMessage: async body => { sent.push(body); if (failSend && body.msg.item_list[0].type === 2) throw new Error('network failure'); return { ret: 0 }; } };
  return { client, sent, submissions: () => submissions };
}
const hooks = { onDeliveryStart() {}, onDeliveryAccepted() {}, onDeliveryUncertain() {} };

test('image secrets persist independently and all role/image updates preserve each other', t => {
  const f = fixture(t);
  f.settings.saveImages(f.settings.prepareImages(image));
  f.settings.save('admin', { ...model, apiKey: 'admin-secret' });
  f.settings.save('family', { ...model, model: 'changed' });
  const restored = new ModelSettingsStore(f.root, f.config);
  assert.equal(restored.getImages().apiKey, image.apiKey);
  assert.equal(restored.get('admin').apiKey, 'admin-secret');
  assert.equal(restored.get('family').model, 'changed');
  assert.equal(restored.prepareImages({ ...image, apiKey: '' }).apiKey, image.apiKey);
  const bytes = fs.readFileSync(path.join(f.root, '.settings/models.enc'));
  for (const key of [image.apiKey, model.apiKey, 'admin-secret']) {
    assert.equal(bytes.includes(Buffer.from(key)), false);
    assert.equal(JSON.stringify(restored.imagesView()).includes(key), false);
  }
  assert.throws(() => restored.prepareImages({ ...image, apiKey: 'bad\nkey' }));
  assert.throws(() => restored.prepareImages({ ...image, dailyLimit: 0 }));
});

test('readiness checks apply only to the exact tested configuration and survive restart', async t => {
  const f = fixture(t);
  f.database.capabilities.recordCheck('family', f.settings.fingerprint('family'), true, null);
  let data = JSON.parse((await call(f,'GET','/api/setup')).body);
  assert.equal(data.roles.family.check.ok, true);
  assert.equal(data.roles.family.sandboxVerified, false);
  for (const change of [{ model: 'other' }, { apiKey: 'new-key' }, { wireApi: 'responses' }]) {
    f.settings.save('family', { ...model, ...change });
    data = JSON.parse((await call(f,'GET','/api/setup')).body);
    assert.equal(data.roles.family.check, null);
  }
  f.settings.save('family', model);
  assert.equal(f.database.capabilities.check('family', new ModelSettingsStore(f.root,f.config).fingerprint('family')).ok,true);
  f.database.capabilities.recordCheck('family',f.settings.fingerprint('family'),false,'authentication');
  data = JSON.parse((await call(f,'GET','/api/setup')).body);
  assert.equal(data.roles.family.check.code,'authentication');
  assert.ok(data.roles.family.check.checkedAt);
  assert.equal(JSON.stringify(data).includes(model.apiKey), false);
});

test('copying admin config requires explicit confirmation and does not grant tools or expose credentials', async t => {
  const f = fixture(t);
  f.settings.save('admin',{ ...model, backend: 'acp', apiKey: 'admin-secret' });
  assert.equal((await call(f,'POST','/api/settings/models/copy',{})).status,400);
  assert.equal((await call(f,'POST','/api/settings/models/copy',{confirm:true},{'x-gateway-request':''})).status,403);
  const result = await call(f,'POST','/api/settings/models/copy',{confirm:true});
  assert.equal(result.status,200);
  assert.equal(result.body.includes('admin-secret'),false);
  assert.equal(f.settings.get('family').backend,'api');
  assert.equal(f.settings.get('family').apiKey,'admin-secret');
  assert.equal(f.database.listAdminContacts().length,0);
  f.worker.activeTurns.set('busy', {});
  assert.equal((await call(f,'POST','/api/settings/models/copy',{confirm:true})).status,409);
  f.worker.activeTurns.clear();
});

test('new management routes require auth, JSON and custom header; permissions validate limits', async t => {
  const f = fixture(t);
  for (const url of ['/api/setup','/api/settings/images','/api/members','/api/media','/api/diagnostics', '/api/media/00000000-0000-0000-0000-000000000000/content']) {
    assert.equal((await call(f,'GET',url,undefined,{authorization:''})).status,401,url);
  }
  assert.equal((await call(f,'POST','/api/settings/images',image,{'x-gateway-request':''})).status,403);
  const saved = await call(f,'POST','/api/settings/images',image);
  assert.equal(saved.status,200); assert.equal(saved.body.includes(image.apiKey),false);
  const member = {accountId:'account',contactId:'member',chatEnabled:true,imagesEnabled:true,dailyChatLimit:5,dailyImageLimit:1};
  assert.equal((await call(f,'POST','/api/members',{...member,dailyImageLimit:0})).status,400);
  assert.equal((await call(f,'POST','/api/members',{...member,dailyChatLimit:0.5})).status,400);
  assert.equal((await call(f,'POST','/api/members',member)).status,200);
  assert.equal(JSON.parse((await call(f,'GET','/api/members')).body).members[0].dailyChatLimit,5);
  assert.equal(f.database.listAdminContacts().length,0);
});

test('daily usage is durable, idempotent, scoped by account/contact and reset on Shanghai day boundaries', t => {
  const f = fixture(t), cap = f.database.capabilities;
  assert.equal(usageDay(new Date('2026-11-20T15:59:59Z')),'2026-11-20');
  assert.equal(usageDay(new Date('2026-11-20T16:00:00Z')),'2026-11-21');
  policy(f);
  cap.reserve('account','member','chat','one'); cap.reserve('account','member','chat','one'); cap.reserve('account','member','chat','two');
  assert.equal(cap.used('account','member','chat'),2);
  assert.throws(() => cap.reserve('account','member','chat','three'),/次数已用完/);
  cap.reserve('other-account','member','chat','three'); cap.reserve('account','other-member','chat','three');
  assert.throws(() => cap.reserve('account','new-member','image','denied'),/权限/);
  cap.reserve('account','member','image','image-one',{globalImageLimit:1});
  assert.throws(() => cap.reserve('account','admin','image','image-two',{admin:true,globalImageLimit:1}),/全站/);
  const reopened = new AppDatabase(f.database.getFilePath()); reopened.initialize();
  assert.equal(reopened.capabilities.used('account','member','chat'),2);
  assert.throws(() => reopened.capabilities.reserve('account','member','chat','again'),/次数已用完/);
  reopened.close();
});

test('image provider submits exactly once, supports base64/default format and rejects unsafe or malformed responses', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(url,image.baseUrl + '/images/generations');
    const body = JSON.parse(options.body); assert.equal(body.n,1); assert.equal(body.model,image.model);
    assert.equal(options.headers.Authorization,'Bearer ' + image.apiKey);
    assert.equal(body.response_format, calls === 1 ? 'b64_json' : undefined);
    return Response.json({data:[{b64_json:png.toString('base64')}]});
  };
  assert.equal((await generateImage(image,'cat',new AbortController().signal,1000)).mimeType,'image/png');
  await generateImage({...image,responseFormat:'auto'},'cat',new AbortController().signal,1000);
  assert.equal(calls,2);
  for (const [status,code,expected] of [[401,'bad_key','authentication'],[429,'insufficient_quota','quota_exceeded'],[429,'rate_limit_exceeded','rate_limited'],[404,'model_not_found','model_unavailable']]) {
    calls = 0; globalThis.fetch = async () => { calls++; return Response.json({error:{code,message:image.apiKey}},{status}); };
    await assert.rejects(generateImage(image,'cat',new AbortController().signal,1000),error => error.code === expected && !error.message.includes(image.apiKey));
    assert.equal(calls,1);
  }
  for (const payload of [{data:[]},{data:[{b64_json:'not base64!'}]},{data:[{b64_json:Buffer.from('not an image').toString('base64')}]}]) {
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(generateImage(image,'cat',new AbortController().signal,1000),error => error.code === 'invalid_response');
  }
  globalThis.fetch = async () => Response.json({data:[{b64_json:png.toString('base64')}]});
  await assert.rejects(generateImage(image,'cat',new AbortController().signal,10),error => error.code === 'invalid_response');
  calls = 0; globalThis.fetch = async () => {calls++; throw new Error('network secret');};
  await assert.rejects(generateImage(image,'cat',new AbortController().signal,1000),error => error.code === 'network'); assert.equal(calls,1);
});

test('provider download rejects internal destinations and non-HTTPS before transferring bytes', async () => {
  for (const address of ['127.0.0.1','10.1.2.3','172.16.1.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','fc00::1','::ffff:127.0.0.1','2001:db8::1']) assert.equal(isPublicMediaAddress(address),false,address);
  assert.equal(isPublicMediaAddress('8.8.8.8'),true); assert.equal(isPublicMediaAddress('2606:4700:4700::1111'),true);
  for (const url of ['http://example.com/a.png','https://user:password@example.com/a.png','https://example.com:8443/a.png','https://127.0.0.1/a.png']) {
    await assert.rejects(downloadProviderImage(url,new AbortController().signal,1000));
  }
});

test('generated images are saved before delivery, survive send failure and redeliver without another generation', async t => {
  const f = fixture(t); policy(f); f.settings.saveImages(image); const s = session(f);
  const transport = mockTransport(t,{failSend:true});
  await assert.rejects(f.service.generate({prompt:'cat',session:s,sourceMessageId:'one',signal:new AbortController().signal,client:transport.client,...hooks}),/已生成并保留/);
  const media = f.database.capabilities.mediaForMessage('account','one');
  assert.equal(media.status,'generated'); assert.equal(media.delivery_status,'uncertain');
  assert.deepEqual(fs.readFileSync(resolveGeneratedFile(f.config,media)),png);
  assert.equal(transport.submissions(),1);
  const result = await call(f,'GET',`/api/media/${media.id}/content`);
  assert.equal(result.status,200); assert.deepEqual(result.body,png); assert.equal(result.headers['Cache-Control'],'no-store');
  assert.equal((await call(f,'POST',`/api/media/${media.id}/redeliver`,{})).status,400);
  assert.equal(JSON.stringify(f.database.capabilities.listMedia()).includes(media.local_path),false);
  const redelivered = [];
  const client = {...transport.client, sendMessage:async body => {redelivered.push(body);return {ret:0};}};
  await f.service.deliver({id:media.id,client,session:{...s,contextToken:'new-context'},signal:new AbortController().signal,...hooks});
  assert.equal(redelivered[0].msg.to_user_id,'member'); assert.equal(redelivered[0].msg.context_token,'new-context');
  assert.equal(redelivered[0].msg.item_list[0].type,2); assert.equal(transport.submissions(),1);
  assert.equal(f.database.capabilities.used('account','member','image'),1);
  await assert.rejects(f.service.generate({prompt:'cat',session:s,sourceMessageId:'one',signal:new AbortController().signal,client,...hooks}),/已提交过/);
  await assert.rejects(f.service.deliver({id:media.id,client,session:session(f,'other'),signal:new AbortController().signal,...hooks}),error => error.code === 'permission');
  policy(f,'member',{imagesEnabled:false});
  await assert.rejects(f.service.deliver({id:media.id,client,session:s,signal:new AbortController().signal,...hooks}),error => error.code === 'permission');
  fs.unlinkSync(resolveGeneratedFile(f.config, media));
  assert.equal((await call(f,'GET',`/api/media/${media.id}/content`)).status,410);
});

test('permissions block paid generation, cancellation is never retried and restart marks interrupted work', async t => {
  const f = fixture(t); f.settings.saveImages(image); const s = session(f);
  const transport = mockTransport(t,{generate:(_url,options) => new Promise((_resolve,reject) => options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))});
  const make = (sourceMessageId,controller = new AbortController()) => f.service.generate({prompt:'cat',session:s,sourceMessageId,signal:controller.signal,client:transport.client,...hooks});
  await assert.rejects(make('denied'),error=>error.code==='permission'); assert.equal(transport.submissions(),0);
  policy(f); const controller = new AbortController(); const pending = make('cancel',controller);
  for(let i=0;i<50 && transport.submissions()===0;i++) await new Promise(resolve=>setImmediate(resolve));
  controller.abort(); await assert.rejects(pending,error=>error.code==='cancelled');
  assert.equal(transport.submissions(),1);
  assert.equal(f.database.capabilities.mediaForMessage('account','cancel').status,'needs_review');
  const interrupted = f.database.capabilities.createMedia({accountId:'account',contactId:'member',sessionId:s.id,sourceMessageId:'restart',model:image.model});
  f.database.capabilities.updateMedia(interrupted.id,'generating'); f.database.capabilities.recoverMedia();
  assert.equal(f.database.capabilities.media(interrupted.id).status,'needs_review'); assert.equal(transport.submissions(),1);
});

test('real worker routes /画图 directly to image transport and enforces chat policies before backend calls', async t => {
  const f = fixture(t); f.settings.saveImages(image); policy(f); const transport = mockTransport(t); const before = backendCalls;
  const inbound = text => ({wechatAccountId:'account',contactId:'member',text,mediaSummary:'',attachments:[],contextToken:'context',receivedAt:new Date().toISOString(),sourceMessageId:text});
  await f.worker.handleInboundMessage(f.database.getAccountById('account'),transport.client,inbound('/画图 橘猫'));
  assert.equal(transport.submissions(),1); assert.equal(backendCalls,before); assert.equal(transport.sent[0].msg.item_list[0].type,2);
  policy(f,'member',{chatEnabled:false});
  await assert.rejects(f.worker.handleInboundMessage(f.database.getAccountById('account'),transport.client,inbound('hello')));
  assert.equal(backendCalls,before);
  assert.match(transport.sent.at(-1).msg.item_list[0].text_item.text,/权限/);
  await f.worker.handleInboundMessage(f.database.getAccountById('account'),transport.client,inbound('/whoami'));
  assert.equal(backendCalls,before);
  assert.equal(parseImagePrompt('/image orange cat'),'orange cat'); assert.equal(parseImagePrompt('/画图'), ''); assert.equal(parseImagePrompt('普通聊天'),undefined);
});

test('public result downloads pin DNS, strip auth and revalidate every redirect', async t => {
  const dns = require('node:dns/promises'), https = require('node:https');
  const { EventEmitter } = require('node:events');
  const oldLookup = dns.lookup, oldGet = https.get;
  t.after(() => { dns.lookup = oldLookup; https.get = oldGet; });
  let requests = 0;
  dns.lookup = async host => [{address:host === 'internal.invalid' ? '127.0.0.1' : '8.8.8.8',family:4}];
  https.get = (url,options,callback) => {
    requests++; assert.equal(options.headers,undefined); assert.equal(options.family,4);
    options.lookup(url.hostname,{},(error,address,family) => {assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
    const result = Readable.from([png]);
    result.statusCode = 302; result.headers = {location:'https://internal.invalid/result.png'};
    queueMicrotask(() => callback(result)); return new EventEmitter();
  };
  await assert.rejects(downloadProviderImage('https://public.invalid/image',new AbortController().signal,1000),e=>e.code==='invalid_response');
  assert.equal(requests,1);
  https.get = (_url,_options,callback) => {
    const result = Readable.from([png]); result.statusCode=200;result.headers={};
    queueMicrotask(() => callback(result));return new EventEmitter();
  };
  assert.deepEqual(await downloadProviderImage('https://public.invalid/image',new AbortController().signal,1000),png);
  await assert.rejects(downloadProviderImage('https://public.invalid/image',new AbortController().signal,10),e=>e.code==='invalid_response');
});

test('manual redelivery uses current account/session, blocks concurrent sends and preserves uncertainty in worker jobs', async t => {
  const f = fixture(t); policy(f); f.settings.saveImages(image);
  const transport = mockTransport(t, {failSend:true});
  const inbound = {wechatAccountId:'account',contactId:'member',text:'/image cat',mediaSummary:'',attachments:[],contextToken:'original',receivedAt:new Date().toISOString(),sourceMessageId:'job-image'};
  f.database.receiveInboundBatch('account','cursor',[inbound]);
  const job = f.database.listDispatchableJobs(1,false,[])[0]; f.database.claimInboundJob(job.id);
  await assert.rejects(f.worker.handleInboundMessage(f.database.getAccountById('account'),transport.client,inbound,job.id));
  assert.equal(f.database.getInboundJobDetail(job.id).delivery_status,'uncertain');
  const media = f.database.capabilities.mediaForMessage('account','job-image');
  const current = f.database.getSessionByPeer('account','member');
  f.database.saveSession({...current,contextToken:'newest-token'});
  const api = require('../dist/apps/server/transport/ilink/api-client.js').ILinkApiClient;
  const oldUpload = api.prototype.getUploadUrl, oldSend = api.prototype.sendMessage;
  t.after(()=>{api.prototype.getUploadUrl=oldUpload;api.prototype.sendMessage=oldSend;});
  let release; const gate = new Promise(resolve=>{release=resolve;}); t.after(()=>release());
  let started = false;
  api.prototype.getUploadUrl = async () => ({upload_param:'upload'});
  api.prototype.sendMessage = async body => {
    started=true;assert.equal(body.msg.context_token,'newest-token');assert.equal(body.msg.to_user_id,'member');await gate;return {ret:0};
  };
  // Actual CDN URL is configured on ILinkApiClient; it remains a mocked transport.
  f.config.wechat.cdnBaseUrl='https://cdn.invalid';
  const pending = call(f,'POST',`/api/media/${media.id}/redeliver`,{confirm:true});
  for(let i=0;i<100 && !started;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(started,true);
  assert.equal((await call(f,'POST',`/api/media/${media.id}/redeliver`,{confirm:true})).status,422);
  release(); assert.equal((await pending).status,200);
  assert.equal(transport.submissions(),1);
  f.database.updateAccountStatus('account','disabled');
  assert.equal((await call(f,'POST',`/api/media/${media.id}/redeliver`,{confirm:true})).status,422);
});

test('generated files remain confined after symlink changes and recover when DATA_DIR moves', async t => {
  const f=fixture(t);policy(f);f.settings.saveImages(image);const s=session(f);const transport=mockTransport(t);
  const media=await f.service.generate({prompt:'cat',session:s,sourceMessageId:'move',signal:new AbortController().signal,client:transport.client,...hooks});
  assert.equal(path.isAbsolute(media.local_path),false);
  const moved=path.join(f.root,'restored');fs.mkdirSync(moved);fs.cpSync(path.join(f.root,'outbox'),path.join(moved,'outbox'),{recursive:true});
  assert.deepEqual(fs.readFileSync(resolveGeneratedFile({...f.config,server:{...f.config.server,dataDir:moved}},media)),png);
  const file=resolveGeneratedFile(f.config,media);fs.unlinkSync(file);
  const outside=path.join(f.root,'outside.png');fs.writeFileSync(outside,png);fs.symlinkSync(outside,file);
  assert.equal(resolveGeneratedFile(f.config,media),undefined);
  assert.equal((await call(f,'GET',`/api/media/${media.id}/content`)).status,410);
});

test('image queue enforces concurrency and rechecks permission before submitting a queued request', async t => {
  const f=fixture(t);f.settings.saveImages(image);policy(f);policy(f,'other');
  let finish;const ready=new Promise(resolve=>{finish=resolve;});t.after(()=>finish());
  const transport=mockTransport(t,{generate:async()=>{await ready;return Response.json({data:[{b64_json:png.toString('base64')}]});}});
  const first=f.service.generate({prompt:'cat',session:session(f),sourceMessageId:'first',signal:new AbortController().signal,client:transport.client,...hooks});
  for(let i=0;i<50 && transport.submissions()===0;i++)await new Promise(resolve=>setImmediate(resolve));
  const second=f.service.generate({prompt:'dog',session:session(f,'other'),sourceMessageId:'second',signal:new AbortController().signal,client:transport.client,...hooks});
  const denied=assert.rejects(second,e=>e.code==='permission');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(transport.submissions(),1);
  policy(f,'other',{imagesEnabled:false});finish();await first;await denied;
  assert.equal(transport.submissions(),1);assert.equal(f.database.capabilities.used('account','other','image'),0);
});
