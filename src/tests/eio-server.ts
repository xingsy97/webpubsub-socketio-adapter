process.env.DEBUG="*";
import express from "express";
import {Server as EioServer, Socket} from "G:/engine.io";
import {WebPubSubServerAdapter, eioBuild} from "../index";
const wpsOptions = {
  hub: "eio_hub", 
  path: "/eventhandler/",
  connectionString: "Endpoint=http://localhost;Port=8080;AccessKey=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGH;Version=1.0;",
}

const app = express();

const adapter = new WebPubSubServerAdapter(wpsOptions);
const eioServer = new EioServer({transports:['websocket'], wsEngine: adapter, httpCompression:false, pingTimeout:1000000, pingInterval:10000});
const httpServer = eioBuild(app, eioServer);

httpServer.listen(3000);

eioServer.on("connection", socket => {
  (socket.server.ws as any).putSocketInfo(socket.id, socket);

  console.log("[server] connection")
  socket.send("[From Server] hello");
  setInterval(() => { console.log(socket.readyState); }, 10000);
});