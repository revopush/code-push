import superagent = require("superagent");
import { Agent } from "http";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { CodePushUnauthorizedError } from "../script/code-push-error"
import { CodePushError, Headers } from "../script/types";

interface JsonResponse {
    headers: Headers;
    body?: any;
}

class RequestManager {
    public static SERVER_URL = "https://api.appcenter.ms/v0.1";

    public static ERROR_GATEWAY_TIMEOUT = 504;  // Used if there is a network error
    public static ERROR_INTERNAL_SERVER = 500;
    public static ERROR_NOT_FOUND = 404;
    public static ERROR_CONFLICT = 409;         // Used if the resource already exists
    public static ERROR_UNAUTHORIZED = 401;

    private _accessKey: string;
    private _serverUrl: string;
    private _customHeaders: Headers;
    private _proxy: string;

    constructor(accessKey: string, customHeaders?: Headers, serverUrl?: string, proxy?: string) {
        if (!accessKey) throw new CodePushUnauthorizedError("A token must be specified.");

        this._accessKey = accessKey;
        this._customHeaders = customHeaders;
        this._serverUrl = serverUrl || RequestManager.SERVER_URL;
        this._proxy = proxy;
    }

    public get(endpoint: string, expectResponseBody: boolean = true): Promise<JsonResponse> {
        return this.makeApiRequest("get", endpoint, /*requestBody=*/ null, expectResponseBody, /*contentType=*/ null);
    }

    public post(endpoint: string, requestBody: string, expectResponseBody: boolean, contentType: string = "application/json;charset=UTF-8"): Promise<JsonResponse> {
        return this.makeApiRequest("post", endpoint, requestBody, expectResponseBody, contentType);
    }

    public patch(endpoint: string, requestBody: string, expectResponseBody: boolean = false, contentType: string = "application/json;charset=UTF-8"): Promise<JsonResponse> {
        return this.makeApiRequest("patch", endpoint, requestBody, expectResponseBody, contentType);
    }

    public del(endpoint: string, expectResponseBody: boolean = false): Promise<JsonResponse> {
        return this.makeApiRequest("del", endpoint, /*requestBody=*/ null, expectResponseBody, /*contentType=*/ null)
    }

    private makeApiRequest(method: string, endpoint: string, requestBody: string, expectResponseBody: boolean, contentType: string): Promise<JsonResponse> {
        return new Promise<any>((resolve, reject) => {
            var url: string = this._serverUrl + endpoint;
            var request: superagent.Request = (<any>superagent)[method](url);

            if (this._proxy) {
                try {
                    (<superagent.SuperAgentRequest>request).agent(RequestManager.createProxyAgent(this._proxy, url));
                } catch (err) {
                    reject(this.getCodePushError(err));
                    return;
                }
            }

            this.attachCredentials(request);

            if (requestBody) {
                if (contentType) {
                    request = request.set("Content-Type", contentType);
                }

                request = request.send(requestBody);
            }

            request.end((err: any, res: superagent.Response) => {
                if (err) {
                    reject(this.getCodePushError(err, res));
                    return;
                }

                try {
                    var body = JSON.parse(res.text);
                } catch (err) {
                }

                if (res.ok) {
                    if (expectResponseBody && !body) {
                        reject(<CodePushError>{ message: `Could not parse response: ${res.text}`, statusCode: RequestManager.ERROR_INTERNAL_SERVER });
                    } else {
                        resolve(<JsonResponse>{
                            headers: res.header,
                            body: body
                        });
                    }
                } else {
                    if (body) {
                        reject(<CodePushError>{ message: body.message, statusCode: this.getErrorStatus(err, res) });
                    } else {
                        reject(<CodePushError>{ message: res.text, statusCode: this.getErrorStatus(err, res) });
                    }
                }
            });
        })
    }

    // Picks the agent the same way proxy-agent did, minus PAC support: proxy-agent
    // pulled in pac-proxy-agent -> get-uri -> basic-ftp for every consumer.
    private static createProxyAgent(proxy: string, targetUrl: string): Agent {
        const proxyProtocol = new URL(proxy).protocol.replace(":", "");
        const secureEndpoint = new URL(targetUrl).protocol === "https:";

        switch (proxyProtocol) {
            case "http":
            case "https":
                return secureEndpoint ? new HttpsProxyAgent(proxy) : new HttpProxyAgent(proxy);
            case "socks":
            case "socks4":
            case "socks4a":
            case "socks5":
            case "socks5h":
                return new SocksProxyAgent(proxy);
            default:
                throw new Error(`Unsupported protocol for proxy URL: ${proxy}`);
        }
    }

    private getCodePushError(error: any, response?: superagent.Response): CodePushError {
        if (error.syscall === "getaddrinfo") {
            error.message = `Unable to connect to the CodePush server. Are you offline, or behind a firewall or proxy?\n(${error.message})`;
        }

        return {
            message: this.getErrorMessage(error, response),
            statusCode: this.getErrorStatus(error, response)
        };
    }

    private getErrorStatus(error: any, response?: superagent.Response): number {
        return (error && error.status) || (response && response.status) || RequestManager.ERROR_GATEWAY_TIMEOUT;
    }

    private getErrorMessage(error: Error, response?: superagent.Response): string {
        return response && response.body.message ? response.body.message : error.message;
    }

    private attachCredentials(request: superagent.Request): void {
        if (this._customHeaders) {
            for (var headerName in this._customHeaders) {
                request.set(headerName, this._customHeaders[headerName]);
            }
        }

        request.set("x-api-token", `${this._accessKey}`);
    }
}

export = RequestManager;
