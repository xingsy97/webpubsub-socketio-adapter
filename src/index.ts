import { WebPubSubServiceClient } from "@azure/web-pubsub";
import { WebPubSubEventHandler } from "@azure/web-pubsub-express";
import { Server as HttpServer } from "http";
import WebSocket from "ws";
import * as core from "express-serve-static-core";
import * as net from "net";
import { AttachOptions, ServerOptions, Server as EioServer} from "G:\\engine.io";
import { Server as SioServer} from "socket.io";
// import { WebSocket } from "./transports";
process.env.DEBUG = '*';

/**
 * a virtual WebSocket.Server without real server
 */
class VirtualWebSocketServer extends WebSocket.Server {
	protocol: string = "graphql-ws";
	readyState: number = WebSocket.OPEN;
	writable: boolean = false;

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

	sendText(data: string) { 
		console.log(`[Adapter][ConnectionContext] sendText ${data}`)
		this.serviceClient.sendToConnection(this.connectionId, data, {contentType: "text/plain"});
	}
}

class FakeSocket extends net.Socket {
	server: ClientConnectionContext;
	readable: boolean = true;
	writeable:boolean = true;
	cnt:number = 0;

	constructor(server: ClientConnectionContext) {
		super();
		this.server = server;
	}
	write(payload: any, ...args): boolean {
		this.cnt++;
		console.log(`---------- [Adapter][FakeSocket.write] id = ${this.cnt} ------------------------`);

		console.log('[Adapter][FakeSocket] payload=', payload, ' args=', args, "type = ", typeof(payload));
		// let message = payload.toString();
		if (payload.indexOf("HTTP/1.1 101 Switching Protocols") == 0) {
			console.log("[Adapter][FakeSocket] HTTP 101");
			console.log('-------------------------------------------------');
			return true;
		}

		if (typeof(payload) === 'string') {
			this.server.sendText(payload);
		}
		else {
			return true;
			this.server.send(payload);
		}
		console.log('-------------------------------------------------');
		return true;
	}

	destory() {

	}
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
	eventHandler: WebPubSubEventHandler;
	wpsOptions: WebPubSubServerAdapterOptions;
	httpServer: HttpServer = null;

	buildFakeWebsocketRequestFromService(req) {
		var fakeReq = {};
		fakeReq["url"] = "/eventhandler/";  // need to update runtime
		// fakeReq["_query"] = (req as any).query;
		fakeReq["_query"] = {"EIO":"4", "transport": "websocket"}
		// poll mode only
		// fakeReq["._query.j = ?
		fakeReq["websocket"] = null;
		fakeReq["method"] = "GET"; // req.headers. // Runtime need further update, add METHOD into header
		fakeReq["headers"] = {};
		fakeReq["statusCode"] = null;
		fakeReq["statusMessage"] = null;
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

		let handler = new WebPubSubEventHandler(options.hub, {
			path: options.path,
			handleConnect: (req, res) => {
				console.log("[Adatper] handleConnect");
				let connectionId = req.context.connectionId;
				let context = new ClientConnectionContext(this.serviceClient, connectionId)
				this.clientConnections.set(connectionId, context);
				
				var fakeReq = this.buildFakeWebsocketRequestFromService(req);
				var netSocket = new FakeSocket(context);

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
				console.log("[Adapter] handleUserEvent", req);
				let connectionId = req.context.connectionId;
				let conn = this.clientConnections.get(connectionId);
				// if (this.clientConnections.has(connectionId)) {
				//   switch (req.context.eventName) {
				//     case "eio-2": //ping
				//       this.message()
				//       break;
				//     case "eio-4": // message
				//       break;
				//     default:
				//       break;
				//   }
				// }
				// req.data = (req.data as string).replace('/client/hubs/sample_chat,', "");
				// console.log("AFTER req.data");
				conn.emit("data", req.data);
				return res.success();
			},

			onDisconnected: async (req) => {
				let connectionId = req.context.connectionId;
				if (this.clientConnections.has(connectionId)) {
					this.clientConnections.get(connectionId).readyState = WebSocket.CLOSED;
					this.clientConnections.delete(connectionId);
				}
			},
		});
		this.eventHandler = handler;
		this.wpsOptions = options;
	}

	installHTTPServer(httpServer: HttpServer) {
		this.httpServer = httpServer;
	}

	getMiddleware() {
		return this.eventHandler.getMiddleware()
	}

	async getSubscriptionPath() {
		let token = await this.serviceClient.getClientAccessToken();
		return token.baseUrl;
	}
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
			// get(target, prop, receiver) {
			//   if (prop === "eioOptions") {
			//     return {
			//       transports:['websocket', "polling"], 
			//       cors: {origin:"*"},
			//       wsEngine: WebPubSubServerAdapter,
			//       path: options.hub,
			//       addTrailingSlash: false
			//     }
			//   }
			//   var origin = Reflect.get(target, prop, receiver);
			//   if (typeof(origin) =="function") {
			//     var func = (...args) => {
			//       return origin.apply(this, target, args);
			//     }
			//     return func;
			//   }
			//   return origin;
			// },
		}
		var proxy = new Proxy(WebPubSubServerAdapterInternal, proxyHandler);
		return proxy;
	}
}

// function getEioOptions(
// 	wpsOptions: WebPubSubServerAdapterOptions, 
// 	httpServer: HttpServer, 
// 	expresApp: core.Express):AttachOptions & ServerOptions {
// 		const adapter = new WebPubSubServerAdapter(wpsOptions, httpServer, expresApp);
// 		return {
// 			transports:['websocket'], 
// 			// cors: {origin:'*', optionsSuccessStatus: 200},
// 			wsEngine: adapter,
// 			path: wpsOptions.path,
// 			addTrailingSlash: false,
// 		}
// 	}

function eioBuild(app: core.Express, eioServer: EioServer) {	
	app.use((eioServer as any).ws.getMiddleware());
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
	(eioServer as any).ws.installHTTPServer(httpServer);

	var http_listeners = httpServer.listeners("request").slice(0);
	(eioServer as any).middlewares = http_listeners;
	eioServer.attach(httpServer, {path:'/eventhandler/', addTrailingSlash:false})

	return httpServer;
}

function sioBuild(app: core.Express, sioServer: SioServer) {
	const eioServer = new EioServer((sioServer as any).opts);
	const httpServer = eioBuild(app, eioServer);
	sioServer.bind(eioServer as any);
	return httpServer;
}

export {WebPubSubServerAdapterOptions, WebPubSubServerAdapter, eioBuild, sioBuild};