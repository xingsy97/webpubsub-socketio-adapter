import { WebPubSubServiceClient } from "@azure/web-pubsub";
import { Server as HttpServer} from "http";
import { AttachOptions, ServerOptions, Server as EioServer} from "G:\\engine.io";
import { Server as SioServer} from "G:\\socket.io\\dist";
import { hookEioServer } from "./hook/eio-server-hook";
import { WebPubSubServerAdapterOptions } from "./common";
import { WebPubSubServerAdapter } from "./WebSocketServerAdapter";
import express from "express";
import * as core from "express-serve-static-core";

process.env.DEBUG = '*';

/**
 * In the design of Engine.IO package, the EIO server has its own middlewares rather than sharing with http server.
 * And EIO middlewares is put in the first place when receiving HTTP request. Http server listeners is behind EIO middlewares
 * 
 *                         .---------------.   Yes
 *     a HTTP request ---> |  check(req)?  | -------->  `handleRequest(req)` (pass into Engine.IO middlewares)
 *                         .---------------.
 * 									|
 *									|		No
 *									------------------>  HttpServer.listeners
 * 
 * And the Engine.IO handshake behaviour is inside `handleRequest`
 * Web PubSub handshake handler is inside its express middleware. So a temporary ExpressApp and HttpServer are created as bridges to pass Web PubSub handler into Engine.IO middlewares.
**/
class WebPubSubEioManager {
	public httpServer: HttpServer;
	public eioServer: EioServer;

	constructor(app: core.Express, opts: ServerOptions, wpsOptions: WebPubSubServerAdapterOptions) {
		let adapter = new WebPubSubServerAdapter(wpsOptions);
		let eioServer = new EioServer({...opts, wsEngine: adapter});

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