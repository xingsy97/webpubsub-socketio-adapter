import { hookedTransportWebSocketSend } from "./eio-transport-hook";
import { Server as EioServer } from "G:\\engine.io";

function hookEioServer(eioServer: EioServer) {
	function hookTransportSend(eioServer: EioServer) {
		var nativeCreateTransport = (eioServer as any).createTransport;
		(eioServer as any).createTransport = (transportName, req) => {
			var hookedTransport = nativeCreateTransport(transportName, req);
			hookedTransport.webPubSubContext= req.webPubSubContext;
			hookedTransport.send = hookedTransportWebSocketSend;
			return hookedTransport;
		}
	}

	hookTransportSend(eioServer);
    
    eioServer.generateId = (req:any) => {
		var id = (eioServer as any).ws.getNextId();
		return id;
	}
}

export { hookEioServer};