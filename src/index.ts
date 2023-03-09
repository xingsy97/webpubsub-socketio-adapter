import { WebPubSubServiceClient } from "@azure/web-pubsub";
import { ConnectRequest, WebPubSubEventHandler, WebPubSubEventHandlerOptions } from "@azure/web-pubsub-express";
import { Server as HttpServer} from "http";
import { AttachOptions, ServerOptions, Server as EioServer, Socket} from "G:\\engine.io";
import { Server as SioServer} from "G:\\socket.io\\dist";
import express from "express";
import WebSocket from "ws";
import * as core from "express-serve-static-core";
import * as net from "net";
import { hookEioServer } from "./hook/eio-server-hook";

process.env.DEBUG = '*';

interface WebPubSubServerAdapterOptions {
	connectionString: string;
	hub: string;
	path: string;
}

/**
 * a virtual WebSocket.Server without real server
 */
class VirtualWebSocketServer extends WebSocket.Server {
	readyState: number;
	writable: boolean;
	readable: boolean;

	constructor() {
		super({ port: undefined, noServer: true });
	}
}
 
/**
 * A logical ClientConnectionContext that stands for a GraphQL client connection, every connection has a unique `connectionId`
 * It overrides method `send` and send messages back to its connection through Azure Web PubSub using `WebPubSubServiceClient`
 */
class ClientConnectionContext extends VirtualWebSocketServer {
	serviceClient: WebPubSubServiceClient;
	connectionId: string;
	cnt: number = 0;

	constructor(serviceClient: WebPubSubServiceClient, connectionId: string) {
		super();
		this.serviceClient = serviceClient;
		this.connectionId = connectionId;
	}

	// Override the send action of native WebSocket
	async send(packet: any, cb?: (err?: Error) => void) { 
		this.serviceClient.sendToConnection(this.connectionId, packet);
		if (cb) cb();
	}

	async sendText(data: string, cb?: (err?: Error) => void) { 
		console.log(`[Adapter][ConnectionContext] sendText ${data}`)
		await this.serviceClient.sendToConnection(this.connectionId, data, {contentType: "text/plain"});
		if (cb) cb();
	}

	destory = () => { };
}

/**
 * A `WebPubSubServerAdapter` which replaces original `WebSocket.Server` to communicate between the GraphQL server and the Azure Web PubSub service
 * `clientConnections` records the mapping from the `connectionId` of each client to its corresponding logical `ClientConnectionContext`.
 */
class WebPubSubServerAdapterInternal extends VirtualWebSocketServer {
	serviceClient: WebPubSubServiceClient;
	clientConnections: Map<string, ClientConnectionContext> = new Map();
	sockets: Map<string, Socket> = new Map();
	eventHandler: WebPubSubEventHandler;
	wpsOptions: WebPubSubServerAdapterOptions;
	httpServer: HttpServer = null;
	candidateIds: Array<string> = new Array();
	connectRequests: Map<string, any> = new Map();
	currentIdIdx: number = 0;
	linkedEioServer: EioServer;

	buildFakeWebsocketRequestFromService(req: ConnectRequest) {
		var fakeReq = {
			"method": "GET", // req.headers. // Runtime need further update, add METHOD into header
			"url": "/eventhandler/",  // need to update in runtime
			"headers": {},
			"_query": {"EIO":"4", "transport": "websocket"},
			"websocket": null,
			"statusCode": null,
			"statusMessage": null,
			"connection":{}
			// _query: (req as any).query,
			// "._query": ? // poll mode only
		}
		for (let key in req.headers) {
			let _key = key.toLowerCase();
			fakeReq["headers"][_key] = _key == "upgrade" ? req.headers[key][0] : req.headers[key];
		}
		return fakeReq;
	}

