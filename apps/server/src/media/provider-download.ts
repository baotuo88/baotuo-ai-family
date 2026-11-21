import https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { ModelServiceError } from "../operations/model-failure.js";

const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.51.100.0", 24], ["203.0.113.0", 24], ["100.64.0.0", 10], ["198.18.0.0", 15],
  ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(network, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
export function isPublicMediaAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
/** Provider result URLs carry no API auth and cannot target internal services or rebind DNS. */
export async function downloadProviderImage(value: string, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
  let url = new URL(value);
  for (let redirect = 0; redirect <= 3; redirect++) {
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
      throw new ModelServiceError("invalid_response", "图片链接必须为公共 HTTPS 地址；也可以配置供应商返回 base64 图片。");
    }
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
    if (!addresses.length || addresses.some(item => !isPublicMediaAddress(item.address))) throw new ModelServiceError("invalid_response");
    signal.throwIfAborted();
    const address = addresses[0]!;
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = https.get(url, { signal, family: address.family,
        lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, resolve);
      request.once("error", reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
      response.resume();
      url = new URL(response.headers.location, url);
      continue;
    }
    if (response.statusCode !== 200) { response.destroy(); throw new ModelServiceError("invalid_response"); }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response) {
      total += chunk.length;
      if (total > maxBytes) { response.destroy(); throw new ModelServiceError("invalid_response", "生成图片超过允许大小，请降低尺寸后重试。"); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new ModelServiceError("invalid_response");
}
