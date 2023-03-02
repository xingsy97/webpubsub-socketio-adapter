import { WebPubSubServiceClient } from "@azure/web-pubsub";
import express from "express";
import { WebPubSubEventHandler } from "@azure/web-pubsub-express";
import { Server as HttpServer} from "http";
import WebSocket from "ws";
import * as core from "express-serve-static-core";
import * as net from "net";
import { AttachOptions, ServerOptions, Server as EioServer} from "G:\\engine.io";
import { Server as SioServer} from "socket.io";
import { Socket } from "engine.io";
import { v4 as uuidv4 } from 'uuid';
process.env.DEBUG = '*';

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
	cnt: number;

	constructor(serviceClient: WebPubSubServiceClient, connectionId: string) {
		super();
		this.serviceClient = serviceClient;
		this.connectionId = connectionId;
		this.cnt = 0;
	}

	// Override the send action of native WebSocket
	async send(packets: any, cb?: (err?: Error) => void) { 
		this.serviceClient.sendToConnection(this.connectionId, packets);
		if (cb) cb();
	}

	async sendText(data: string, cb?: (err?: Error) => void) { 
		console.log(`[Adapter][ConnectionContext] sendText ${data}`)
		await this.serviceClient.sendToConnection(this.connectionId, data, {contentType: "text/plain"});
		if (cb) cb();
	}

	destory = () => { };
}

// class VirtualNetSocket extends WebSocket.WebSocket {
class VirtualNetSocket extends net.Socket {
	server: ClientConnectionContext;
	readable: boolean;
	writable: boolean;
	cnt:number = 0;

	constructor(server: ClientConnectionContext) {
		super(null);
		this.server = server;
		(this as any).write = (payload: Buffer|string, cb?: (err?: Error) => void) => {
			this.cnt++;
			console.log(`---------- [Adapter][FakeNetSocket.write] id = ${this.cnt} ------------------------`);

			console.log('[Adapter][FakeNetSocket] payload=', payload, "type = ", typeof(payload));
			// let message = payload.toString();
			if (payload.toString().includes("HTTP/1.1 101 Switching Protocols")) {
				console.log("[Adapter][FakeNetSocket] HTTP 101");
				console.log('-------------------------------------------------');
				if (cb) cb();
				return true;
			}

			if (typeof(payload) === 'string') {
				this.server.sendText(payload, cb);
			}
			else {
				if (cb) cb();
				// this.server.send(payload);
			}
			console.log('-------------------------------------------------');
			return true;
		}
	}

	destroy = () => {}
	// write(payload: Buffer|string):boolean {
	// 	return this.write(payload);
	// }	
}

interface WebPubSubServerAdapterOptions {
	connectionString: string;
	hub: string;
	path: string;
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
	currentIdIdx: number = 0;
	adapterId: string = "";