	constructor(options: WebPubSubServerAdapterOptions) {
		super();
		this.serviceClient = new WebPubSubServiceClient(
			options.connectionString,
			options.hub, 
			{ allowInsecureConnection: true }
		);

		this.eventHandler = new WebPubSubEventHandler(options.hub, {
			path: options.path,
			handleConnect: (req, res) => {
				console.log("[Adatper][WebPubsubServerAdapter][handleConnect]");
				let connectionId = req.context.connectionId;
				this.candidateIds.push(connectionId);

				let context = new ClientConnectionContext(this.serviceClient, connectionId)
				this.clientConnections.set(connectionId, context);
				this.connectRequests.set(connectionId, req);

				if (this.httpServer == null) throw("WebPubsubAdapterInternal: null httpServer when handleConnect");
				
				console.log((this.linkedEioServer as any).clients);
				res.success({});
			},

			onConnected: async (req) => {
				console.log("[WebPubSubServerAdapterInternal][onConnected]")
				var connectionId = req.context.connectionId;
				console.log((this.linkedEioServer as any).clients);
				if (this.clientConnections.has(connectionId)) {
					var context = this.clientConnections.get(connectionId);
					var connectReq = this.connectRequests.get(connectionId);
					var fakeReq = this.buildFakeWebsocketRequestFromService(connectReq);
					fakeReq["webPubSubContext"] = context;
					this.httpServer.emit("upgrade", fakeReq, new net.Socket(), Buffer.from([]));
					console.log((this.linkedEioServer as any).clients);
					console.log(`connectionId = ${req.context.connectionId} is connected with Web PubSub service`);
				}
				else {
					console.log("[WebPubSubServerAdapterInternal][onConnected] Invalid connection id");
				}
			},

			handleUserEvent: async (req, res) => {
				console.log("[Adapter][handleUserEvent]", req);
				let connectionId = req.context.connectionId;
				if (this.clientConnections.has(connectionId)) {	// Handle 4 types of packet: ping pong message error
					var packet;
					switch (req.data[0]) {
						case "2": packet = {"type": "ping", "data": ""}; break;
						case "3": packet = {"type": "pong", "data": ""}; break;
						case "4": packet = {"type": "message", "data": (req.data as string).substring(1)}; break;
						default:
							packet = {"type": "error", "data": ""}; 
							console.log("[WebPuBsubServerAdapterInternal][handleUserEvent] Failed to parse request, req = ", req);
							break;
					}
					(this.linkedEioServer as any).clients[connectionId].onPacket(packet);
					return res.success();
				}
				else {
					return res.fail(401);
				}
			},

			onDisconnected: async (req) => {
				let connectionId = req.context.connectionId;
				if (this.clientConnections.has(connectionId)) {
					this.clientConnections.get(connectionId).readyState = WebSocket.CLOSED;
					this.clientConnections.delete(connectionId);
				}
			},
		});
		this.wpsOptions = options;
	}

	installHTTPServer = (httpServer: HttpServer)  => { this.httpServer = httpServer; }

	getMiddleware = () => this.eventHandler.getMiddleware();

	getNextId = () => this.candidateIds[this.currentIdIdx++];

	getSubscriptionPath = async () => (await this.serviceClient.getClientAccessToken()).baseUrl;
}

class WebPubSubServerAdapter {
	eioOptions: AttachOptions & ServerOptions;
	constructor(options: WebPubSubServerAdapterOptions) {
		var proxyHandler = {
			construct: (target, args) =>
			{
				return new target(options, ...args);
			},
		}
		return new Proxy(WebPubSubServerAdapterInternal, proxyHandler);
	}
}

/* 	
 In the design of Engine.IO package, the EIO server has its own middlewares rather than sharing with http server.
 And EIO middlewares is put in the first place when receiving HTTP request. Http server listeners is behind EIO middlewares
 
                           .-------------.   Yes
       a HTTP request ---> | check(req)? |  ------->  `handleRequest(req)` (Engine.IO middlewares)
                           .-------------.
						         |
                                 |     No
                                 ------------------>  HttpServer.listeners

	
  And the Engine.IO handshake behaviour is inside `handleRequest`
  Web PubSub handshake handler is inside its express middleware. So a temporary ExpressApp and HttpServer are created as bridges to pass Web PubSub handler into Engine.IO middlewares.
*/
// function eioBuild(app: core.Express, eioServer: EioServer, wpsOptions: WebPubSubServerAdapterOptions): HttpServer {
class WebPubSubEioManager {
	public httpServer: HttpServer;
	public eioServer: EioServer;

