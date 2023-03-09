import { WebPubSubServiceClient } from "@azure/web-pubsub";
import { ConnectRequest, WebPubSubEventHandler} from "@azure/web-pubsub-express";
import { Server as HttpServer} from "http";
import { WebPubSubServerAdapterOptions } from "./common";
import { Server as EioServer, Socket} from "G:\\engine.io";
import WebSocket from "ws";
import * as net from "net";

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
 * A logical ClientConnectionContext that stands for a Engine.IO client connection, every connection has a unique `connectionId`
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
 * A `WebPubSubServerAdapter` replaces original WebSocket Server (`wsEngine`) inside each Engine.IO Server.
 * It communicates between the Engine.IO client and the Azure Web PubSub service
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

/**
 * Engine.IO Server constructor has an option `wsEngine`. This type of this option is a class rather than an instance
 * The server will construct its own WebSocket server by `this.ws = wsEngine(<Fix-Parameters-Inside-Engine.IO-Library>)`
 * To use our own customized parameter when instansize `wsEngine`, proxy is used here.
**/
class WebPubSubServerAdapter {
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

export { WebPubSubServerAdapter };