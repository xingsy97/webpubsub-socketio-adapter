process.env.DEBUG="*";
import express from "express";
import {Server as EioServer, Socket} from "G:/engine.io";
import {WebPubSubServerAdapter, eioBuild} from "../../index";
const wpsOptions = {
  hub: "eio_hub", 
  path: "/eventhandler/",
  connectionString: "Endpoint=http://localhost;Port=8080;AccessKey=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGH;Version=1.0;",
}

const app = express();

const adapter = new WebPubSubServerAdapter(wpsOptions);
const eioServer = new EioServer({transports:['websocket'], wsEngine: adapter, httpCompression:false, pingTimeout:1000000, pingInterval:1000});
const httpServer = eioBuild(app, eioServer);

eioServer.on("connection", socket => {
  console.log("[SIO Server][onConnect]");
  socket.send("[From Server] hello");
  setInterval(() => { console.log(socket.readyState); }, 10000);
});

httpServer.listen(3000);