// Check HTTP liveness only; model/WeChat credentials and sandbox require doctor.
const http = require('node:http');
const request = http.get({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT || 18080),
  path: '/healthz',
  timeout: 3000,
}, response => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on('timeout', () => request.destroy(new Error('healthcheck timeout')));
request.on('error', () => { process.exitCode = 1; });