	constructor(app: core.Express, opts: ServerOptions, wpsOptions: WebPubSubServerAdapterOptions) {
		let adapter = new WebPubSubServerAdapter(wpsOptions);
		var eioServer = new EioServer({...opts, wsEngine: adapter});

		hookEioServer(eioServer);
		this.addWebPubSubMiddlewaresToEIO(eioServer);

		// Set negotiate handler for ExpressApp
		app.get('/negotiate', async (req, res) => {
			let id = req.query.id;
			if (!id) {
				res.status(400).send('missing user id');
				return;
			}
			/*
				tokenInfo = { 
					"token": "A.B.C", "baseUrl": "http://localhost/clients/engineio/hubs/{hub}", "url": "http://localhost/clients/engineio/hubs/{hub}?access_token=A.B.C",
					"eio": {
						"baseUrl": "http://localhost",
						"query": { "access_token": "A.B.C" }
					}
				}
			*/
			// TODO: getClientAccessToken is hard-encoded hoooked. Need soft hook
			let tokenInfo = await ((eioServer as any).ws.serviceClient as WebPubSubServiceClient).getClientAccessToken({ userId: id });
			let eioPath = `/clients/engineio/hubs/${wpsOptions.hub}`;
			tokenInfo["eio"] = {
				"baseUrl": tokenInfo.baseUrl.substring(0, tokenInfo.baseUrl.indexOf("/clients/engineio/hubs/")),
				"query": {"access_token": tokenInfo.token},
				"path": eioPath
			}
			res.setHeader("Access-Control-Allow-Origin", "*");
			console.log(tokenInfo);
			res.json(tokenInfo);
		});
		const httpServer = new HttpServer(app);
		(eioServer as any).ws.httpServer = httpServer;
		
		// In Engine.IO, method `init` is called both inside constructor [server.js:59] and `attach` [server.js:568] 
		// Without this line, `init` will be called twice and cause re-run of `eioServer.wsEngine(...)` 
		(eioServer as any).init = () => {};
		eioServer.attach(httpServer, { 
			path: wpsOptions.path,
			addTrailingSlash:false
		});

		(eioServer as any).ws.linkedEioServer = eioServer;

		this.httpServer = httpServer;
		this.eioServer = eioServer;
	}

	addWebPubSubMiddlewaresToEIO(eioServer: EioServer) {
		// Pass Web PubSub Express middlewares into Engine.IO middlewares
		let bridgeApp = express();
		bridgeApp.use((eioServer as any).ws.getMiddleware());
		const bridgeHttpServer = new HttpServer(bridgeApp);
		
		(eioServer as any).middlewares = bridgeHttpServer.listeners("request");	
		bridgeHttpServer.removeAllListeners("request");
	}
}

class WebPubSubSioManager{
	public sioServer: SioServer;
	private eioManager: WebPubSubEioManager;
	
	constructor(app: core.Express, wpsOptions: WebPubSubServerAdapterOptions, opts: ServerOptions & AttachOptions) {
		this.eioManager = new WebPubSubEioManager(app, opts, wpsOptions);
		this.sioServer = new SioServer(null, {...opts, path: wpsOptions.path});
		this.sioServer.bind(this.eioServer);
	}

	public get httpServer() : HttpServer { return this.eioManager.httpServer; }
	public get eioServer() : EioServer { return this.eioManager.eioServer; }
	
}

// function sioBuild(app: core.Express, sioServer: SioServer) {
// 	const eioServer = new EioServer((sioServer as any).opts);
// 	const httpServer = eioBuild(app, eioServer);
// 	if (1 < 2) {
// 		sioServer.bind(eioServer);
// 		eioServer.on("connection", (sioServer as any).onconnection.bind(sioServer));
// 		sioServer.engine = eioServer;
// 	}
// 	return httpServer;
// }

export {WebPubSubSioManager, WebPubSubEioManager};