	buildFakeWebsocketRequestFromService(req) {
		var fakeReq = {
			"method": "GET", // req.headers. // Runtime need further update, add METHOD into header
			"url": "/eventhandler/",  // need to update in runtime
			"headers": {},
			"_query": {"EIO":"4", "transport": "websocket"},
			"websocket": null,
			"statusCode": null,
			"statusMessage": null,
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
		this.adapterId = uuidv4();
		this.serviceClient = new WebPubSubServiceClient(
			options.connectionString,
			options.hub, 
			{ allowInsecureConnection: true }
		);

		this.eventHandler = new WebPubSubEventHandler(options.hub, {
			path: options.path,
			handleConnect: (req, res) => {
				console.log("[Adatper] handleConnect");
				let connectionId = req.context.connectionId;
				this.candidateIds.push(connectionId);
				let context = new ClientConnectionContext(this.serviceClient, connectionId)
				this.clientConnections.set(connectionId, context);
				
				var fakeReq = this.buildFakeWebsocketRequestFromService(req);
				var netSocket = new VirtualNetSocket(context);

				if (this.httpServer == null) throw("WebPubsubAdapterInternal: null httpServer when handleConnect");
				this.httpServer.emit("upgrade", fakeReq, netSocket, Buffer.from([]));
				// this.clientConnections.get(connectionId).send("hello");
				res.success({});
			},

			onConnected: async (req) => {
				console.log(
					`connectionId = ${req.context.connectionId} is connected with Web PubSub service`
				);
			},

			handleUserEvent: async (req, res) => {
				console.log("[Adapter][handleUserEvent]", req);
				let connectionId = req.context.connectionId;
				if (this.clientConnections.has(connectionId)) {	// ping pong error message
					var packet;
					switch (req.data[0]) {
						case "2":
							packet = {"type": "ping", "data": ""}; break;
						case "3":
							packet = {"type": "pong", "data": ""}; break;
						case "4":
							packet = {"type": "message", "data": ""}; break;
						default:
							packet = {"type": "error", "data": ""}; 
							console.log("[WebPuBsubServerAdapterInternal][handleUserEvent] Failed to parse request, req = ", req);
							break;
					}
					(this.sockets[req.context.connectionId] as any).onPacket(packet);
					// this.httpServer.emit("packet", packet);
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

	putSocketInfo = (socketId: string, socket: Socket) => { this.sockets[socketId] = socket; }

	getNextId = () => this.candidateIds[this.currentIdIdx++];

	getSubscriptionPath = async () => (await this.serviceClient.getClientAccessToken()).baseUrl;
}

class WebPubSubServerAdapter {
	eioOptions: AttachOptions & ServerOptions;
	constructor(options: WebPubSubServerAdapterOptions)
	{
		var proxyHandler = {
			construct: (target, args) =>
			{
				return new target(options, ...args);
			},
		}
		var proxy = new Proxy(WebPubSubServerAdapterInternal, proxyHandler);
		return proxy;
	}
}

/* 	
 In the design of Engine.IO package, the EIO server has its own middlewares rather than sharing with http server.
 And the entry of EIO middlewares is put in the first place when receiving HTTP request. Http server listeners is behind EIO middlewares
 
                           .-------------.   Yes
       a HTTP request ---> | check(req)? |  ------->  `handleRequest(req)` (Engine.IO middlewares)
                           .-------------.
						         |
                                 |     No
                                 ------------------>  HttpServer.listeners

	
  And the Engine.IO handshake behaviour is inside `handleRequest`
  Web PubSub handshake handler is inside its express middleware. So a temporary ExpressApp and HttpServer are created as bridges to pass Web PubSub handler into Engine.IO middlewares.
*/
function eioBuild(app: core.Express, eioServer: EioServer): HttpServer {	
	// Pass Web PubSub Express middlewares into Engine.IO middlewares
	let bridgeApp = express();
	bridgeApp.use((eioServer as any).ws.getMiddleware());
	const bridgeHttpServer = new HttpServer(bridgeApp);
	
	(eioServer as any).middlewares = bridgeHttpServer.listeners("request");	
	bridgeHttpServer.removeAllListeners("request");

	// Set negotiate handler for ExpressApp
	app.get('/negotiate', async (req, res) => {
		let id = req.query.id;
		if (!id) {
			res.status(400).send('missing user id');
			return;
		}
		let token = await (eioServer as any).ws.serviceClient.getClientAccessToken({ userId: id });
		res.setHeader("Access-Control-Allow-Origin", "*");
		console.log(token.url);
		res.json({url: token.url});
	});
	const httpServer = new HttpServer(app);
	(eioServer as any).ws.httpServer = httpServer;
	
	// In Engine.IO, method `init` is called both inside constructor [server.js:59] and `attach` [server.js:568] 
	// Without this line, `init` will be called twice and cause re-run of `eioServer.wsEngine(...)` 
	(eioServer as any).init = () => {};
	eioServer.attach(httpServer, { 
		// path: ((eioServer as any).ws as WebPubSubServerAdapter).eioOptions.path, 
		path: "/eventhandler",
		addTrailingSlash:false
	});

	eioServer.generateId = (req:any) => {
		var id = (eioServer as any).ws.getNextId();
		return id;
	}
	return httpServer;
}

function sioBuild(app: core.Express, sioServer: SioServer) {
	const eioServer = new EioServer((sioServer as any).opts);
	const httpServer = eioBuild(app, eioServer);
	sioServer.bind(eioServer as any);
	return httpServer;
}

export {WebPubSubServerAdapterOptions, WebPubSubServerAdapter, eioBuild, sioBuild};
