import assert from "assert";
import * as http from "http";
import { AddressInfo } from "net";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

import RequestManager = require("../utils/request-manager");

function proxyAgentFor(proxy: string, targetUrl: string): any {
    return (<any>new RequestManager("dummyAccessKey", null, "http://localhost", proxy)).getProxyAgent(targetUrl);
}

describe("Request Manager proxy agents", () => {
    it("uses HttpProxyAgent for http targets and HttpsProxyAgent for https targets behind an http(s) proxy", () => {
        for (const proxy of ["http://proxy.local:8080", "https://proxy.local:8443"]) {
            assert(proxyAgentFor(proxy, "http://example.com/x") instanceof HttpProxyAgent);
            assert(proxyAgentFor(proxy, "https://example.com/x") instanceof HttpsProxyAgent);
        }
    });

    it("uses SocksProxyAgent for socks proxies", () => {
        for (const protocol of ["socks", "socks4", "socks4a", "socks5", "socks5h"]) {
            assert(proxyAgentFor(`${protocol}://proxy.local:1080`, "https://example.com/x") instanceof SocksProxyAgent);
        }
    });

    it("reuses the same agents across requests", () => {
        const manager: any = new RequestManager("dummyAccessKey", null, "http://localhost", "http://proxy.local:8080");
        assert.strictEqual(manager.getProxyAgent("https://example.com/a"), manager.getProxyAgent("https://example.com/b"));
    });

    it("rejects requests when the proxy protocol is unsupported", () => {
        const manager = new RequestManager("dummyAccessKey", null, "http://localhost", "pac+http://proxy.local/proxy.pac");
        return manager.get("/endpoint").then(
            () => assert.fail("Expected the request to be rejected"),
            (error: any) => assert(/Unsupported protocol for proxy URL/.test(error.message))
        );
    });

    it("does not leak proxy credentials in the unsupported protocol error", () => {
        const manager = new RequestManager("dummyAccessKey", null, "http://localhost", "pac+http://user:secret@proxy.local/proxy.pac");
        return manager.get("/endpoint").then(
            () => assert.fail("Expected the request to be rejected"),
            (error: any) => {
                assert(/Unsupported protocol for proxy URL/.test(error.message));
                assert(!/secret/.test(error.message), `Proxy password leaked: ${error.message}`);
            }
        );
    });

    it("re-picks the proxy agent when a redirect switches from http to https", () => {
        const connectTargets: string[] = [];
        // Plain-HTTP requests reach the proxy directly: redirect them to https.
        const proxy = http.createServer((req, res) => {
            res.writeHead(302, { Location: "https://redirected.invalid/target" });
            res.end();
        });
        // HTTPS requests tunnel via CONNECT: record the target, then drop the tunnel.
        proxy.on("connect", (req: http.IncomingMessage, socket: any) => {
            connectTargets.push(req.url);
            socket.destroy();
        });

        const closeProxy = () => new Promise<void>((resolve) => proxy.close(() => resolve()));

        return new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()))
            .then(() => {
                const proxyUrl = `http://127.0.0.1:${(<AddressInfo>proxy.address()).port}`;
                const manager = new RequestManager("dummyAccessKey", null, "http://origin.invalid", proxyUrl);
                return manager.get("/start").then(
                    () => assert.fail("Expected the tunnelled request to fail"),
                    () => { /* the proxy drops the tunnel */ }
                );
            })
            .then(() => assert.deepStrictEqual(connectTargets, ["redirected.invalid:443"]))
            .then(closeProxy, (err: any) => closeProxy().then(() => { throw err; }));
    });
});
